# eta-server

A PHP-like system built on Eta + Node.js. With eta-server, creating a new dynamic page or a plain HTTP/JSON endpoint is just adding a `.eta` file to the document root — no changes to any server-side code.

## Project positioning

eta-server is a lightweight dynamic page service based on "file path is the route + PHP superglobal bridges": point it at a document root and it serves pages and APIs for every `.eta` script underneath; adding a new page / JSON endpoint is just adding a file, with zero server-side code. Distributed as an npm package, one line to start: `npx -y eta-server -r root -p 5000`. It also has a built-in CLI render mode that renders a single script directly, like `php script.php`.

## Positioning and security scope

- This project is a lightweight dynamic page service intended for **local / trusted environments**; no security hardening for public-exposure scenarios;
- `.eta` templates are essentially arbitrary JavaScript execution, equivalent to running scripts on the local machine — users must be aware of this.

## Distribution

- npm package name `eta-server`, `bin` entry of the same name; `npx -y eta-server -r ./www -p 5000` starts it directly;
- The main program is a single file `eta-server.js` (with shebang, serving as both CLI and library entry; `require` it to call `startServer()` programmatically);
- **Zero runtime dependencies** beyond the `eta` template engine: HTTP uses Node's built-in `http`, sessions use a self-implemented signed-cookie scheme on built-in `crypto`, argument parsing is hand-written.

## Template service

- Based on Eta / Node.js, providing a .php-like web service;
- A request for `http://localhost:5000/web/demo.eta` resolves the relative path, finds the corresponding .eta file under the document root, renders it and returns the result;
- Once started with a document root, every .eta script underneath gets page service; adding a new dynamic page is just adding a .eta file, without touching a single line of server code;
- Requests for non-.eta files go through static file serving: per a **built-in extension whitelist** (web .html/.htm, text .txt, .css, .js, data .json, common images, .pdf, common archives — full table in the spec) the matching Content-Type and raw bytes are returned; **anything outside the whitelist is 404**, denied by default (fail-closed); whitelisted existing files accept GET/HEAD only — other verbs get 405 Method Not Allowed (with an `Allow: GET, HEAD` header); .eta scripts are rendered for all verbs, with `REQUEST_METHOD` passed through faithfully;
- **Hidden-path convention** (server-side libraries and configs stay private): any path segment starting with `.`, and `node_modules` directories (matched case-insensitively), is never served — neither as a template nor as a static file nor as a directory index (404, indistinguishable from "does not exist"); `.well-known` is exempt (RFC 8615: ACME challenges, `apple-app-site-association`). Every blocked request logs one stderr line (`blocked by hidden-path convention: ...`), so a mysterious 404 is diagnosable at a glance. Put decision #9's library files and config files behind dot names (`.lib/util.ts`, `.config.json`); plain assets (`style.css`, `app.js`) and underscore-prefixed build output (`_next/`, `_astro/`, `_nuxt/`) stay public. Note a DIRECTORY whose name contains `.eta` is served normally (the script/PATH_INFO split applies to files only);
- Relative path traversal outside the document root is prevented; **filesystem-level escapes are rejected too**: symlinks / junctions inside root pointing outside fail the realpath containment check and 404; Windows reserved device names (NUL/CON…), NTFS alternate data streams (`$DATA`) 404; trailing dots/spaces are normalized per Win32 file-open semantics; duplicate slashes collapse with a 308 (`//a` → `/a`);
- Requests mapping to a directory (including `/`): if the URL lacks a trailing `/`, a 301 redirect adds it first (matching Apache `DirectorySlash`), then `index.eta`, `index.html`, `index.htm` are tried in order;
- The server's own source file is never served (404) even when the document root is the package directory — matched case-insensitively on every platform (covering case variants and 8.3 short names);
- PATH_INFO suffix support: a request for `xxx.eta/suffix/path` (e.g. `/index.eta/hello`) renders `xxx.eta`, with the suffix (`/hello`) passed via `_SERVER['PATH_INFO']`; static files take no suffix;
- Change detection: the template engine cache is disabled (`cache: false`); every request reads from disk and recompiles — edits take effect immediately; files loaded via `require()` under the document root also hot-reload on edit (module-cache entries invalidated by mtime; `node_modules` excluded; invalidation covers the edited file itself — see the spec for the shallow-invalidation caveat);
- Error handling: .eta compilation errors or runtime exceptions return 500 with an error page (escaped error message plus stack trace);
- Request body size defaults to a 64MB cap; over-cap requests get 413 after the client finishes uploading (drain semantics, no connection drop);
- **Per-request isolation**: bridge data and URL parse results are independent per request (no shared mutable state); concurrent requests never cross-contaminate parameters;
- 404 handling: missing files and rejected path traversal both return 404, indistinguishable between "does not exist" and "denied"; when the docroot contains a `.404.eta` script, every 404 renders it instead of the built-in error page (default status stays 404; the script may override with `RESP.status()`; the file itself is unroutable by the hidden-path convention, and a broken fallback degrades to the built-in page);
- Encoding: all text output is UTF-8.

