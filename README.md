# eta-server

A PHP-style dynamic page server for `.eta` templates: **the file path is the route**. Drop a `.eta` file into your document root and it instantly becomes a page — no server-side code, no configuration.

Built on the [Eta](https://eta.js.org) template engine and Node.js built-in modules. Zero runtime dependencies beyond `eta` itself.

- Product requirements: [docs/prd.md](docs/prd.md)
- Technical spec & design decisions: [docs/spec.md](docs/spec.md)

## Quick start

```bash
# from npm (recommended)
npx -y eta-server -r ./www -p 5000

# or clone this repo
npm install
node eta-server.js -r demo -p 5000
# then open http://127.0.0.1:5000/
```

Options:

| Option | Meaning | Default |
|---|---|---|
| `-r, --root <dir>` | document root (HTTP mode only) | current directory |
| `-p, --port <port>` | port (HTTP mode only) | 5000 |
| `-H, --host <addr>` | bind address (HTTP mode only) | 127.0.0.1 |
| `-q, --quiet` | no access log (HTTP mode only) | off |
| `--access-log <path>` | append access log to `<path>`, `-` = stdout (HTTP mode only) | stderr |
| `--allowed-hosts <list>` | extra `Host` names to accept, comma separated; `all` turns the check off (HTTP mode only) | loopback names, `*.localhost`, literal IPs, bind address |
| `--behind-proxy` | behind a reverse proxy: skip the Host check, trust `X-Forwarded-For/-Proto/-Host` (HTTP mode only) | off |
| `-h, --help` | help | |

With no positional argument it starts the HTTP server; with one, it renders that script once to stdout (CLI mode, below).

## Writing pages

Create `hello.eta` inside your document root:

```html
<%
const name = _GET.name || 'world'
_SESSION.count = (_SESSION.count || 0) + 1
%>
<h1>Hello, <%= name %>!</h1>
<p>Visit number <%= _SESSION.count %></p>
```

Request `http://localhost:5000/hello.eta?name=skywind` and you get the page. That's the whole workflow: new page = new file.

### A more complete example

Code blocks and HTML freely interleave — open a block with `<%`, drop into markup, reopen it to close the loop, exactly the PHP rhythm:

```html
<%
// _REQUEST merges GET + POST params (POST wins on conflict)
const filter = (_REQUEST.role || 'all').toLowerCase()
const users = [
  { name: 'alice', role: 'admin' },
  { name: 'bob',   role: 'user'  },
  { name: 'carol', role: 'user'  },
]
%><!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Users</title></head>
<body>
<h1>User directory</h1>
<p>Filter: <b><%= filter %></b></p>
<ul>
<% for (const u of users) { %>
<%   if (filter === 'all' || u.role === filter) { %>
  <li><b><%= u.name %></b> — <%= u.role %></li>
<%   } %>
<% } %>
</ul>
<%
// top-level await works inside code blocks
const resp = await fetch('https://api.github.com/zen',
  { signal: AbortSignal.timeout(5000) })
const zen = resp.ok ? await resp.text() : '(fetch failed)'
%>
<footer>Server wisdom: <%= zen %></footer>
</body>
</html>
```

Request `http://localhost:5000/users.eta?role=user` and only the `user` entries render. Note the `<% %>` blocks inside the loop: one opens the `for`, markup follows, then another block supplies the closing `}` — control flow and HTML weave together line by line. Since rendering preserves source layout (`autoTrim: false`), the blank lines left by code blocks are expected; if that bothers you, put the whole loop on fewer lines or post-process the output.

### Template syntax

| Syntax | Meaning |
|---|---|
| `<% ... %>` | code block (plain JavaScript, no TS syntax here) |
| `<%= expr %>` | interpolate with HTML escaping |
| `<%~ expr %>` | interpolate raw (no escaping) |
| `<%# comment %>` | comment (or use `//` inside code blocks — but never write a literal `<%` inside a comment, Eta scans plain text) |
| `<%~ include("header") %>` | include another template (resolved against `views`, i.e. the document root in HTTP mode) |

Top-level `await` works inside code blocks, so you can `await fetch(...)` directly in a template. Use a plain `return` in a code block to stop rendering early.

### Bridge API (PHP-style superglobals)

All bridge names are available bare in templates (thanks to Eta `useWith`); the `it.` prefix also works.

| Name | Description |
|---|---|
| `_GET` / `_POST` / `_REQUEST` | query params / form-urlencoded body / merged (POST wins) |
| `_SERVER` | request environment: `REQUEST_METHOD`, `QUERY_STRING`, `REQUEST_URI`, `SCRIPT_NAME`, `PATH_INFO`, `SCRIPT_FILENAME`, `SCRIPT_DIRNAME`, `DOCUMENT_ROOT`, `REMOTE_ADDR`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `SERVER_NAME`, `SERVER_PORT`, `REQUEST_SCHEME` (the first, third and sixth follow `X-Forwarded-*` under `--behind-proxy`), `SERVER_PROTOCOL`, `REQUEST_TIME` / `REQUEST_TIME_FLOAT`, `HTTP_*` headers, plus `argv` in CLI mode |
| `_COOKIE` | cookie dict (values percent-decoded) |
| `_SESSION` | session object — signed-cookie based, no server-side storage, sliding 30-minute timeout. Mutate in place, or reassign the whole object (`_SESSION = {}`) to clear it |
| `_BODY` | raw request body (Buffer, like `php://input`) |
| `_JSON` | parsed JSON body when Content-Type contains `json`, else `null` |
| `RESP.status(code)` | set response status code |
| `RESP.header(name, value)` | set response header (all output is buffered; no headers-already-sent problem) |
| `RESP.redirect(url, code=302)` | convenience redirect |
| `RESP.json(data)` | convenience JSON response (does not stop rendering — pair with `return`) |
| `RESP.setcookie(name, value, opts)` | set cookie (values percent-encoded by default) |
| `RESP.writeraw(buf)` | binary output; once used it short-circuits all text output |
| `escape(value)` / `RESP.escape` | HTML escape (`htmlspecialchars` equivalent) |
| `require(spec)` | Node `require` anchored at the template's own directory — relative paths resolve against the `.eta` file's dir, bare names walk up to `node_modules` |

A JSON API in one file (`api.eta`):

```html
<%
RESP.json({ method: _SERVER.REQUEST_METHOD, get: _GET, json: _JSON })
return
%>
```

### Requiring TypeScript from templates

Template code blocks are compiled with `new Function`, so they stay plain JS — but the injected `require` can load `.ts` files directly (Node ≥ 22.18 built-in type stripping, zero extra dependencies). Keep templates thin and push logic into `lib/*.ts`:

```html
<% const util = require('./lib/util.ts') %>
<%= util.greet(_GET.name) %>
```

Only erasable syntax is allowed (type annotations / interface / type / generics OK; enum / namespace / parameter properties are not). ESM static `import` syntax is not available in templates (they are not modules); use `await import()` instead.

## Request semantics

- Requesting `xxx.eta` renders it; non-`.eta` requests are served statically from a **built-in extension whitelist** (html, txt, css, js, json, common images, fonts, audio/video, pdf, wasm, archives — full list in the spec). Anything outside the whitelist is 404 (fail-closed).
- **Hidden paths**: segments starting with `.`, and `node_modules` (any case), are never served (404); `.well-known` is exempt. Keep server-side libraries and config files behind dot names — `.lib/util.ts`, `.config.json` — plain assets and underscore build output (`_next/`) stay public. Every blocked request logs one stderr line, so a mysterious 404 is diagnosable at a glance.
- **Custom 404 pages**: drop a `.404.eta` into the docroot and every 404 renders it (default status 404; the script may override).
- Static files accept GET/HEAD only (others get 405); `.eta` scripts are rendered for all methods, with `REQUEST_METHOD` passed through.
- Directories: a missing trailing slash gets a 301 redirect, then `index.eta` → `index.html` → `index.htm` is tried. A directory whose name contains `.eta` is served normally (the script/PATH_INFO split applies to files only).
- `PATH_INFO`: requesting `hello.eta/foo/bar` renders `hello.eta` with `_SERVER.PATH_INFO = '/foo/bar'`.
- Templates are re-read and re-compiled on every request — edit, refresh, done.
- Errors in a script produce a 500 page with the escaped error and stack trace.
- Request body cap: 64MB (413 beyond it). Path traversal, symlink/junction escapes and other filesystem tricks are all rejected with 404 — including win32 8.3 short-name aliases (`/NODE_M~1/…`), which resolve to their real long name before any rule runs.
- **Host allowlist**: requests whose `Host` is not a loopback name, a `*.localhost` name, a literal IP or the bind address get a 403. This stops a remote page from reaching your dev server by pointing its own hostname at `127.0.0.1` (DNS rebinding). Serving a custom hostname on purpose? `--allowed-hosts myapp.test`, or `--allowed-hosts all` to switch the check off. Behind a reverse proxy use `--behind-proxy` instead — see [Production deployment](#production-deployment).
- `X-Forwarded-For` / `-Proto` / `-Host` are **ignored** unless `--behind-proxy` says a proxy owns the port; a rebound page is same-origin and could otherwise forge its own client address.
- Responses carry `Cache-Control: no-store` unless the script sets the header itself, so the browser can't hand back a stale copy of a file you just edited.
- Sessions are signed cookies (HMAC-SHA256, key derived from a random per-user secret persisted in your home directory, mixed with the document root). `_SESSION = {}` (or `null` / `false`) clears the session. Data is tamper-proof but visible to the client — don't store secrets.

## CLI render mode

Render a single script to stdout, like `php script.php`:

```bash
node eta-server.js demo/hello.eta            # render a file
node eta-server.js script.eta one two --x    # extra args pass through via _SERVER.argv
echo 'hi <%~ _SERVER.argv[0] %>' | node eta-server.js -   # read the script from stdin
```

Rules (aligned with PHP CLI conventions): any file extension works; `-` means stdin; everything after the script name is passed through verbatim (`argv[0]` = the script itself); `include` / `require` resolve against the script's directory (cwd for stdin); render errors go to stderr with exit code 1. See spec decision #11.

## Programmatic use

`eta-server.js` doubles as a library (requiring it never starts the server):

```js
const { startServer, renderCli, VERSION } = require('eta-server')

const server = await startServer('./www', 5000, '127.0.0.1')

// same knobs as the CLI flags, per instance
const s2 = await startServer('./www', 5001, '127.0.0.1',
  { quiet: true, accessLog: '/tmp/eta.log', allowedHosts: 'myapp.test' })

// behind a proxy: trust X-Forwarded-* and skip the Host check
const s3 = await startServer('./www', 5002, '127.0.0.1',
  { behindProxy: true })
```

## Security scope

eta-server is a lightweight dev server for **local / trusted environments**. `.eta` templates execute arbitrary JavaScript, equivalent to running scripts on your machine. No hardening for public exposure is attempted — put a reverse proxy in front if you must.

One caveat worth knowing: a loopback bind is *not* an access control, because the browser you use for other browsing can be aimed at `127.0.0.1` by any page you visit (DNS rebinding). The built-in Host allowlist is what closes that door; if you disable it with `--allowed-hosts all`, understand that any web page you open can then talk to this server and read its responses.

## Production deployment

If you really need to expose eta-server, run it behind a reverse proxy: keep it bound to localhost (`-H 127.0.0.1`, the default) and let Apache/nginx handle TLS, static assets, logging and the public interface.

```bash
npx -y eta-server -r /srv/eta/www -p 5000 -H 127.0.0.1 -q \
  --access-log /var/log/eta-server.log --behind-proxy
```

> **Use `--behind-proxy`.** Both configurations below forward the client's `Host` unchanged (`ProxyPreserveHost On` / `proxy_set_header Host $host`), so your public domain arrives as the `Host` header — and the rebinding allowlist would reject it with a 403, because from the server's side a forwarded request and a rebound one are indistinguishable. The flag is how you declare the topology, and it pays for itself: it also makes eta-server *read* the `X-Forwarded-*` headers these configs already send, so `_SERVER.REMOTE_ADDR` becomes the real client instead of `127.0.0.1`, `_SERVER.REQUEST_SCHEME` reports `https` when the client used TLS, and access-log lines carry the client address rather than the proxy's.
>
> Keep the bind address private (`-H 127.0.0.1`, the default) when using it — the flag's contract is that only your proxy can reach the port, since anything that can connect directly may now forge its own address and scheme. Want both belt and braces? `--behind-proxy --allowed-hosts example.com,www.example.com` keeps the Host allowlist enforced on top.

### Apache (reverse proxy)

Enable the required modules first:

```bash
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2
```

Then add the proxy rules, e.g. in your vhost or a conf snippet under `conf-available/`:

```apache
# eta-server
ProxyPreserveHost On
ProxyPass /eta http://127.0.0.1:5000
ProxyPassReverse /eta http://127.0.0.1:5000

# forward the real client address / protocol to the app
RequestHeader set X-Forwarded-Proto "https" env=HTTPS
```

Everything under `/eta/...` is forwarded to eta-server (the prefix is stripped, so `/eta/hello.eta` arrives as `/hello.eta`). To serve the app at the site root instead, use `ProxyPass / http://127.0.0.1:5000/` — but then it shadows Apache's own document root for that vhost.

### nginx (reverse proxy)

```nginx
server {
    listen 80;
    server_name example.com;

    location /eta/ {
        proxy_pass http://127.0.0.1:5000/;   # trailing slash strips the /eta prefix
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # serve everything else (including the whole site root) with:
    # location / { proxy_pass http://127.0.0.1:5000/; ... }
}
```

Note the trailing slash on `proxy_pass` — it strips the `/eta` prefix, matching the Apache behavior above; drop it if you want the prefix preserved (eta-server will then 404 those requests).

### Keep-alive process

Whichever proxy you use, keep eta-server itself alive with a process supervisor. Minimal Supervisor config (`/etc/supervisor/conf.d/eta-server.conf`):

```ini
[program:eta-server]
command=/usr/bin/npx -y eta-server -r /srv/eta/www -p 5000 -H 127.0.0.1 --behind-proxy
directory=/srv/eta/www
autostart=true
autorestart=true
stderr_logfile=/var/log/eta-server.err.log
stdout_logfile=/var/log/eta-server.out.log
user=www-data
```

```bash
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl start eta-server
```

Reminders before going public: sessions are signed cookies (visible to the client — store no secrets), templates execute arbitrary JavaScript, and there is no rate limiting or request hardening beyond path containment. The proxy is your security boundary.

## Requirements

Node.js ≥ 22.18 (the tests themselves only need Node 18+ for `fetch`; the 22.18 floor is for the in-template `require(.ts)` type-stripping feature).

## Testing

```bash
npm test    # runs tests/test_server.js (HTTP mode) and tests/test_cli.js (CLI mode)
```

## License

MIT

