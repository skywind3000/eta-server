# eta-server technical spec

Eta template engine + Node.js built-in HTTP, a PHP-style dynamic page service: the file path is the route — point it at a document root and it serves every .eta script underneath; it also has a built-in CLI render mode (like `php script.php`). Single-file implementation, sole runtime dependency `eta`, published as an npm package with one-line `npx` startup.

## Architecture

```
CLI (parseArgs)
  ├─ no positional arg → startServer(root, port, host)   # HTTP mode, the only public startup API
  │    └─ http.createServer → handleRequest  # per request
  │         ├─ URL parsing / path normalization / traversal defense (request-scoped parsed
  │         │    passed layer by layer; ctx holds only immutable startup config, decision #14)
  │         ├─ template branch → renderTemplate(parsed, ...)
  │         │    ├─ readBody (64MB cap, drain then 413 when exceeded, decision #14)
  │         │    ├─ assemble bridge data (_GET/_POST/_SERVER/.../RESP/require)
  │         │    ├─ fs.readFileSync + eta.renderStringAsync()
  │         │    └─ assemble response headers (RESP records + session re-sign) → writeHead/end
  │         ├─ directory branch → 301 trailing slash → index.eta / index.html / index.htm
  │         │    (fallback candidates verified one by one, decision #12)
  │         └─ static branch → whitelist extension → GET/HEAD check → stream pipe
  └─ first positional arg → renderCli(script, args)   # CLI render mode (decision #11)
       ├─ script='-' reads source from stdin (base directory = cwd)
       ├─ bridge degraded (fixed _SERVER + argv, empty _GET/_POST/_SESSION etc.)
       └─ after renderStringAsync, write stdout per body priority; exceptions exit 1
```

Single file `eta-server.js` (~950 lines), sole runtime dependency `eta`.

## Key decisions

### Decision #1: `renderStringAsync` instead of Eta's file-loading API

Eta v3 instances have no `renderFile` (that was the v2 API), and `render` / `renderAsync`'s file resolution has absolute-path bugs (it concatenates the `views` prefix a second time; on Windows this was observed to throw `Could not find template: demo\demo\api.eta`). Therefore **the server reads the source file itself with `fs.readFileSync` and calls `renderStringAsync(src, data)`**:

- sidesteps all of Eta's file-resolution quirks;
- reading from disk per request makes mtime hot-reload work naturally (no need for eta's cache mechanism; `cache: false` is just insurance);
- `include("./header")` inside templates is still resolved by Eta (Eta v3's template function is named `include`, not v2's `includeFile`; since no filepath is passed when renderStringAsync compiles, paths resolve relative to `views` — the document root in HTTP mode, the script's directory / cwd in CLI mode, see decision #11). This differs from the "relative to the current template's directory" semantics common in template engines (see known limitations).

### Decision #2: Eta configuration

```js
new Eta({ views: root, cache: false, useWith: true, autoTrim: false })
```

- `useWith: true` — bare-name access to bridge variables inside templates (`_GET.name` instead of `it._GET.name`); the `it.` prefix form works too, maximizing the PHP feel;
- `autoTrim: false` — Eta by default swallows the newline adjacent to a tag (the `\n` after `<%= x %>\n` gets eaten); turned off per the "faithful to source" principle; text templates reproduce their source byte for byte in the response body;
- `cache: false` — combined with decision #1, every request recompiles. There is a performance cost for template-heavy sites; acceptable in trusted environments.

### Decision #3: `require` anchored at the template directory

Templates are not modules (`new Function` bodies), so by default there is no `require` / `import`. Injected into the bridge:

```js
require: createRequire(scriptAbs)
```

- relative specifiers resolve against the .eta file's directory;
- bare specifiers walk up the directory tree searching `node_modules`;
- consistent with Node's native behavior for "a .js file in the same directory";
- ESM static `import` syntax is unavailable (non-module scope); when needed, use the dynamic `await import()` form;
- **Templates can require `.ts` files**: Node 22.18+ built-in type stripping (no dependencies at all), hence "thin JS template shell + logic pushed down into .ts library files" is the recommended split; limitation: erasable syntax only (enum / namespace / parameter properties throw). The template code blocks themselves do not go through type stripping (they take the `new Function` compilation path), so `<% %>` blocks remain JS-only; `engines.node >= 22.18` exists precisely for this feature;
- **hot reload for require()'d local files** (decision #15): `createRequire` instances share Node's process-wide module cache, so without intervention a library edit would need a server restart — defeating decision #1's "edits take effect immediately" for the recommended thin-template + .ts split. Files under the document root are tracked by mtime and their cache entry is dropped when the file becomes newer; `node_modules` and out-of-root files stay cached; invalidation is shallow (see known limitations).

### Decision #4: `<%= %>` escapes by default (Eta native autoEscape)

`<%= %>` output goes through HTML escaping (`"` → `&quot;` etc.); use `<%~ %>` for raw output. This is the security-oriented default choice (as opposed to "raw output + manual escape"); templates emitting JSON/plain text should use `<%~ %>`. The bridge also provides an `escape()` function for explicit escaping.

### Decision #5: self-implemented session, zero dependencies

The signed-cookie scheme is fully self-implemented; no express-session:

- cookie name `etasess`, value = `base64url(payload) + '.' + base64url(HMAC-SHA256(secret, payload))`;
- payload = `{ d: session data, e: expiry timestamp }`; the timestamp is covered by the signature;
- signature comparison via `timingSafeEqual`, length mismatches rejected up front;
- sliding 30-minute timeout (`SESSION_TTL`); whenever the session is non-empty, each response re-signs and refreshes;
- empty session but the request carries the cookie → `Max-Age=0` clears it;
- key derivation (decision #17 design): a random 256-bit master secret is persisted at `~/.eta-server/session-secret` (mode 0600; on Windows the mode is a no-op and the profile directory's ACL applies) and the per-site key is `HMAC-SHA256(master, 'eta-server-session|' + realpath(root))` — the secret is created once and reused, sessions survive server restarts, and **different roots on the same machine get different keys** (decision #13). The old fingerprint seed mixed in every active NIC MAC, but `os.networkInterfaces()` reports only currently-active interfaces — starting/stopping WSL or VMware, a VPN connect or an unplugged cable changed the MAC set and silently invalidated every session; the persisted secret removes that failure mode entirely. If the home directory is not writable, the key falls back to a diskless fingerprint (`hostname|username|homedir`, deliberately WITHOUT MACs) with a stderr warning. **Strength boundary**: "tamper-proof" holds against the client side; on a shared host, another local user who can read the secret file can forge cookies (see known limitations);
- cookie attributes fixed at `Path=/; HttpOnly; SameSite=Lax`, no Max-Age (browser-session cookie).

### Decision #6: output model — respond only after rendering returns

Eta rendering is a pure function (returns a complete string), so there is inherently no headers-already-sent problem: `RESP.header()` / `status()` merely append to the `resp.headers` array; everything is assembled after rendering completes. Response body priority:

1. `resp.binary !== null` (`RESP.writeraw` was touched) → binary buffer, short-circuits text;
2. `resp.text !== null` (`RESP.json()` was called) → JSON string;
3. otherwise the rendered html.

`RESP.json()` does not stop rendering; scripts exit themselves with a top-level `return` (template code blocks live inside a function body, so `return` works; demo/api.eta does exactly this).

### Decision #7: routing and static file semantics

- Path normalization: `decodeURIComponent(pathname)` failure → 404; `\0` → 404; prefix check after `path.resolve(root, '.' + pathname)`, out of bounds → 404 (same response as "does not exist", fail-closed);
- PATH_INFO: `lower.indexOf('.eta/')` splits script from suffix (first hit wins); the suffix is passed via `_SERVER.PATH_INFO`;
- directories: missing trailing slash gets a 301 (`Location` preserves the query string), then `index.eta` (through the template pipeline) / `index.html` / `index.htm` in order;
- static whitelist in `STATIC_TYPES` (38 kinds: web / text / data / images / fonts / audio-video / wasm / archives; `.js`/`.mjs` are `text/javascript`); outside the whitelist is 404; existing but verb not GET/HEAD → 405 + `Allow: GET, HEAD` (whitelist takes precedence; 404 never leaks existence via 405);
- the server's own file (`SELF_PATH`) is 404 on hit, preventing source disclosure when the docroot happens to be the package directory. Matched via `isSelfPath()` against `realpathSync(SELF_PATH)` — covering 8.3 short names — and **case-insensitively on every platform** (decision #17): win32 NTFS, macOS APFS (default) and case-insensitive Linux mounts all open `ETA-SERVER.js` for `eta-server.js`, and none of their realpath implementations normalize case. Checked at three points: dispatcher fast path, template-branch realpath result, and static/directory-branch realpath result.
- **hidden-path convention** (decision #17, re-chosen in #18): segments starting with `.` and `node_modules` directories (matched case-insensitively) are never served — neither as templates nor static files nor directory indexes (fail-closed 404); `.well-known` is exempt (RFC 8615). Underscore prefixes stay PUBLIC (static exports from Next.js / Nuxt / Astro emit `_next/` etc.). Decision #9's library / config files belong behind dot names (`.lib/util.ts`, `.config.json`). Checked on the URL file part (PATH_INFO tails stay legal) and again on every realpath result (catching in-root symlinks targeting hidden names); every block logs one stderr line (decision #18);

### Decision #8: zero-dependency principle

HTTP via `node:http`, sessions via `node:crypto`, CLI parsing hand-written — no runtime dependencies beyond `eta`. Goals: fast `npx -y eta-server` cold start, small supply-chain surface, uncontroversial publishing.

### Decision #11: CLI render mode (php-style single-script rendering)

```
eta-server [options] script [args...]
  script    script path to render (any extension, like php foo.txt running as-is;
            missing file → error on stderr, exit 1); "-" reads source from stdin
  args...   everything after the script name is not parsed, passed through verbatim;
            the script reads them via _SERVER.argv, argv[0] = the script itself
            (matching PHP $argv)
```

- **Mode detection**: parseArgs enters CLI mode at the first non-option positional argument and breaks thereafter (arguments after the script name pass through verbatim even if they look like `-p` — argparse REMAINDER semantics); HTTP server mode only when there is no positional argument. Positional arguments may appear before or after `-r` / `-p` / `-H` (options consume their values as usual);
- **stdin rendering** (`script` = `-`): `fs.readFileSync(0)` reads all stdin bytes, decoded as UTF-8 (BOM tolerated, same as file loading; Node's readFileSync on fd 0 works for pipes / files / interactive terminals alike); `views` / include / require base = **cwd** (the only natural anchor when there is no script file); `_SERVER.SCRIPT_NAME` / `SCRIPT_FILENAME` = `'-'`, `SCRIPT_DIRNAME` = cwd, `argv[0]` = `'-'` (PHP CLI also uses `'-'` when reading stdin); the require anchor is `createRequire(path.join(cwd, 'stdin.js'))` (createRequire only uses the path shape as a resolution base; the file need not exist);
- **bridge degradation**: `_SERVER` fixed degraded values — REQUEST_METHOD=GET, QUERY_STRING/PATH_INFO/CONTENT_TYPE/CONTENT_LENGTH/REMOTE_ADDR/SERVER_NAME/SERVER_PORT empty strings, REQUEST_TIME / REQUEST_TIME_FLOAT at render start, argv passed through; **no** REQUEST_URI / DOCUMENT_ROOT / REQUEST_SCHEME / HTTP_* (CLI has no URL / root / scheme concepts; neither does PHP CLI); `_GET`/`_POST`/`_REQUEST`/`_COOKIE` empty objects, `_SESSION` empty object (writes are side-effect-free; CLI sends no cookies), `_BODY` empty Buffer, `_JSON` null;
- **RESP**: injected as usual; header/status/redirect/setcookie only record, no side effects (no response assembly after rendering returns); writeraw / json participate in body selection (priority same as HTTP: binary > text > rendered text) — they are output, not response control, and are unaffected by the no-op rule;
- **include / require base**: file rendering = the script's directory (the Eta instance `views` = that directory; require anchored at the script's absolute path, same rules as decision #3); stdin rendering = cwd;
- **output**: after successful rendering, write `process.stdout` per body priority (raw bytes, binary-safe). Render exceptions → stack to stderr, exit 1, zero stdout output (Eta's pure-function rendering inherently has no partial output, no extra defense needed); missing file → `eta-server: no such file: X`, exit 1;
- **no PHP exit() flush semantics**: Eta rendering is a pure function; output is produced in one shot only after rendering returns in full, with no way to flush mid-way; scripts stopping output early use top-level `return` (code blocks live inside a function body); forcing `process.exit(code)` discards all generated output and exits immediately (Node semantics, unguarded, unrecovered);
- **reads no configuration** (there is no configuration-file mechanism anyway); `-r` / `-p` / `-H` are silently accepted but have no effect in CLI mode (PHP-style leniency);
- `renderCli(script, args)` is also exported (module.exports) for tests / programmatic use.

### Decision #12: path hardening (realpath containment check + Windows special cases)

String prefix checks only block text-level traversal, not filesystem-level escapes, so a full hardening set was added:

- **realpath containment check**: after a stat hit, `fs.realpathSync` resolves the real location and checks inclusion against `realpathSync(root)` (computed once at startServer time, stored as `ctx.rootReal`); outside the container → 404. **Symlinks / Windows junctions inside root pointing outside are 404 across the board** (template branch and static/directory branch share the rule); links inside the container are served normally (extension judged by the realpath);
- **Windows reserved device names**: a path segment matching `^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$` (case-insensitive, with or without extension) → 404 (win32 only);
- **NTFS alternate data streams**: a path segment containing `:` (`foo.txt::$DATA` / `foo:bar`) → 404 (win32 only; `%3A` decoding hits the same rule);
- **trailing dot/space normalization**: Win32 file open silently drops trailing `.` / spaces (`demo.eta.` actually opens `demo.eta`), so before extension judgement the decoded pathname gets `replace(/[. ]+$/, '')`, keeping the extension decision consistent with actual filesystem behavior (not done on POSIX — a file with that literal name truly doesn't exist → 404);
- **duplicate slashes collapse with 308**: `//a///b` → 308 `/a/b` (`Location` preserves the query string). Checked first on the **raw URL** (`new URL('//a')` would misparse the leading `//` as protocol-relative host), then once more on the decoded pathname (covering `%2f`-encoded slashes);
- **index fallback candidates verified one by one** (review follow-up): the directory itself passes containment, but `index.eta` / `index.html` / `index.htm` inside it could be links pointing outside root, so each candidate goes through `realInside`; an escape means 404 (fail-closed, no fallback to the next candidate). Candidates additionally go through `isSelfPath` on their realpath (decision #15), and the static index Content-Type is judged by the candidate's realpath extension, matching the static main branch;
- **Location encoding**: when building Location from a decoded pathname (directory 301, decode-level 308), each segment gets `encodeURIComponent` (non-ASCII / spaces never written raw into headers); raw-URL-level 308 and the query string stay as-is;
- Windows `%5c` (backslash) becomes a path separator after decoding: after `path.resolve` normalization it proceeds through the text-level containment check and the realpath containment check; escapes are 404 as well, no extra branch (the impact is confined to in-container semantics; noted here for reference);
- existing rules unchanged: `\0` rejected, prefix check after `path.resolve(root, '.' + pathname)`, SELF_PATH blocked.

### Decision #13: session hardening (4KB cap + root mixed into the key + name exclusivity)

Three session robustness mechanisms:

- **4KB cap** (`SESSION_COOKIE_LIMIT = 4096`): on re-sign, the full Set-Cookie byte length is checked (`Buffer.byteLength`); over-cap → 500 (the error page contains the string "about 4KB"). Browsers silently drop oversized cookies; explicit failure is better;
- **root mixed into the key**: `deriveSecret(rootDir)` computes `HMAC-SHA256(master secret, 'eta-server-session|' + realpathSync(root))` (decision #17) — sites with different document roots on the same machine get different keys; site A's session cookie presented to site B fails verification and is treated as no session; CLI mode uses no session and doesn't participate; the function is exported for testing;
- **session cookie name exclusivity**: `RESP.setcookie('etasess', ...)` collides with the framework session name; that entry is dropped, never sent, and a warning goes to stderr (browser behavior with two same-name Set-Cookie entries is undefined); `RESP.header('Set-Cookie', ...)` the raw channel performs no name check (a raw escape hatch; trust the template author — same-name collision consequences are their problem).

### Decision #14: per-request state isolation (structural fix after review)

An external review empirically found and fixed three classes of issues:

- **`ctx.parsed` cross-request contamination** (most severe): the original implementation wrote the current request's URL parse results into the `ctx` shared by all requests, while `renderTemplate` read it only after `await readBody()` — any second request arriving between the two awaits would overwrite the first. Measured: under an 8MB concurrent POST probe, 71 of 80 requests had `_GET`/`QUERY_STRING` mixed up. Fix: **`ctx` keeps only immutable startup config** (root/rootReal/host/port/secret/eta); request-scoped data (`parsed`) is passed as a parameter layer by layer into `renderTemplate`; the `ctx.parsed` field is removed from the architecture diagram;
- **413 delivery semantics**: the original implementation called `req.destroy()` immediately on overrun, so the client only saw ECONNRESET and never the 413 (the PRD promise of "over-cap returns 413" was broken). Fix: after overrun, **keep draining** (discard subsequent chunks, bounded memory); the client gets a normal 413 once the upload finishes and the connection remains reusable (the body has been fully consumed); the cost is that the response arrives only after the upload completes (same as Werkzeug behavior);
- **prototype key pollution**: `_GET` / `_POST` / `_REQUEST` / `_COOKIE` / form parse results all use `Object.create(null)` (`?__proto__=x` / `?constructor=x` are just ordinary data keys with no effect on dict behavior).

A batch of small fixes landed together: `RESP.status()` stores the raw value without coercing (the old `Number(code) || 200` silently mapped `status('abc')`/`status(0)` to 200), validation moved earlier to right after rendering ends (invalid codes no longer waste a session re-sign); port argument validation tightened to integers in 1–65535 (previously `Number()` plus an emptiness check let floats/negatives/out-of-range through); the `error` listener in `startServer` is removed after listen succeeds (avoiding a later server-level error rejecting an already-settled Promise).

### Decision #15: second review fix batch (SELF_PATH case bypass, require hot-reload, and four more)

A second external review found six issues (three empirically reproduced); all fixed:

- **SELF_PATH self-protection bypassed by case variants (win32, security)**: the old check was a raw string comparison `target === SELF_PATH`; on the case-insensitive Windows file system a request for `/ETA-SERVER.js` skipped it while `stat`/`realpath` succeeded as usual — with the package directory as docroot the server's own source was downloadable (empirically: HTTP 200, full file). Fix: `isSelfPath()` compares against `realpathSync(SELF_PATH)` (8.3 short names expand through realpath) and case-insensitively (measured: Windows `realpathSync` does not normalize case, so a realpath-only comparison is insufficient; decision #17 later extended the comparison to ALL platforms — macOS APFS and case-insensitive Linux mounts share the same hole). Checked at four points: dispatcher fast path, template-branch realpath result, static/directory-branch realpath result, and **the directory index candidates** (an in-root `index.eta`/`index.html` symlink pointing at the self file passes the containment check — target is inside the root — so `isSelfPath` on the candidate's realpath is the only guard; follow-up review found this fourth entry empirically leaking);
- **require module cache broke the hot-reload promise (decision #1)**: `createRequire` instances share Node's process-wide module cache (empirically: two instances `require('eta')` return the same object), so edits to `require('./lib.ts')` needed a restart — exactly the code recommended by decision #9's split did not enjoy the flagship hot-reload feature. Fix: `makeDevRequire()` tracks mtimes for files under the docroot and drops the cache entry when the file becomes newer; `node_modules` and out-of-root files stay cached (reloading framework dependencies mid-flight is unsafe); invalidation is shallow (see known limitations);
- **`containsPath` false-positive on `..`-prefixed legal names**: `startsWith('..')` misread `path.relative`'s `'..b.eta'` result as an escape, permanently 404-ing legal `..b` files (fail-closed direction, no escape risk — but a functional bug). Fixed to a first-segment comparison (`rel.split(path.sep)[0] !== '..'`); real escapes still rejected (regression-tested);
- **hop-by-hop header injection**: `RESP.header()` accepted any name, so a template could set `Transfer-Encoding` next to the framework's `Content-Length` — the RFC 7230-forbidden CL+TE double header (request-smuggling surface). Response assembly now drops the eight hop-by-hop names (connection / keep-alive / proxy-authenticate / proxy-authorization / te / trailer / transfer-encoding / upgrade) with a stderr warning; `Content-Length` stays unconditionally framework-owned;
- **`Max-Age=NaN`**: `setcookie({maxage:'abc'})` wrote `Max-Age=NaN` into the cookie; non-finite maxage is now ignored;
- **`REQUEST_TIME` semantics**: previously sampled after the body read (a large POST shifted it far from the true request start, diverging from PHP). Now captured at dispatcher entry and threaded layer by layer into `buildServerEnv`;
- **crash guards + graceful shutdown (robustness)**: HTTP startup mode registers `uncaughtException` / `unhandledRejection` handlers (log and keep serving — a template's detached async bug no longer kills the whole dev server; the single-process approximation of PHP-FPM per-request isolation); `SIGTERM` shares `SIGINT`'s graceful shutdown handler (containers / CI / pm2);
- **test infrastructure**: the test port is overridable via `ETA_TEST_PORT` (parallel CI); new assertions cover all of the above (see Tests).

Four design-level findings from the same review are documented as known limitations rather than fixed: session key strength, concurrent session lost updates, synchronous FS on the hot path, no Range/ETag static serving (see below).

### Decision #16: access log (Common Log Format, `res.on('finish')` hook)

HTTP mode writes one access-log line per completed request, in NCSA / Apache Common Log Format with an elapsed-time suffix:

```
127.0.0.1 - - [19/Aug/2026:10:23:45 +0800] "GET /hello.eta HTTP/1.1" 200 89 6ms
```

- **Single hook point**: the line is emitted from the response `finish` event, registered once in the `createServer` wrapper — covering every dispatcher branch (template / static / redirect / error) without touching them. Connections destroyed before completion are not logged;
- **Byte count**: Node's `writeHead(code, headersObject)` headers are not visible to `getHeader()` afterwards, so the wrapper tracks `writeHead` calls and captures the `Content-Length` argument (the object-less 301 / 308 / 405 calls carry an empty body → 0);
- **Destination**: stderr by default (stdout stays clean in every mode); `--access-log <file>` appends to a file (write errors reported once, never crash the server); `--access-log -` writes to stdout; `--quiet` silences the access log entirely (takes precedence over `--access-log`). Runtime warnings and crash-guard stacks keep going to stderr regardless;
- **Format choice**: CLF keeps the log grep / awk / goaccess-compatible for PHP-ecosystem users; structured (JSON) output is not needed at the dev-server scale;
- **State model**: the destination is per server instance (stored on `ctx` at startServer time), NOT a process global (decision #17 fixed a module-level `logConfig` — a second `startServer({quiet:true})` in the same process used to silence the first instance's log; empirically reproduced), and it is immutable startup config, not per-request state — no conflict with decision #14. `startServer(root, port, host, options)` gained an optional fourth argument (`{ quiet, accessLog }`) so library users get the same controls; CLI mode ignores both flags (PHP-style leniency, same as `-r` / `-p` / `-H`).

### Decision #17: third review fix batch (header normalization, session reassignment, hidden paths, and eight more)

A third external review (external auditor with live probes) found twelve issues; all fixed or documented:

- **broken responses from case-sensitive header assembly (security/interop)**: template headers were collected into a plain object keyed by the ORIGINAL name, then the framework appended its own `Content-Type` / `Content-Length` — `RESP.header('content-type', ...)` / `RESP.header('content-length', ...)` in lowercase produced TWO Content-Type lines and a duplicate Content-Length, and undici rejected the response outright (`Parse Error: Duplicate Content-Length`). Decision #15's hop-by-hop filter had normalized names, but the framework-owned CL / default CT had not. Fix: assembly normalizes by lowercased name into a Map — template `Content-Length` is dropped with a stderr warning (the buffered-body model always computes the real length), `Content-Type` overrides the default case-insensitively, repeated names are last-write-wins EXCEPT the list-based `Link` / `WWW-Authenticate` / `Proxy-Authenticate`, which accumulate values (emitted as repeated lines, fixing the old "multi-value headers impossible" gap);
- **`_SESSION = {}` silently ignored (semantics)**: `useWith` compiles into `with(data)`, so a wholesale reassignment lands on `data._SESSION` while response assembly re-signed the pre-render capture — the PHP-canonical session clear (`$_SESSION = []`) had no effect, and the cookie kept being re-signed. Fix: after rendering, `data._SESSION` is read back (`null`/`undefined`/`false` = clear to `{}`, plain objects / arrays accepted, primitives ignored with a warning); empty result with a pre-existing cookie emits the `Max-Age=0` clear line as before;
- **server-side libraries and config downloadable (security)**: decision #9's architecture pushes logic into docroot library files, but the static whitelist happily served `/lib.js` / `/config.json` (empirically: DB passwords and API keys returned 200); PHP never emits `.php` source and this server had no deny mechanism at all. Fix: hidden-path convention — segments starting with `_` or `.`, plus `node_modules`, are 404 across every branch (checked on the URL file part, PATH_INFO tails exempt, and re-checked on every realpath result against the real root); the recommended layout is now `_lib/*.ts` / `_config.json`. **Decision #18 re-chose the marker**: the underscore prefix collided with mainstream build output (`_next/`, `_astro/`, `_nuxt/`, ...), so only dot-prefixed segments + `node_modules` (case-insensitive) remain private, `.well-known` is exempt, and server-side files move behind dot names (`.config.json`, `.lib/util.ts`);
- **SELF_PATH comparison was win32-only (security)**: the decision-#15 case-insensitive comparison sat behind `process.platform === 'win32'`, but macOS APFS (default) and case-insensitive Linux mounts share the exact same hole, and realpath normalizes case on none of them. Fix: the lowercase comparison is unconditional on all platforms;
- **session secret mixed in ALL active NIC MACs — extremely unstable (design)**: `os.networkInterfaces()` reports only active interfaces; one machine measured 9 MACs, mostly virtual adapters (WSL / VMware / VPN), so toggling any of them rotated the secret and silently invalidated every session (the spec's own "first NIC unstable, take all" argument pointed the wrong way). Fix: random 256-bit master secret persisted at `~/.eta-server/session-secret` (0600), per-site key = `HMAC-SHA256(master, root realpath)`; diskless fingerprint fallback (no MACs) when the home is not writable; sessions now also survive server restarts;
- **access-log destination was a module global (design)**: a second `startServer({quiet:true})` in the same process silenced the first instance's access log (empirically reproduced; `startServer` is a documented library API and the test suite itself starts a second instance). Fix: the destination lives on each instance's `ctx`;
- **`*.eta`-named directories made everything beneath them 404**: the PATH_INFO split ran before the file check, and a non-file stat in the script branch was a hard 404 — `GET /assets.eta/site.css` 404'd when `assets.eta` was a DIRECTORY. Fix: the script branch only fires when stat says file; otherwise the request falls through to the normal directory / static branch (the hidden-path re-check covers the full pathname there);
- **multipart POSTs "succeeded" with every parameter lost**: a plain `enctype="multipart/form-data"` form produced an empty `_POST` and no signal. Fix: a per-request stderr warning (`_FILES` parsing remains phase two; raw bytes stay in `_BODY`);
- **204 / 205 / 304 carried a Content-Length and residual body bytes** (template trailing newlines), violating RFC 7230/7231 and tripping strict proxies. Fix: those statuses strip the body, Content-Length and Content-Type entirely (Set-Cookie still flows — session clearing on a 204 DELETE works);
- **stat-then-stream static serving (TOCTOU)**: a file rewritten between the stat and the stream open produced a Content-Length / byte mismatch (truncated or hung response). Fix: `sendStatic` opens the fd first and fstats the SAME fd, streaming from it;
- **`.404.eta` custom error page convention (new feature; `_404.eta` until decision #18)**: with no rewrite layer and the server as its own front end, there was no escape hatch for 404s. When `.404.eta` exists in the docroot, every 404 renders it with a default status of 404 (the script may override); the hidden-path convention keeps the file itself unroutable (no recursion), and a broken / missing fallback degrades to the built-in page — never to a non-404;
- **small consistency fixes**: `_SERVER` now uses `Object.create(null)` like every other bridge dict (decision #14 parity); binding a non-loopback address prints a stderr warning (500 pages expose full stack traces and absolute paths); slow renders are not yet timed (see known limitations — a watchdog cannot interrupt synchronous template code, only document it).

The same review's two suspected-but-not-reproduced findings (CLF log injection via literal `"` in the request line; prototype pollution of `_GET`/`_POST`/`_REQUEST`/`_COOKIE`) were confirmed clean and need no changes.

### Decision #18: fourth review fix batch (hidden-convention re-choice, node_modules case leak, fd abort leak, and five more)

A fourth external review re-verified v0.3.0 point by point (all 14 previous fixes empirically confirmed), then found one new security hole introduced by decision #17, one design hazard, one resource leak, and five small issues; all fixed:

- **node_modules match was case-sensitive (security, introduced in #17)**: `isPrivateSegment` compared `seg === 'node_modules'` as a raw string, while the `_` / `.` rules were prefix checks (immune) — `GET /Node_Modules/pkg/package.json` returned 200 with the secret content (empirically reproduced), because `realpathSync` does not normalize case on win32 / APFS and both the URL-level and realpath-level checks were bypassed together: the exact same hole decision #15 fixed in `isSelfPath()`, reintroduced in the brand-new rule. Fix: `seg.toLowerCase() === 'node_modules'`. The `node_modules.` trailing-dot variant needs no handling (win32 does not strip trailing dots on directory segments — ENOENT);
- **hidden-path marker re-chosen: underscore dropped, dot + node_modules + `.well-known` + stderr log**: the `_` prefix collided with mainstream build output — `_next/` (Next.js static export), `_astro/`, `_nuxt/`, `_app/` (SvelteKit), `_static/` (Sphinx / Jekyll) all silently 404'd, so "drop an exported static site into the docroot" (the most common usage) failed with every asset missing and no diagnosable cause. The convention is now: dot-prefixed segments + `node_modules` (case-insensitive) are private; `.well-known` is exempt (RFC 8615: ACME challenges, `apple-app-site-association`); underscore names are public. Server-side files move behind dot names (`.config.json`, `.lib/util.ts` — `.ts` is outside the static whitelist anyway). Additionally every hidden-path 404 now logs `blocked by hidden-path convention: METHOD url` to stderr (review option 3), turning "why does this 404?" into a glance; the fallback page was renamed `_404.eta` → `.404.eta` accordingly (still unroutable by the dot rule). Consequence noted: decision #15's `containsPath` first-segment fix for `..b`-style names is no longer reachable through URL routing (dot prefixes are private) — the code stays, it now only guards realpath-level results;
- **static serving leaked the fd on client abort**: `readable.pipe(dest)` only UNPIPES when dest is destroyed — the source stream never ends and `autoClose` never fires, so the fd opened by `sendStatic` stayed open (empirically: opens=1 closes=0 after a 20KB-then-abort download of a 3MB file; present since v0.2.0, but the fd is our own `openSync` now, so the responsibility is explicit). Fix: `res.on('close', () => stream.destroy())` — destroying the stream triggers autoClose; a no-op on normal completion. Regression test counts `fs.close` calls around an aborted in-process download;
- **lookup tables kept Object.prototype**: `HOP_BY_HOP_HEADERS` / `MULTI_VALUE_HEADERS` (and `STATIC_TYPES`, unreachable but for consistency) were plain literals — `RESP.header('constructor', 'x')` hit the inherited member and was dropped as "hop-by-hop" with a misleading warning (empirically reproduced). All three are now null-prototype dicts (decision #14 parity); the request-side dictionaries already were;
- **1xx statuses broke the assembly**: `RESP.status(100)` emitted `100 Continue` with a Content-Type and a FAKE Content-Length (Node drops the body itself, but the framework had already written the number). Fix: the status validation now rejects the whole 1xx class — the buffered-body model has no meaningful interim response; valid range is integers 200–999;
- **`_SERVER.QUERY_STRING` undefined on early-404 branches**: the NUL-byte and win32 device-name 404 paths ran before `parsed.queryString` was assigned, so a `_404.eta` fallback saw `undefined` — and string operations on it threw, which `plain404OnError` silently degraded to the built-in page (a swallowed template bug). Fix: the assignment moved directly after URL parsing; the degradation now also logs the fallback crash to stderr instead of swallowing it;
- **access-log file streams had no lifecycle**: a `startServer()` that rejected (EADDRINUSE) left the `--access-log` write stream open and never closed, and `server.close()` did not release it either — repeated library-mode start/stop accumulated handles. Fix: file-stream destinations are released on both the listen-failure path and the server `close` event (stdout / stderr destinations are shared process streams and never closed here);
- **spec known-limitations deduplicated**: the single-threaded entry and the repeated-header entry had been listed twice (different wordings, same content), and the multipart-warning note hung on three bullets; consolidated to one each.

The review also re-verified every v0.3.0 fix empirically (duplicate CL/CT gone, `_SESSION = {}` clears with `Max-Age=0`, platform-independent self-protection, persisted session secret, per-instance access log, `*.eta` directories, bodyless 204/304, fd-based static, `_404`-style fallback, multipart warning, null-proto `_SERVER`, non-loopback warning) — no regressions.

**Post-release amendment (fifth review, v0.3.2)**: the "broken fallback degrades to the built-in page — never to a non-404" promise had two more holes after rendering — an invalid `RESP.status()` (status validation) and an oversized session (>4KB cookie limit) both returned 500 from a `.404.eta` page (empirically reproduced). Both `sendError(500)` sites now honor `plain404OnError`: log one stderr line and emit the built-in 404, same as the render-exception path. Cosmetic consistency fix alongside: the `.well-known` exemption now folds case like the `node_modules` match next to it (direction stays fail-closed — ACME only uses lowercase).

### Decision #19: sixth review — header validation moved to record time

The fifth-review audit of "what else can escape `plain404OnError`" found a third hole in the same family, this one in `res.writeHead()` itself, affecting normal pages too: illegal header names / values were only validated by Node at the final `res.writeHead(resp.code, headers)` — a line with no try/catch — so the exception escaped to the dispatcher catch-all. Two consequences (both empirically reproduced): `.404.eta` pages returned 500 (the "never to a non-404" promise broken again), and — since `writeHead` assigns `statusCode` / `statusMessage` BEFORE validating headers — the first attempt's reason phrase survived into the retry, emitting `HTTP/1.1 500 OK` / `500 Found` / `500 Not Found` status lines (wrong error type + counter-intuitive status line; NOT a security issue — Node's `validateHeaderValue` rejects newline values outright, so no CRLF injection; the reachable channels were four: `RESP.header` name, `RESP.header` value, `RESP.setcookie` option strings inside the assembled Set-Cookie, `RESP.redirect` URL inside Location).

Fix (following the review's suggestion): validation moved to record time using Node's own public validators (zero dependencies):

- `RESP.header()` calls `http.validateHeaderName()` + `http.validateHeaderValue()` immediately; `RESP.redirect()` routes its Location through `resp.header()`; `RESP.setcookie()` validates the fully assembled Set-Cookie string through `validateHeaderValue`. Invalid input now throws during rendering and lands in the render-exception branch: normal pages get a 500 whose stack points at the offending template line (better to debug than the old opaque 500), and `.404.eta` pages degrade cleanly to the built-in 404 via `plain404OnError` — all three holes sealed at once;
- belt-and-suspenders: the final `writeHead` / `end` pair in both the bodyless and normal paths is wrapped in try/catch — any header that still fails validation degrades through the same rules (fallback → 404 + stderr, normal → 500), and `res.statusMessage` is reset before the retry so a mismatched status line can never be emitted;
- regression tests: four channels on a normal page assert 500 + `Internal Server Error` reason phrase + error page body (plus the untouched happy path), and the `.404.eta` fixture gained two header-breaking conditions asserting the degraded 404.

## Bridge API list

| Name | Type | Description |
|---|---|---|
| `_GET` / `_POST` / `_REQUEST` | object | query / form-urlencoded / merged (later wins) |
| `_SERVER` | object | see below |
| `_COOKIE` | object | cookie dict after percent-decode |
| `_SESSION` | object | signed-cookie session (decision #5); whole cookie over 4KB → 500 (decision #13); wholesale reassignment (`_SESSION = {}` / `null`) clears the session, read back after rendering (decision #17) |
| `_BODY` | Buffer | raw request body (counterpart of `php://input`) |
| `_JSON` | object/null | auto-parsed when Content-Type contains the `json` substring (covers `application/json`, `application/*+json`, `text/json`); parse failure / non-json → null |
| `RESP` | object | `status/header/redirect/setcookie/json/writeraw/escape` (status stores raw value, validated after rendering: not an integer in 200–999 → 500 — the 1xx class is rejected too, decisions #14/#18; setcookie colliding with the session name → dropped, decision #13; hop-by-hop header names dropped with a warning, decision #15; header names normalized case-insensitively — Content-Length dropped with a warning, list-based names accumulate, others last-write-wins, decision #17; header names/values validated at record time with Node's rules — invalid input is a render-time error, never a late writeHead failure, decision #19) |
| `escape(v)` | function | HTML escape (`& < > " '`), returns a string; `RESP.escape` is the same function |
| `require(spec)` | function | Node require anchored at the template directory (decision #3); local files under the docroot hot-invalidate on mtime change (decision #15) |

`_SERVER` keys: `REQUEST_METHOD`, `QUERY_STRING` (raw request-line slice, encoded original text), `REQUEST_URI` (req.url original), `SCRIPT_NAME`, `PATH_INFO`, `SCRIPT_FILENAME`, `SCRIPT_DIRNAME`, `DOCUMENT_ROOT`, `REMOTE_ADDR`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `SERVER_NAME`, `SERVER_PORT`, `REQUEST_SCHEME` (always `http`), `SERVER_PROTOCOL` (`HTTP/` + req.httpVersion), `REQUEST_TIME` / `REQUEST_TIME_FLOAT` (request start instant, set in both HTTP and CLI modes), plus `HTTP_*` request headers (uppercased, `-`→`_`).

## Error pages

Unified `errorPage(code, title, detail)`: monospace font + `<pre>` with escaped detail; 500 includes the full stack. An exception thrown mid-render turns the whole response into 500 (no partial output — Eta's pure-function rendering satisfies this naturally). Errors after `res.headersSent` just `res.destroy()`.

## Tests

- `tests/test_server.js`: spawns a child process running the server (port 5177, overridable via `ETA_TEST_PORT` for parallel CI), fetch-based assertions for HTTP mode;
- `tests/test_cli.js`: spawnSync assertions for CLI render mode (decision #11): file rendering byte-exact, argv passthrough (argv[0]=script itself, args after the script that look like `-H` pass through verbatim), degraded `_SERVER` key set and empty bridge, no extension enforcement (.txt renders too), missing file / render exception exit 1 with clean stdout, include base = script directory, require anchored at the script directory, writeraw / json short-circuit, RESP response-control no-ops, BOM tolerated, trailing newline preserved, options before the script name accepted; stdin (`-`) rendering, three-key degradation (SCRIPT_NAME/FILENAME='-', SCRIPT_DIRNAME=cwd), argv[0]='-', include/require base = cwd, exceptions exit 1, BOM tolerated.

HTTP mode has 61 checks (symlink-dependent probes self-SKIP on systems without file-symlink privilege — win32 needs elevation / developer mode; junction-based probes stay unconditional):

- rendering: index.eta, `/` fallback, query params;
- directories: 301 trailing slash, index.html fallback, **escaping index candidates 404 one by one (fail-closed even with a legitimate index.html beside)**, **directories named `*.eta` fall back to normal serving (decision #17)**;
- static: Content-Type, 405, outside-whitelist 404, extended type matrix (csv/md/js/webm asserted per type, `.js` = text/javascript);
- security: 404, `../` traversal 404, **realpath escape (junction/symlink out of root → 404, both template and static paths)**, in-container symlinks served normally, DOS device names, NTFS ADS, trailing-dot platform divergence, duplicate-slash 308 (bare `//` and `%2f`-encoded, both paths), **hidden-path convention: dotfiles / node_modules (all case variants) 404 while `_next/`-style exports and `.well-known` stay public, every block logged to stderr (decisions #17/#18)**, **dot-prefixed `..b` segments 404 under the hidden convention**, **server source 404 including case variants (a second instance with docroot = package directory, decision #15; comparison now platform-independent, decision #17)**;
- PATH_INFO suffix (`<%~ %>` raw-outputs a JSON array), **PATH_INFO may contain hidden-looking segments (file part only is checked, decision #17)**;
- API: GET echo, form POST, JSON body, **+json Content-Type feeding `_JSON`**, **over-64MB body empirically receives 413 on the client side**, **multipart POST warns on stderr and leaves `_POST` empty (decision #17)**;
- bridge: **HTTP `_SERVER` includes SERVER_PROTOCOL / REQUEST_TIME(_FLOAT)**, **prototype keys (`__proto__`/`constructor`/`hasOwnProperty`) are just ordinary data keys**;
- **concurrency: 8×4MB POSTs overlapping a window of 40 tagged GETs, per-request assertion that `_GET` never mixes up (decision #14, discriminating against the old `ctx.parsed` implementation, empirically reproduced and re-verified)**;
- session: three-level chained cookie counting 1→2→3, tampered signature rejected (count resets to 1), **`_SESSION = {}` clears the session (`Max-Age=0` cookie, count restarts, decision #17)**, over 4KB → 500, deriveSecret root-mixing unit assertion, setcookie same-name exclusivity (not sent + exactly one framework entry), non-numeric maxage omits Max-Age (no `Max-Age=NaN`, decision #15);
- RESP: status(9999) / status(0) / status('abc') → 500, **status(100) → 500 (1xx class rejected, decision #18)**, RESP.escape equivalent to escape(), hop-by-hop headers dropped with a warning (decision #15), **header names normalized case-insensitively — lowercase Content-Type overrides the default, template Content-Length dropped, same-name different-case overwrites instead of duplicating (decision #17)**, **list-based Link headers keep every value (decision #17)**, **204 strips body / Content-Length / Content-Type (decision #17)**;
- require: demo page rendering, **required local files hot-reload on edit (mtime-driven cache invalidation, v1→v2 without restart, decision #15)**;
- 500: broken.eta (calls an undefined function);
- **`.404.eta` fallback renders custom 404 pages (rejected paths keep the status; early-404 branches expose `QUERY_STRING` to it; post-render failures — invalid status, oversized session, invalid headers — all degrade to the built-in 404, decisions #17/#18/#19; the fallback file itself stays unroutable)**;
- **static fd lifecycle: an aborted download still releases the fd (decision #18)**;
- **invalid header names/values fail at record time: four channels (header name / value / setcookie / redirect) give a coherent 500 with the right reason phrase — no more "HTTP/1.1 500 OK" (decision #19)**;
- **access log (decision #16/#17): CLF line for rendered pages on stderr, `--access-log <file>` appends to a file and stays out of stderr, `--quiet` produces no access lines at all, destination is per server instance (two in-process servers keep separate logs)**.

How to run: `npm test` (the tests themselves need Node 18+ for global fetch; `engines.node >= 22.18` is required by the in-template `require(.ts)` type-stripping feature — npm only warns on engines in pure test scenarios, doesn't block; test_server.js and test_cli.js run in sequence).

### Decision #9: template JS + logic TS split, zero dependencies

Template code blocks compile via `new Function` and bypass the module loader, so Node's type stripping can't help — `<% %>` blocks are JS-only. But the injected `require` can load `.ts` directly (Node 22.18+ built-in type stripping, empirically verified), matching the PHP ecosystem's division of labor: keep templates thin, push heavy logic into `lib/*.ts`. Erasable syntax only (enum / namespace / parameter properties unavailable). No ts-node / tsx / typescript introduced; `dependencies` stays at `eta` alone; `engines.node` raised to `>=22.18` accordingly.

### Decision #10: network requests in templates — top-level await + built-in fetch

The server is single-process single-threaded (Node's default model), but async I/O doesn't block the event loop: `renderStringAsync` compiles templates into async function bodies, so code blocks can top-level `await` directly, combined with Node's built-in `fetch` (zero dependencies) to request other URLs; while waiting, other requests are handled normally (demo/fetchdemo.eta awaits a fetch of this server's own hello.eta inside a template — if the event loop were blocked this page would deadlock; successful rendering is empirical proof of non-blocking). Convention: external URLs must always carry an `AbortController` timeout guard, otherwise a hung external service hangs that request's response forever; fetch failures go through in-template error branches rather than 500. One more general pitfall recorded in the demo comments: **never write literal tag syntax inside code-block comments** — Eta's parser is a plain-text scanner, and a `<%` inside a comment mis-identifies tag boundaries, treating the whole block as a string (hit in practice; the symptom is a ReferenceError in a later block).

## Known limitations

- No HTTPS (local-oriented; handle it with a reverse proxy);
- No multipart parsing (`_FILES` is phase two; request bodies go into `_BODY` raw); **multipart/form-data requests get a per-request stderr warning** so parameters are never silently lost (decision #17);
- **single-threaded event loop, no execution limits** (review finding documented rather than fixed): any heavy SYNCHRONOUS work in one template (`while(true)`, big loops, `execSync`) blocks every other request until it returns; top-level `await` is fine (decision #10), synchronous weight is not. The `uncaughtException` / `unhandledRejection` guards cover only asynchronous escapes — they are a crash guard, not PHP-FPM-style per-request isolation, and no render-time watchdog exists (it could only log after the fact, never interrupt synchronous code); keep templates thin, push heavy work into async code or out of process;
- No config files; access log is built in (decision #16); session TTL hardcoded at 30 minutes, sliding mode only, cookie name fixed (configurable TTL / timeout mode / cookie name wait for the phase-two config file);
- **No resource guardrails**: the 64MB body cap is per-request; no concurrent connection limit, total memory unbounded; no request-level timeout (a slow-body client can hold a connection forever) — acceptable for the local trusted-environment positioning; public deployments must have a reverse-proxy layer as the backstop;
- 413 responses arrive only after the client finishes uploading (drain rather than disconnect on overrun, decision #14);
- `_GET` / `_POST` / `_REQUEST` are plain objects; same-name parameters overwrite earlier values (no `getlist`-style multi-value access API);
- **repeated `RESP.header()` values**: only the list-based names (`Link` / `WWW-Authenticate` / `Proxy-Authenticate`) accumulate; every other header is last-write-wins (PHP `header()` default semantics; decision #17);
- template include resolves relative to `views` (document root in HTTP mode, script directory / cwd in CLI mode), not the template's own directory;
- CLI mode has no PHP exit() flush-then-exit semantics (Eta's pure-function rendering has no mid-flush path, decision #11);
- `RESP.write()` is a placeholder that throws explicitly (prompts you to use template text output); don't use it per PHP `echo` habits;
- **session secret file permissions**: the master secret lives at `~/.eta-server/session-secret` (decision #17), created with mode 0600 — on POSIX a misconfigured umask / shared home could still expose it, and on Windows the mode is a no-op (profile-directory ACL is the guard); when the home directory is not writable the key falls back to an enumerable machine fingerprint (hostname / user / home, no MACs), which is the old strength level; single-user machines are unaffected;
- **concurrent session writes are last-write-wins**: the stateless cookie session carries no lock — two overlapping requests that read-modify-write the same session lose the earlier write (PHP's file sessions hold a lock until `session_write_close`; this design has no equivalent). Avoid concurrent writers to one session;
- **the hot path is synchronous FS** (`stat`/`realpath`/`readFileSync` per request): negligible with a warm local cache, but network drives / real-time antivirus / very large templates serialize all concurrent requests (decision #14 fixed request-state pollution; this throughput ceiling remains);
- **static serving has no Range / ETag / Last-Modified**: `<video>` seeking is unavailable (full 200 only) and browsers re-download fully every time (no 304), despite audio/video types being whitelisted;
- **require hot-invalidation is shallow** (decision #15): only the mtime-changed entry itself is dropped; cached parent modules keep stale references (A requires B, B edits → A's cached copy still holds old B until A itself changes or the server restarts). Dynamic `await import()` is not invalidated at all — the ESM loader keeps a cache separate from `require.cache`; edits within the same mtime tick (same-millisecond saves, mtime-preserving copy tools) also do not trigger a reload;
- **crash guards keep serving, not exiting**: `uncaughtException` / `unhandledRejection` only log (decision #15); if process state is ever corrupted, restart manually with Ctrl+C.

## Publishing

```
npm publish          # bin: eta-server -> ./eta-server.js
npx -y eta-server -r ./www -p 5000
```

Before publishing, `npm link` works for local trials; once the repo is standalone, `npm publish` just works.