## Bridge API

Variables/functions exposed by the Node side to .eta templates, named and semantically aligned with PHP superglobals. Eta is configured with `useWith`, so templates can use **bare names** (`_GET.name` instead of `it._GET.name`); the `it.` prefix form also works.

### Request (PHP superglobal naming)

- `_REQUEST` — merged request parameter dict (query and form post merged, the latter wins);
- `_GET` / `_POST` — GET and POST parameter dicts separately; `_POST` parses `application/x-www-form-urlencoded` only; JSON request bodies go into `_JSON`;
- `_SERVER` — request environment dict, containing at least: `REQUEST_METHOD`, `QUERY_STRING`, `REQUEST_URI`, `SCRIPT_NAME`, `PATH_INFO`, `SCRIPT_FILENAME`, `SCRIPT_DIRNAME`, `DOCUMENT_ROOT`, `REMOTE_ADDR`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `SERVER_NAME`, `SERVER_PORT`, `REQUEST_SCHEME`, `SERVER_PROTOCOL`, `REQUEST_TIME` / `REQUEST_TIME_FLOAT`, and client request headers in `HTTP_*` form;
- `_BODY` — raw request body (Buffer, equivalent to PHP's `php://input`); when Content-Type is JSON, `_JSON` is also provided (auto-parsed to an object, otherwise null); request body size defaults to a 64MB cap, over-cap returns 413;
- `_COOKIE` — client cookie dict (values percent-decoded);
- `_SESSION` — session object: based on **signed cookie + timestamp**, no server-side storage; cookie fixed at `Path=/; HttpOnly; SameSite=Lax`, browser-session cookie (no Max-Age); sliding timeout (default 30 minutes, re-signed and refreshed on every response); reassigning `_SESSION` wholesale (`_SESSION = {}` or `_SESSION = null`) clears the session — the reassignment is read back after rendering, and a cleared session emits the `Max-Age=0` cookie-clearing line; the signing key is derived from a random per-user secret persisted at `~/.eta-server/session-secret` (mode 0600) mixed with the document root's realpath (HMAC), so it stays stable across restarts and NIC changes yet **differs across sites on the same machine** (a diskless machine-fingerprint fallback applies when the home directory is not writable); the whole cookie over 4KB → 500 (explicit failure beats silent browser drop); values must be JSON-serializable; data is visible to the client (tamper-proof, not confidential). **Strength boundary**: "tamper-proof" holds against the client side; on a shared host, another local user who can read the secret file can forge cookies; not designed for multi-user-host isolation;

### Module loading

- `require(spec)` — Node `require` anchored at the template file's directory (`module.createRequire(scriptPath)`): relative specifiers resolve against the .eta file's directory; bare specifiers walk up the directory tree searching `node_modules`, behaving exactly like "a .js file in the same directory";
- ESM static `import` syntax is unavailable (templates compile to `new Function` bodies, not modules); when ESM is needed, use the dynamic `await import()` form;
- **Template code blocks are JS-only, but business logic can be TypeScript**: `require('./lib/util.ts')` directly inside a template works via Node 22.18+ built-in type stripping, zero extra dependencies; erasable syntax only (type annotations / interface / type / generics OK; enum / namespace / parameter properties not allowed); keep templates thin and push heavy logic down into .ts library files.

### Output and response

- Plain template text and `<%= %>` interpolation output directly as usual, **all output is buffered throughout**, so `RESP.header()` / `status()` can be called anywhere in the template — no headers-already-sent limitation;
- `<%= %>` HTML-escapes by default (Eta `autoEscape`); use `<%~ %>` for raw output;
- `escape(value)` — HTML escape function (counterpart of `htmlspecialchars`, returns the escaped string); `RESP.escape` is the same function;
- `RESP.status(code)` / `RESP.header(name, value)` — set status code / response header (status not an integer in 200–999 → 500; the 1xx class is rejected — the buffered-body model has no meaningful interim response); header names and values are validated at record time against Node's HTTP token rules — an invalid name or value is a render-time error (a 500 whose stack points at the offending template line; a `.404.eta` fallback degrades to the built-in 404), never a late failure at response assembly; header names are normalized case-insensitively: **Content-Length is framework-owned** (template values are dropped with a stderr warning — it always reflects the real buffered body), Content-Type overrides the default whichever case you use, repeated ordinary headers are last-write-wins while the list-based `Link` / `WWW-Authenticate` / `Proxy-Authenticate` accumulate; **hop-by-hop header names** (`Transfer-Encoding`, `Connection`, `Trailer`, `Upgrade`, …) are framework-owned: template attempts are dropped with a stderr warning (they would clash with the buffered-body Content-Length model); statuses 204 / 205 / 304 ship no body, Content-Length or Content-Type at all (RFC-compliant; Set-Cookie still flows);
- `RESP.redirect(url, code=302)` — convenience redirect (**does not stop** rendering, same as `json()` — the script must terminate subsequent output itself);
- `RESP.json(data)` — convenience JSON response (sets Content-Type and serializes automatically; **does not stop** rendering — the script must terminate subsequent output itself);
- `RESP.setcookie(name, value, opts)` — set a cookie, values percent-encoded by default; non-numeric `maxage` is ignored (never emits `Max-Age=NaN`); **entries colliding with the session cookie name (`etasess`) are dropped and never sent** (the session mechanism owns that name; a warning goes to stderr);
- `RESP.writeraw(buf)` — binary output channel: appends bytes; once used it short-circuits all text output (template text and interpolation are discarded entirely); writeraw does not set Content-Type — do it yourself with `RESP.header()`;
- Default Content-Type: `text/html; charset=utf-8` when the script sets none explicitly.

### Not implemented (phase two)

- `_FILES` — file uploads (multipart parsing); until then, `multipart/form-data` requests emit a per-request stderr warning so parameters are never silently lost (raw bytes stay in `_BODY`);
- Configuration files (ini / json);
- CLI arguments for absolute timeouts / custom session TTL.

## CLI

```
eta-server -r <root> -p <port> [-H <host>]        # HTTP server mode
eta-server [options] script [args...]              # CLI render mode
eta-server [options] - [args...]                   # read the script from stdin
```

- `-r / --root`: document root, defaults to the current directory (HTTP mode only);
- `-p / --port`: port, defaults to 5000 (HTTP mode only);
- `-H / --host`: listen address, defaults to 127.0.0.1 (HTTP mode only);
- `-q / --quiet`: no access log (HTTP mode only);
- `--access-log <path>`: append the access log to `<path>` instead of stderr; `-` means stdout (HTTP mode only);
- `-h / --help`: help.

On startup a banner is printed (version, root absolute path, access URL); port conflicts (EADDRINUSE) produce a friendly error.

Every completed request gets one access-log line in Common Log Format (plus elapsed milliseconds), written on the response `finish` event:

```
127.0.0.1 - - [19/Aug/2026:10:23:45 +0800] "GET /hello.eta HTTP/1.1" 200 89 6ms
```

Default destination is stderr (stdout stays clean); aborted connections are not logged.

### CLI render mode

Once the first non-option positional argument appears, CLI render mode kicks in, like `php script.php`: render a single script, write the result to stdout, exit. Rules (aligned with PHP CLI conventions):

- Script path **not limited to any extension**; missing file → error on stderr, exit code 1;
- `script` of `-` reads the template source from **stdin** (POSIX convention);
- Everything after the script name is **not parsed, passed through verbatim**; the script reads them via `_SERVER.argv`, with `argv[0]` = the script itself (stdin gives `'-'`);
- The base directory for include / require = the script's directory (cwd for stdin renders);
- `_SERVER` degrades to fixed values (REQUEST_METHOD=GET etc.; no REQUEST_URI / DOCUMENT_ROOT / HTTP_*), the rest of the bridge degrades (empty _GET/_POST/_COOKIE/_SESSION, empty _BODY); RESP header/status/redirect/setcookie are record-only, side-effect-free;
- Output body priority is the same as HTTP mode: writeraw binary short-circuit > RESP.json() > rendered text;
- Render exceptions → stack written to stderr, exit code 1, nothing on stdout;
- Options like `-r` / `-p` / `-H` appearing before the script name are accepted as usual but have no effect (PHP-style leniency).
