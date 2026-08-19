# AGENTS.md — eta-server

## Overview

eta-server is a PHP-style dynamic page server for `.eta` templates: the file path is the route — drop a `.eta` file into the document root and it becomes a page / JSON endpoint, with zero server-side code. It also has a built-in CLI render mode (like `php script.php`).

- Foundation: Eta template engine + Node.js built-in `http`; **zero runtime dependencies** beyond `eta`
- Single-file implementation: `eta-server.js` (shebang included; serves as both CLI and library entry — `require` it to call `startServer()` / `renderCli()` programmatically)
- Published on npm: `npx -y eta-server -r ./www -p 5000`

## Authoritative documentation (read before changing behavior)

- **[docs/prd.md](docs/prd.md)** — product requirements: positioning and security scope, template service semantics, Bridge API (`_GET`/`_POST`/`_SERVER`/`_SESSION`/`RESP`/`require` etc.), both CLI modes
- **[docs/spec.md](docs/spec.md)** — technical spec and key decisions (#1–#14): renderStringAsync choice, self-implemented session, path hardening (realpath containment / Windows special cases), per-request state isolation, etc. **Behavior changes must update prd/spec in the same commit**

## Directory layout

```
eta-server.js      main program (single file, HTTP server + CLI render, ~950 lines)
package.json       npm package definition (bin: eta-server; files include docs/prd.md docs/spec.md)
docs/prd.md        product requirements
docs/spec.md       technical spec and decision log
demo/              demo site (doubles as test fixture — tests assert on demo content)
tests/test_server.js   HTTP mode tests (spawned child process, port 5177, 59 checks; symlink probes self-SKIP without privilege)
tests/test_cli.js      CLI render mode tests (spawnSync assertions)
```

## Common commands

```bash
npm install            # install eta, the only runtime dependency
npm start              # node eta-server.js -r demo, open http://127.0.0.1:5000/
npm test               # runs tests/test_server.js then tests/test_cli.js
node eta-server.js demo/hello.eta     # CLI-render a single script
node eta-server.js -h                 # help
```

The tests themselves need Node 18+ (fetch); `engines.node >= 22.18` is required by the in-template `require(.ts)` type-stripping feature.

## Development constraints (important)

1. **Zero-dependency principle**: never add runtime dependencies (HTTP via `node:http`, sessions via `node:crypto`, CLI parsing hand-written) — see spec decision #8
2. **PHP feel first**: Bridge API names and semantics follow PHP superglobals; templates access them bare via `useWith`; changes must not break existing template semantics
3. **Fail-closed security semantics**: path traversal / symlink escapes / non-whitelisted extensions all return 404, indistinguishable from "does not exist" — see spec decisions #7/#12
4. **Per-request isolation**: `ctx` holds only immutable startup config; request-scoped state is passed as parameters layer by layer; shared mutable state is forbidden — see spec decision #14
5. **Buffered output model**: rendering is a pure function; the response is sent only after rendering returns; body priority is binary(writeraw) > text(json) > rendered text — see spec decision #6
6. **Demo is the fixture**: `tests/` asserts on demo page content byte-for-byte; changing demo wording requires matching test updates
7. **Version sync**: the `VERSION` constant at the top of `eta-server.js` must match `version` in `package.json`

## Publishing workflow

```bash
npm test               # mandatory before publishing
npm pack --dry-run     # verify package contents (eta-server.js + docs/prd.md + docs/spec.md)
npm publish
```

The npm package name and bin name are both `eta-server`; after publishing, `npx -y eta-server -r <root> -p <port>` just works.

## Naming

The project name, npm package name, bin name and all in-code self-references use the lowercase hyphenated form **eta-server** (the old name EtaServer is retired).
