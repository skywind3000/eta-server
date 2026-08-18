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
| `_SERVER` | request environment: `REQUEST_METHOD`, `QUERY_STRING`, `REQUEST_URI`, `SCRIPT_NAME`, `PATH_INFO`, `SCRIPT_FILENAME`, `SCRIPT_DIRNAME`, `DOCUMENT_ROOT`, `REMOTE_ADDR`, `CONTENT_TYPE`, `CONTENT_LENGTH`, `SERVER_NAME`, `SERVER_PORT`, `REQUEST_SCHEME`, `SERVER_PROTOCOL`, `REQUEST_TIME` / `REQUEST_TIME_FLOAT`, `HTTP_*` headers, plus `argv` in CLI mode |
| `_COOKIE` | cookie dict (values percent-decoded) |
| `_SESSION` | session object — signed-cookie based, no server-side storage, sliding 30-minute timeout. Mutate in place; don't reassign the whole object |
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
- Static files accept GET/HEAD only (others get 405); `.eta` scripts are rendered for all methods, with `REQUEST_METHOD` passed through.
- Directories: a missing trailing slash gets a 301 redirect, then `index.eta` → `index.html` → `index.htm` is tried.
- `PATH_INFO`: requesting `hello.eta/foo/bar` renders `hello.eta` with `_SERVER.PATH_INFO = '/foo/bar'`.
- Templates are re-read and re-compiled on every request — edit, refresh, done.
- Errors in a script produce a 500 page with the escaped error and stack trace.
- Request body cap: 64MB (413 beyond it). Path traversal, symlink/junction escapes and other filesystem tricks are all rejected with 404.
- Sessions are signed cookies (HMAC-SHA256, key derived from a machine + document-root fingerprint). Data is tamper-proof but visible to the client — don't store secrets.

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
```

## Security scope

eta-server is a lightweight dev server for **local / trusted environments**. `.eta` templates execute arbitrary JavaScript, equivalent to running scripts on your machine. No hardening for public exposure is attempted — put a reverse proxy in front if you must.

## Requirements

Node.js ≥ 22.18 (the tests themselves only need Node 18+ for `fetch`; the 22.18 floor is for the in-template `require(.ts)` type-stripping feature).

## Testing

```bash
npm test    # runs tests/test_server.js (HTTP mode) and tests/test_cli.js (CLI mode)
```

## License

MIT
