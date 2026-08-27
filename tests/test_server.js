/* =====================================================================
 *
 * test_server.js - integration tests for eta-server.js
 *
 * Spawns the server on a private port with docroot = demo/ and checks
 * routing, static whitelist, PATH_INFO, POST parsing and sessions.
 * Requires Node 18+ (global fetch).
 *
 * Created by skywind on 2026/02/16
 * Last Modified: 2026/08/20 03:20:00
 *
 * ===================================================================== */
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const assert = require('node:assert')

// overridable so parallel CI jobs don't collide on the fixed default
const PORT = Number(process.env.ETA_TEST_PORT) || 5177
const BASE = 'http://127.0.0.1:' + PORT
const ROOT = path.join(__dirname, '..', 'demo')
const SERVER = path.join(__dirname, '..', 'eta-server.js')

let passed = 0
let failed = 0
let skipped = 0
const tmpDemoFiles = []

// file-symlink capability probe: win32 needs elevation or developer
// mode; tests requiring it SKIP (not fail) when unavailable. Junctions
// need no privilege and stay unconditional
const SYMLINK_OK = (() => {
  const p = path.join(os.tmpdir(), 'eta-symlink-probe-' + process.pid)
  try {
    fs.symlinkSync(__filename, p, 'file')
    fs.rmSync(p)
    return true
  } catch (e) {
    return false
  }
})()

// write a throwaway file inside the docroot, cleaned up at the end
function writeDemo (name, text) {
  const p = path.join(ROOT, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  tmpDemoFiles.push(p)
  return p
}

// GET with a hand-written Host header: fetch() treats Host as a
// forbidden header and silently keeps its own, so the rebinding probes
// have to go through node:http
function rawGet (port, hostHeader, urlPath, extra) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: 'GET',
      headers: Object.assign({ Host: hostHeader }, extra || {}),
    }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c.toString() })
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: body,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

// hand-written request line: every URL parser on the way percent-
// encodes the interesting characters, so a literal '"' only reaches
// the server through a raw socket
function rawLine (port, line) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(line + '\r\nHost: 127.0.0.1:' + port +
        '\r\nConnection: close\r\n\r\n')
    })
    let buf = ''
    sock.on('data', (c) => { buf += c.toString() })
    sock.on('close', () => resolve(buf))
    sock.on('error', () => resolve(buf))
  })
}

async function check (name, fn) {
  try {
    await fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(err && err.message || err))
  }
}

function skip (name, reason) {
  skipped++
  console.log('  SKIP  ' + name + ' (' + reason + ')')
}

async function waitForReady (tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + '/index.eta')
      await res.text()
      return true
    } catch (e) {
      await new Promise(r => setTimeout(r, 200))
    }
  }
  return false
}

// extract "Set-Cookie: ETASESSION=..." value from a fetch Response
function getSessionCookie (res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const item of all) {
    if (item.startsWith(SESSION_NAME())) return item.split(';')[0]
  }
  return null
}

function SESSION_NAME () { return 'ETASESSION=' }

async function main () {
  const child = spawn(process.execPath,
    [SERVER, '-r', ROOT, '-p', String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => { stderr += c.toString() })

  try {
    const ready = await waitForReady(50)
    if (!ready) {
      console.error('server did not start:\n' + stderr)
      process.exit(1)
    }

    await check('GET /index.eta renders', async () => {
      const res = await fetch(BASE + '/index.eta', { redirect: 'manual' })
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('eta-server Demo') >= 0)
      assert.ok(body.indexOf('Hello, <b>world</b>') >= 0)
    })

    await check('GET / falls back to index.eta', async () => {
      const res = await fetch(BASE + '/')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('eta-server Demo') >= 0)
    })

    await check('GET query param reaches _GET', async () => {
      const res = await fetch(BASE + '/index.eta?name=skywind')
      const body = await res.text()
      assert.ok(body.indexOf('Hello, <b>skywind</b>') >= 0)
    })

    await check('directory without slash gets 301', async () => {
      const res = await fetch(BASE + '/sub', { redirect: 'manual' })
      assert.strictEqual(res.status, 301)
      assert.strictEqual(res.headers.get('location'), '/sub/')
      await res.text()
    })

    await check('directory index.html fallback', async () => {
      const res = await fetch(BASE + '/sub/')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('static index.html fallback') >= 0)
    })

    await check('static file served with Content-Type', async () => {
      const res = await fetch(BASE + '/style.css')
      assert.strictEqual(res.status, 200)
      assert.ok(String(res.headers.get('content-type')).indexOf('text/css') >= 0)
      const body = await res.text()
      assert.ok(body.indexOf('font-family') >= 0)
    })

    await check('POST static file rejected with 405', async () => {
      const res = await fetch(BASE + '/style.css', { method: 'POST' })
      assert.strictEqual(res.status, 405)
      assert.strictEqual(res.headers.get('allow'), 'GET, HEAD')
      await res.text()
    })

    await check('missing file returns 404', async () => {
      const res = await fetch(BASE + '/no-such.eta')
      assert.strictEqual(res.status, 404)
      await res.text()
    })

    await check('non-whitelist extension returns 404', async () => {
      const res = await fetch(BASE + '/../eta-server.js')
      assert.ok(res.status === 404)
      await res.text()
    })

    await check('path traversal blocked', async () => {
      const res = await fetch(BASE + '/tests/../eta-server.js',
        { redirect: 'manual' })
      assert.strictEqual(res.status, 404)
      await res.text()
    })

    await check('dot-prefixed segments are hidden (404)', async () => {
      // path.relative(root, root/'..b.eta') = '..b.eta': the
      // first-segment containment check accepts such relative results,
      // but the hidden-path convention (decision #17) denies any
      // dot-prefixed segment before routing — 404 like any missing file
      writeDemo('..b.eta', 'DOUBLE-DOT-NAME')
      const res = await fetch(BASE + '/..b.eta')
      assert.strictEqual(res.status, 404)
      await res.text()
    })

    await check('hidden paths: dotfiles and node_modules (any case) 404, ' +
      'underscore exports stay public', async () => {
        writeDemo('t_public.js', 'var x = 1')
        writeDemo('.hidden.txt', 'HIDDEN')
        writeDemo('.config/db.json', '{"dbPassword":"x"}')
        writeDemo('_next/static/app.js', 'var app = 1')
        writeDemo('.well-known/token.txt', 'ACME-OK')
        const nm = path.join(ROOT, 'node_modules', 'pkg-data.json')
        fs.mkdirSync(path.dirname(nm), { recursive: true })
        fs.writeFileSync(nm, '{}')
        tmpDemoFiles.push(path.join(ROOT, 'node_modules'))
        for (const u of ['/t_public.js', '/_next/static/app.js',
          '/.well-known/token.txt']) {
          const res = await fetch(BASE + u)
          assert.strictEqual(res.status, 200, u + ' must stay public')
          await res.text()
        }
        for (const u of ['/.hidden.txt', '/.config/db.json',
          '/node_modules/pkg-data.json',
          // case variants of the SAME directory: on win32 / APFS the
          // file system opens them as 'node_modules' and realpath
          // does not normalize case, so only a case-insensitive match
          // catches them (fourth-review security fix)
          '/Node_Modules/pkg-data.json', '/NODE_MODULES/pkg-data.json']) {
          const res = await fetch(BASE + u)
          assert.strictEqual(res.status, 404, u)
          await res.text()
        }
        await new Promise(r => setTimeout(r, 100))
        assert.ok(stderr.indexOf('blocked by hidden-path') >= 0,
          'hidden-path blocks must be logged to stderr')
      })

    await check('server source 404 incl. case variants (root=package dir)',
      async () => {
        const pkgRoot = path.join(__dirname, '..')
        const port2 = PORT + 1
        const BASE2 = 'http://127.0.0.1:' + port2
        const child2 = spawn(process.execPath,
          [SERVER, '-r', pkgRoot, '-p', String(port2)],
          { stdio: ['ignore', 'pipe', 'pipe'] })
        try {
          for (let i = 0; i < 50; i++) {
            try {
              const r = await fetch(BASE2 + '/package.json')
              await r.text()
              break
            } catch (e) {
              await new Promise(r => setTimeout(r, 200))
            }
          }
          for (const name of ['/eta-server.js', '/ETA-SERVER.js',
            '/Eta-Server.JS']) {
            const res = await fetch(BASE2 + name)
            await res.text()
            assert.strictEqual(res.status, 404, name)
          }
          // the win32 8.3 alias of the self file: fs.realpathSync does
          // not expand short names, so before decision #20 this route
          // downloaded the whole server source with a 200. Only volumes
          // with short-name creation enabled generate the alias
          const alias83 = path.join(pkgRoot, 'ETA-SE~1.JS')
          if (process.platform === 'win32' && fs.existsSync(alias83)) {
            const rs = await fetch(BASE2 + '/ETA-SE~1.JS')
            const bodyS = await rs.text()
            assert.strictEqual(rs.status, 404, 'ETA-SE~1.JS alias')
            assert.ok(bodyS.indexOf('usr/bin/env node') < 0,
              'server source leaked through its 8.3 alias')
          } else {
            skip('self file 8.3 alias probe',
              'no 8.3 short name for eta-server.js on this volume')
          }
          // root itself is functional: only the self file is blocked
          const ok = await fetch(BASE2 + '/package.json')
          assert.strictEqual(ok.status, 200)
          await ok.text()
          // fourth self-protection point: an index candidate inside
          // the root symlinking to the self file — the containment
          // check cannot catch it (target is inside the root), only
          // isSelfPath can; both index.eta and index.html branches
          if (SYMLINK_OK) {
            const idxDir = path.join(pkgRoot, 't_selfidx')
            fs.mkdirSync(idxDir)
            try {
              fs.symlinkSync(path.join(pkgRoot, 'eta-server.js'),
                path.join(idxDir, 'index.html'))
              const r1 = await fetch(BASE2 + '/t_selfidx/')
              await r1.text()
              assert.strictEqual(r1.status, 404, 'index.html -> self symlink')
              fs.rmSync(path.join(idxDir, 'index.html'))
              fs.symlinkSync(path.join(pkgRoot, 'eta-server.js'),
                path.join(idxDir, 'index.eta'))
              const r2 = await fetch(BASE2 + '/t_selfidx/')
              await r2.text()
              assert.strictEqual(r2.status, 404, 'index.eta -> self symlink')
            } finally {
              fs.rmSync(idxDir, { recursive: true, force: true })
            }
          } else {
            skip('self-index symlink probes',
              'file symlinks need elevation / developer mode')
          }
        } finally {
          child2.kill()
        }
      })

    await check('PATH_INFO tail is passed to script', async () => {
      const res = await fetch(BASE + '/hello.eta/linwei/42')
      assert.strictEqual(res.status, 200)
      assert.ok(String(res.headers.get('content-type')).indexOf('text/plain') >= 0)
      const body = await res.text()
      assert.ok(body.indexOf('PATH_INFO   : /linwei/42') >= 0)
      // segments line uses <%~ %> raw output, so JSON is unescaped
      assert.ok(body.indexOf('["linwei","42"]') >= 0)
    })

    await check('PATH_INFO may contain hidden-looking segments', async () => {
      // the hidden-path convention checks the FILE part only; the
      // PATH_INFO tail is data, not a file path
      const res = await fetch(BASE + '/hello.eta/.user/42')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('PATH_INFO   : /.user/42') >= 0)
    })

    await check('directory named *.eta falls back to normal serving',
      async () => {
        writeDemo('assets.eta/site.css', 'body { color: red }')
        const r1 = await fetch(BASE + '/assets.eta/site.css')
        assert.strictEqual(r1.status, 200)
        assert.ok((await r1.text()).indexOf('color: red') >= 0)
        const r2 = await fetch(BASE + '/assets.eta', { redirect: 'manual' })
        assert.strictEqual(r2.status, 301)
        assert.strictEqual(r2.headers.get('location'), '/assets.eta/')
        await r2.text()
      })

    await check('JSON API echoes GET', async () => {
      const res = await fetch(BASE + '/api.eta?a=1&b=two')
      assert.strictEqual(res.status, 200)
      assert.ok(String(res.headers.get('content-type')).indexOf('json') >= 0)
      const data = await res.json()
      assert.deepStrictEqual(data.query, { a: '1', b: 'two' })
    })

    await check('form POST reaches _POST', async () => {
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=skywind&age=18',
      })
      const data = await res.json()
      assert.strictEqual(data.method, 'POST')
      assert.deepStrictEqual(data.post, { name: 'skywind', age: '18' })
    })

    await check('JSON body reaches _JSON', async () => {
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'eta' }),
      })
      const data = await res.json()
      assert.deepStrictEqual(data.json, { hello: 'eta' })
    })

    await check('multipart POST parses fields into _POST', async () => {
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=X' },
        body: '--X\r\nContent-Disposition: form-data; name="a"\r\n\r\n' +
          '1\r\n--X--\r\n',
      })
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.deepStrictEqual(data.post, { a: '1' })
    })

    await check('multipart POST uploads a file into _FILES', async () => {
      writeDemo('t_upl.eta',
        '<%~ JSON.stringify({name:_FILES.f.name,size:_FILES.f.size,type:_FILES.f.type,err:_FILES.f.error}) %>')
      const fileContent = 'hello upload'
      const res = await fetch(BASE + '/t_upl.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body: '--B\r\n' +
          'Content-Disposition: form-data; name="f"; filename="test.txt"\r\n' +
          'Content-Type: text/plain\r\n\r\n' +
          fileContent + '\r\n--B--\r\n',
      })
      assert.strictEqual(res.status, 200)
      const data = JSON.parse(await res.text())
      assert.strictEqual(data.name, 'test.txt')
      assert.strictEqual(data.size, fileContent.length)
      assert.strictEqual(data.type, 'text/plain')
      assert.strictEqual(data.err, 0)
    })

    await check('multipart too many fields returns 413', async () => {
      let body = ''
      for (let i = 0; i < 257; i++) {
        body += '--B\r\nContent-Disposition: form-data; name="f' + i + '"\r\n\r\nx\r\n'
      }
      body += '--B--\r\n'
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body,
      })
      assert.strictEqual(res.status, 413)
    })

    await check('multipart too many files returns 413', async () => {
      let body = ''
      for (let i = 0; i < 65; i++) {
        body += '--B\r\n' +
          'Content-Disposition: form-data; name="f"; filename="a' + i + '.txt"\r\n\r\n' +
          'x\r\n'
      }
      body += '--B--\r\n'
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body,
      })
      assert.strictEqual(res.status, 413)
    })

    await check('multipart file too large returns 413', async () => {
      const big = 'x'.repeat(16 * 1024 * 1024 + 1)
      const body = '--B\r\n' +
        'Content-Disposition: form-data; name="f"; filename="big.txt"\r\n\r\n' +
        big + '\r\n--B--\r\n'
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body,
      })
      assert.strictEqual(res.status, 413)
    })

    await check('multipart part header too large returns 413', async () => {
      const body = '--B\r\n' +
        'Content-Disposition: form-data; name="f"\r\n' +
        'X-Pad: ' + 'x'.repeat(8192) + '\r\n\r\n' +
        'value\r\n--B--\r\n'
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
        body,
      })
      assert.strictEqual(res.status, 413)
    })

    await check('multipart file content containing boundary bytes is ' +
      'not truncated', async () => {
        // RFC 7578: a delimiter only counts at the start of a line.
        // The old anywhere-scan cut the file at the first boundary-
        // looking byte sequence inside its content
        writeDemo('t_upl2.eta', '<%~ _FILES.f.size %>')
        const fileContent = 'head\n--B\n--B\ntail'
        const res = await fetch(BASE + '/t_upl2.eta', {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
          body: '--B\r\n' +
            'Content-Disposition: form-data; name="f"; ' +
            'filename="in.txt"\r\n\r\n' +
            fileContent + '\r\n--B--\r\n',
        })
        assert.strictEqual(res.status, 200)
        assert.strictEqual(Number(await res.text()), fileContent.length)
      })

    await check('multipart field value containing boundary bytes ' +
      'survives intact', async () => {
        const res = await fetch(BASE + '/api.eta', {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=B' },
          body: '--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n' +
            'x--B--y\r\n--B--\r\n',
        })
        assert.strictEqual(res.status, 200)
        const data = await res.json()
        assert.deepStrictEqual(data.post, { a: 'x--B--y' })
      })

    await check('form-urlencoded too many fields returns 413', async () => {
      // a 64MB body of tiny pairs used to parse into millions of dict
      // entries synchronously; the channel is bounded like multipart
      const pairs = []
      for (let i = 0; i < 4097; i++) pairs.push('k' + i + '=v')
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pairs.join('&'),
      })
      assert.strictEqual(res.status, 413)
      // just under the limit still parses
      pairs.pop()
      const ok = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: pairs.join('&'),
      })
      assert.strictEqual(ok.status, 200)
      const data = await ok.json()
      assert.strictEqual(data.post.k0, 'v')
    })

    await check('_ENV exposes environment variables', async () => {
      // PATH is 'Path' on Windows; use a portable probe
      writeDemo('t_env.eta',
        '<%~ (_ENV.PATH || _ENV.Path) ? "has-path" : "no-path" %>')
      const res = await fetch(BASE + '/t_env.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), 'has-path')
    })

    await check('session cookie persists across requests', async () => {
      const r1 = await fetch(BASE + '/index.eta')
      await r1.text()
      const cookie = getSessionCookie(r1)
      assert.ok(cookie, 'first response must set ETASESSION cookie')
      const r2 = await fetch(BASE + '/index.eta', {
        headers: { Cookie: cookie }
      })
      const body2 = await r2.text()
      assert.ok(body2.indexOf('Visits in this session: <b>2</b>') >= 0)
      // sliding session: must chain the re-signed cookie from r2
      const cookie2 = getSessionCookie(r2)
      assert.ok(cookie2, 'second response must re-sign ETASESSION cookie')
      const r3 = await fetch(BASE + '/index.eta', {
        headers: { Cookie: cookie2 }
      })
      const body3 = await r3.text()
      assert.ok(body3.indexOf('Visits in this session: <b>3</b>') >= 0)
    })

    await check('tampered session cookie is rejected', async () => {
      const r1 = await fetch(BASE + '/index.eta')
      await r1.text()
      const cookie = getSessionCookie(r1)
      assert.ok(cookie)
      // corrupt the payload part (keep signature)
      const tampered = cookie.replace('ETASESSION=', 'ETASESSION=xx')
      const r2 = await fetch(BASE + '/index.eta', {
        headers: { Cookie: tampered }
      })
      const body2 = await r2.text()
      assert.ok(body2.indexOf('Visits in this session: <b>1</b>') >= 0)
    })

    await check('_SESSION reassignment (_SESSION = {}) clears the session',
      async () => {
        writeDemo('t_sesscount.eta',
          '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>')
        writeDemo('t_sessclear.eta',
          '<%~ JSON.stringify(_SESSION) %><% _SESSION = {} %>')
        const r1 = await fetch(BASE + '/t_sesscount.eta')
        assert.strictEqual(await r1.text(), '1')
        const c1 = getSessionCookie(r1)
        assert.ok(c1)
        const r2 = await fetch(BASE + '/t_sesscount.eta',
          { headers: { Cookie: c1 } })
        assert.strictEqual(await r2.text(), '2')
        const c2 = getSessionCookie(r2)
        const r3 = await fetch(BASE + '/t_sessclear.eta',
          { headers: { Cookie: c2 } })
        const body3 = await r3.text()
        assert.ok(body3.indexOf('"n":2') >= 0)
        const all = r3.headers.getSetCookie ? r3.headers.getSetCookie() : []
        const cleared = all.filter((c) => c.startsWith('ETASESSION=') &&
          c.indexOf('Max-Age=0') >= 0)
        assert.strictEqual(cleared.length, 1,
          'cleared session must emit one Max-Age=0 cookie')
        // the browser now holds the cleared cookie; counting restarts
        const c3 = getSessionCookie(r3)
        assert.strictEqual(c3, 'ETASESSION=')
        const r4 = await fetch(BASE + '/t_sesscount.eta',
          { headers: { Cookie: c3 } })
        assert.strictEqual(await r4.text(), '1')
      })

    await check('_SESSION = false clears the session like {} / null',
      async () => {
        // the docs listed false among the clearing values but the code
        // only handled null / undefined and warned about the rest
        writeDemo('t_sessc2.eta',
          '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>')
        writeDemo('t_sessfalse.eta', '<% _SESSION = false %>cleared')
        const r1 = await fetch(BASE + '/t_sessc2.eta')
        assert.strictEqual(await r1.text(), '1')
        const c1 = getSessionCookie(r1)
        assert.ok(c1)
        const r2 = await fetch(BASE + '/t_sessfalse.eta',
          { headers: { Cookie: c1 } })
        assert.strictEqual(await r2.text(), 'cleared')
        const all = r2.headers.getSetCookie ? r2.headers.getSetCookie() : []
        const cleared = all.filter((c) => c.startsWith('ETASESSION=') &&
          c.indexOf('Max-Age=0') >= 0)
        assert.strictEqual(cleared.length, 1,
          '_SESSION = false must emit the Max-Age=0 clear')
      })

    await check('session TTL is configurable (options.sessionTtl)',
      async () => {
        // decision #24: the sliding timeout is a startup parameter;
        // 0.02 minutes = 1.2 seconds — short enough to expire inside
        // the test, long enough that normal processing does not race it
        const mod = require(SERVER)
        writeDemo('t_ttl.eta',
          '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>')
        const portT = PORT + 13
        const srv = await mod.startServer(ROOT, portT, '127.0.0.1',
          { quiet: true, sessionTtl: 0.02 })
        try {
          const base = 'http://127.0.0.1:' + portT + '/t_ttl.eta'
          const r1 = await fetch(base)
          assert.strictEqual(await r1.text(), '1')
          const c1 = getSessionCookie(r1)
          assert.ok(c1)
          await new Promise(r => setTimeout(r, 1400))
          const r2 = await fetch(base, { headers: { Cookie: c1 } })
          assert.strictEqual(await r2.text(), '1',
            'expired cookie must restart the session count')
        } finally {
          if (srv.closeAllConnections) srv.closeAllConnections()
          await new Promise(r => srv.close(r))
        }
      })

    await check('invalid sessionTtl rejects startServer', async () => {
      // no silent fallback to the 30-minute default (decision #24)
      const mod = require(SERVER)
      await assert.rejects(
        mod.startServer(ROOT, PORT + 14, '127.0.0.1',
          { quiet: true, sessionTtl: 'abc' }),
        /invalid session TTL/)
    })

    await check('invalid port rejects startServer (library API)',
      async () => {
        // Number('abc') || 5000 used to start the server on a port the
        // caller never asked for
        const mod = require(SERVER)
        for (const p of ['abc', 0, -1, 70000, 5000.5]) {
          await assert.rejects(mod.startServer(ROOT, p, '127.0.0.1',
            { quiet: true }), /invalid port/)
        }
      })

    await check('require() demo works (node:path)', async () => {
      const res = await fetch(BASE + '/require.eta')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('require() demo') >= 0)
      assert.ok(body.indexOf('SCRIPT_DIRNAME') >= 0)
    })

    await check('require()d local files hot-reload on edit', async () => {
      // Node's module cache is shared across createRequire instances;
      // the mtime-based invalidation must make library edits visible
      // without a server restart
      const lib = writeDemo('t_hotlib.js', 'module.exports = "v1"\n')
      writeDemo('t_hot.eta', '<%~ require("./t_hotlib.js") %>')
      const r1 = await fetch(BASE + '/t_hot.eta')
      assert.strictEqual(await r1.text(), 'v1')
      fs.writeFileSync(lib, 'module.exports = "v2"\n')
      // guarantee a strictly newer mtime regardless of fs granularity
      const t = new Date(Date.now() + 1000)
      fs.utimesSync(lib, t, t)
      const r2 = await fetch(BASE + '/t_hot.eta')
      assert.strictEqual(await r2.text(), 'v2')
    })

    await check('TypeScript library loads via require(.ts)', async () => {
      const res = await fetch(BASE + '/tsdemo.eta')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('alice (age 30)') >= 0)
      assert.ok(body.indexOf('sum([1,2,3]) = 6') >= 0)
    })

    await check('template runtime error gives 500 page', async () => {
      const res = await fetch(BASE + '/broken.eta')
      assert.strictEqual(res.status, 500)
      const body = await res.text()
      assert.ok(body.indexOf('Internal Server Error') >= 0)
    })

    await check('top-level await fetch works in template', async () => {
      const res = await fetch(BASE + '/fetchdemo.eta')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('top-level await') >= 0)
      // self-fetch embedded hello.eta response proves event loop kept
      // serving while the template awaited
      assert.ok(body.indexOf('PATH_INFO   : /from-fetchdemo') >= 0)
    })

    await check('etainfo() page renders all sections', async () => {
      const res = await fetch(BASE + '/etainfo.eta?probe=1')
      assert.strictEqual(res.status, 200)
      const body = await res.text()
      assert.ok(body.indexOf('etainfo()') >= 0)
      assert.ok(body.indexOf('eta-server Version') >= 0)
      assert.ok(body.indexOf('This Request (_SERVER)') >= 0)
      assert.ok(body.indexOf('Request Parameters') >= 0)
      assert.ok(body.indexOf('Environment Variables') >= 0)
      assert.ok(body.indexOf('Bridge API') >= 0)
      assert.ok(body.indexOf('probe') >= 0)        // _GET echoed in table
      assert.ok(body.indexOf('QUERY_STRING') >= 0)
    })

    // ==================== path hardening ====================

    await check('symlink/junction escaping the root gives 404', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-out-'))
      fs.writeFileSync(path.join(outDir, 'evil.eta'), 'EVIL')
      fs.writeFileSync(path.join(outDir, 'data.json'), '{"evil":1}')
      const junc = path.join(ROOT, 't_junc')
      tmpDemoFiles.push(junc)
      const type = process.platform === 'win32' ? 'junction' : 'dir'
      fs.symlinkSync(outDir, junc, type)
      try {
        const r1 = await fetch(BASE + '/t_junc/evil.eta')
        await r1.text()
        assert.strictEqual(r1.status, 404, 'escaping .eta template')
        const r2 = await fetch(BASE + '/t_junc/data.json')
        await r2.text()
        assert.strictEqual(r2.status, 404, 'escaping static file')
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true })
      }
    })

    await check('symlink staying inside the root still serves', async () => {
      if (!SYMLINK_OK) {
        skip('symlink staying inside the root still serves',
          'file symlinks need elevation / developer mode')
        return
      }
      const link = path.join(ROOT, 't_in.txt')
      tmpDemoFiles.push(link)
      fs.symlinkSync(path.join(ROOT, 'style.css'), link)
      const res = await fetch(BASE + '/t_in.txt')
      assert.strictEqual(res.status, 200)
      await res.text()
    })

    await check('DOS device names give 404', async () => {
      for (const name of ['/NUL', '/con.txt', '/COM1']) {
        const res = await fetch(BASE + name)
        await res.text()
        assert.strictEqual(res.status, 404, name)
      }
    })

    await check('NTFS ADS colon paths give 404', async () => {
      const res = await fetch(BASE + '/hello.eta%3A%3A%24DATA')
      await res.text()
      assert.strictEqual(res.status, 404)
    })

    await check('trailing dot behaves like the filesystem', async () => {
      // Win32 opens 'hello.eta.' as 'hello.eta'; POSIX has no such file
      const res = await fetch(BASE + '/hello.eta.')
      await res.text()
      const expect = process.platform === 'win32' ? 200 : 404
      assert.strictEqual(res.status, expect)
    })

    await check('duplicate slashes merge with 308', async () => {
      const r1 = await fetch(BASE + '//style.css', { redirect: 'manual' })
      assert.strictEqual(r1.status, 308)
      assert.strictEqual(r1.headers.get('location'), '/style.css')
      const r2 = await fetch(BASE + '//sub///index.html?x=1',
        { redirect: 'manual' })
      assert.strictEqual(r2.status, 308)
      assert.strictEqual(r2.headers.get('location'), '/sub/index.html?x=1')
    })

    await check('%2f-encoded duplicate slashes merge with 308', async () => {
      const res = await fetch(BASE + '/sub%2f%2findex.html',
        { redirect: 'manual' })
      assert.strictEqual(res.status, 308)
      assert.strictEqual(res.headers.get('location'), '/sub/index.html')
    })

    await check('backslash targets 308 instead of routing somewhere else',
      async () => {
        // '\' is '/' per WHATWG, so new URL() read '/\host/x.eta' as an
        // AUTHORITY: the host part vanished and the request served
        // '/x.eta' — a served path unrelated to the request target that
        // a fronting proxy or an access rule sees. The 308 also spliced
        // the raw target, answering '//\evil/x' with 'Location:
        // /\evil/x', which browsers re-normalize into '//evil/x' — an
        // open redirect (decision #22). Raw socket: every URL parser on
        // the way (fetch included) normalizes the backslash away first
        const BS = '\\'
        writeDemo('t_bs.eta', 'BS-TARGET-SERVED')
        const targets = [
          '//' + BS + 'evil.example/x',
          '/' + BS + '/evil.example/t_bs.eta',
          '/' + BS + BS + 'evil.example/t_bs.eta',
          '/' + BS + 't_bs.eta',
          '/sub' + BS + 't_bs.eta',
        ]
        for (const target of targets) {
          const out = await rawLine(PORT, 'GET ' + target + ' HTTP/1.1')
          const first = out.split('\r\n')[0]
          assert.ok(/^HTTP\/1\.1 308 /.test(first), target + ' -> ' + first)
          const loc = out.split('\r\n')
            .find((l) => /^location:/i.test(l)) || ''
          assert.ok(loc.indexOf(BS) < 0,
            'Location must carry no backslash: ' + loc)
          assert.ok(!/location:\s*\/\//i.test(loc),
            'Location must not be protocol-relative: ' + loc)
          assert.ok(out.indexOf('BS-TARGET-SERVED') < 0,
            target + ' served a page instead of redirecting')
        }
        // the %5C escape hatch still reaches a literal backslash name
        // (decoded later, never through this guard — decision #12)
        const enc = await fetch(BASE + '/t_bs%5Cnope.eta',
          { redirect: 'manual' })
        assert.strictEqual(enc.status, 404)
        await enc.text()
      })

    await check('8.3 short names cannot bypass the hidden-path convention',
      async () => {
        // fs.realpathSync resolves symlinks but not win32 short names,
        // so /NODE_M~1/x.json and /LIB~1/util.js used to serve hidden
        // files with a 200 while their long names 404'd (decision #20).
        // tmpdir sits on the system volume, where short-name creation
        // is usually ON; project volumes often have it off, hence the
        // per-alias existence probe below
        if (process.platform !== 'win32') {
          skip('8.3 short-name bypass probe', 'win32 only')
          return
        }
        const root83 = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-83-'))
        fs.mkdirSync(path.join(root83, 'node_modules'))
        fs.writeFileSync(path.join(root83, 'node_modules', 'pkg.json'),
          '{"dbPassword":"SECRET-NM"}')
        fs.mkdirSync(path.join(root83, '.lib'))
        fs.writeFileSync(path.join(root83, '.lib', 'util.js'), 'SECRET-LIB')
        fs.writeFileSync(path.join(root83, '.h83.txt'), 'SECRET-DOTFILE')
        // echoes which script rendered it: a 404 legitimately renders
        // this page, so only SCRIPT_NAME can tell "reached as the
        // fallback" from "routed directly through its 8.3 alias"
        fs.writeFileSync(path.join(root83, '.404.eta'),
          'FB:<%~ _SERVER.SCRIPT_NAME %>')
        fs.writeFileSync(path.join(root83, 'index.eta'), 'ok')
        // aliases this volume actually generated, keyed by the first
        // segment (that is what has to exist for the probe to mean
        // anything) plus the string that must NOT come back
        const aliases = [
          ['/NODE_M~1/pkg.json', 'NODE_M~1', 'SECRET-NM'],
          ['/LIB~1/util.js', 'LIB~1', 'SECRET-LIB'],
          ['/H83~1.TXT', 'H83~1.TXT', 'SECRET-DOTFILE'],
          ['/404~1.ETA', '404~1.ETA', '404~1.ETA'],
        ].filter((a) => fs.existsSync(path.join(root83, a[1])))
        if (aliases.length === 0) {
          fs.rmSync(root83, { recursive: true, force: true })
          skip('8.3 short-name bypass probe',
            'volume has no 8.3 short names (NtfsDisable8dot3NameCreation)')
          return
        }
        const mod = require(SERVER)
        const port83 = PORT + 7
        const srv83 = await mod.startServer(root83, port83, '127.0.0.1',
          { quiet: true })
        try {
          for (const item of aliases) {
            const res = await fetch('http://127.0.0.1:' + port83 + item[0])
            const body = await res.text()
            assert.strictEqual(res.status, 404, item[0])
            assert.ok(body.indexOf(item[2]) < 0,
              item[0] + ' served "' + item[2] + '" through its 8.3 alias')
          }
          // the docroot is otherwise functional
          const ok = await fetch('http://127.0.0.1:' + port83 + '/index.eta')
          assert.strictEqual(ok.status, 200)
          await ok.text()
        } finally {
          if (srv83.closeAllConnections) srv83.closeAllConnections()
          await new Promise(r => srv83.close(r))
          fs.rmSync(root83, { recursive: true, force: true })
        }
      })

    // ==================== Host allowlist (decision #20) ====================

    await check('foreign Host is rejected (DNS rebinding defense)',
      async () => {
        const bad = await rawGet(PORT, 'attacker.example', '/index.eta')
        assert.strictEqual(bad.status, 403)
        assert.ok(bad.body.indexOf('allowlist') >= 0)
        // the 403 must name the escape hatch: a bare 404 here would be
        // undebuggable for a custom dev hostname
        assert.ok(bad.body.indexOf('--allowed-hosts') >= 0)
        // loopback names, *.localhost and literal IPs stay usable
        for (const h of ['127.0.0.1:' + PORT, 'localhost:' + PORT,
          'myapp.localhost:' + PORT, '[::1]:' + PORT, '192.168.1.9:' + PORT]) {
          const ok = await rawGet(PORT, h, '/index.eta')
          assert.strictEqual(ok.status, 200, h)
        }
        await new Promise(r => setTimeout(r, 100))
        assert.ok(stderr.indexOf('blocked by host allowlist') >= 0,
          'host allowlist blocks must be logged to stderr')
      })

    await check('bare IPv6 Host literal is allowed',
      async () => {
        // Host: ::1 (no brackets, no port) used to be mis-parsed as
        // host:port and rejected; it must be accepted as a literal IP
        const ok1 = await rawGet(PORT, '::1', '/index.eta')
        assert.strictEqual(ok1.status, 200, 'bare ::1')
        const ok2 = await rawGet(PORT, '[::1]', '/index.eta')
        assert.strictEqual(ok2.status, 200, 'bracketed [::1] without port')
      })

    await check('--allowed-hosts extends the list, "all" disables it',
      async () => {
        const mod = require(SERVER)
        const portD = PORT + 8
        const portE = PORT + 9
        const srvD = await mod.startServer(ROOT, portD, '127.0.0.1',
          { quiet: true, allowedHosts: 'dev.example,other.test' })
        const srvE = await mod.startServer(ROOT, portE, '127.0.0.1',
          { quiet: true, allowedHosts: 'all' })
        try {
          assert.strictEqual(
            (await rawGet(portD, 'dev.example', '/index.eta')).status, 200)
          assert.strictEqual(
            (await rawGet(portD, 'other.test:1234', '/index.eta')).status, 200)
          assert.strictEqual(
            (await rawGet(portD, 'evil.example', '/index.eta')).status, 403)
          assert.strictEqual(
            (await rawGet(portE, 'evil.example', '/index.eta')).status, 200)
        } finally {
          if (srvD.closeAllConnections) srvD.closeAllConnections()
          if (srvE.closeAllConnections) srvE.closeAllConnections()
          await new Promise(r => srvD.close(r))
          await new Promise(r => srvE.close(r))
        }
      })

    await check('X-Forwarded-* are ignored without --behind-proxy',
      async () => {
        // a DNS-rebound page is same-origin, so it can set these headers
        // freely (no CORS preflight stops it) — trusting them by default
        // would hand every template a forgeable client address
        writeDemo('t_fwd.eta', '<%~ _SERVER.REMOTE_ADDR %>|' +
          '<%~ _SERVER.REQUEST_SCHEME %>|<%~ _SERVER.SERVER_NAME %>')
        const r = await rawGet(PORT, 'localhost:' + PORT, '/t_fwd.eta', {
          'X-Forwarded-For': '203.0.113.9',
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'spoofed.example',
        })
        assert.strictEqual(r.status, 200)
        assert.strictEqual(r.body, '127.0.0.1|http|localhost')
      })

    await check('--behind-proxy trusts X-Forwarded-* and skips the Host check',
      async () => {
        const mod = require(SERVER)
        writeDemo('t_sessprx.eta', '<% _SESSION.n = 1 %>ok')
        const portP = PORT + 10
        const logP = path.join(os.tmpdir(), 'eta-proxy-' + Date.now() + '.log')
        const srvP = await mod.startServer(ROOT, portP, '127.0.0.1',
          { accessLog: logP, behindProxy: true })
        // the same flag with an explicit allowlist: naming domains is
        // stronger than trusting the proxy, so the allowlist still wins
        const portQ = PORT + 11
        const srvQ = await mod.startServer(ROOT, portQ, '127.0.0.1',
          { quiet: true, behindProxy: true, allowedHosts: 'example.com' })
        try {
          // the public domain the proxy forwards is accepted
          const r1 = await rawGet(portP, 'example.com', '/t_fwd.eta', {
            'X-Forwarded-For': '203.0.113.9, 10.0.0.1',
            'X-Forwarded-Proto': 'https',
          })
          assert.strictEqual(r1.status, 200, 'proxied Host must pass')
          // leftmost XFF entry is the client; scheme comes from the proxy;
          // Host still names the site (no X-Forwarded-Host sent here)
          assert.strictEqual(r1.body, '203.0.113.9|https|example.com')
          // a proxy that does NOT preserve Host puts the name only in
          // X-Forwarded-Host
          const r2 = await rawGet(portP, '127.0.0.1:' + portP, '/t_fwd.eta', {
            'X-Real-IP': '198.51.100.7',
            'X-Forwarded-Host': 'www.example.com',
          })
          assert.strictEqual(r2.body, '198.51.100.7|http|www.example.com')
          // a bogus scheme is not passed through to templates
          const r3 = await rawGet(portP, 'example.com', '/t_fwd.eta',
            { 'X-Forwarded-Proto': 'javascript' })
          assert.strictEqual(r3.body.split('|')[1], 'http')
          // the access log reports the forwarded client, not the proxy
          await new Promise(r => setTimeout(r, 150))
          const text = fs.readFileSync(logP, 'utf8')
          assert.ok(/^203\.0\.113\.9 - - \[/m.test(text),
            'access log must show the forwarded client address')
          // explicit allowlist still enforced under --behind-proxy
          assert.strictEqual(
            (await rawGet(portQ, 'example.com', '/index.eta')).status, 200)
          assert.strictEqual(
            (await rawGet(portQ, 'evil.example', '/index.eta')).status, 403,
            '--allowed-hosts must outrank --behind-proxy')
          // ---- forwarded values are validated (decision #23) ----
          // a forged client address used to forge a whole CLF field
          // prefix, and to hand templates arbitrary text where
          // REMOTE_ADDR promises an address; junk falls back to the peer
          const r4 = await rawGet(portP, 'example.com', '/t_fwd.eta', {
            'X-Forwarded-For': '1.2.3.4 - - [pwned] "GET /x HTTP/1.1" 200 0',
            'X-Forwarded-Host': 'evil"><script>alert(1)</script>',
          })
          assert.strictEqual(r4.body.split('|')[0], '127.0.0.1',
            'a non-IP X-Forwarded-For must fall back to the peer')
          assert.strictEqual(r4.body.split('|')[2], 'example.com',
            'a malformed X-Forwarded-Host must not reach SERVER_NAME')
          const r5 = await rawGet(portP, 'example.com', '/t_fwd.eta',
            { 'X-Real-IP': 'not-an-ip;drop table' })
          assert.strictEqual(r5.body.split('|')[0], '127.0.0.1')
          // an address with the source port appended is still an address
          const r6 = await rawGet(portP, 'example.com', '/t_fwd.eta',
            { 'X-Forwarded-For': '203.0.113.9:51000' })
          assert.strictEqual(r6.body.split('|')[0], '203.0.113.9')
          const r7 = await rawGet(portP, 'example.com', '/t_fwd.eta',
            { 'X-Forwarded-For': '[2001:db8::1]:443' })
          assert.strictEqual(r7.body.split('|')[0], '2001:db8::1')
          // underscores are ordinary in dev / docker hostnames
          const r7b = await rawGet(portP, 'example.com', '/t_fwd.eta',
            { 'X-Forwarded-Host': 'my_app.local' })
          assert.strictEqual(r7b.body.split('|')[2], 'my_app.local')
          await new Promise(r => setTimeout(r, 150))
          const text2 = fs.readFileSync(logP, 'utf8')
          assert.ok(text2.indexOf('[pwned]') < 0,
            'forged CLF fields reached the access log')
          // ---- session cookie gains Secure on an https request ----
          const r8 = await rawGet(portP, 'example.com', '/t_sessprx.eta',
            { 'X-Forwarded-Proto': 'https' })
          const sc = (r8.headers['set-cookie'] || [])
            .filter((c) => c.startsWith('ETASESSION='))
          assert.strictEqual(sc.length, 1)
          assert.ok(sc[0].indexOf('; Secure') >= 0,
            'https request must get a Secure session cookie: ' + sc[0])
          const r9 = await rawGet(portP, 'example.com', '/t_sessprx.eta')
          const sc9 = (r9.headers['set-cookie'] || [])
            .filter((c) => c.startsWith('ETASESSION='))
          assert.ok(sc9[0].indexOf('Secure') < 0,
            'plain http must not get a Secure cookie: ' + sc9[0])
        } finally {
          if (srvP.closeAllConnections) srvP.closeAllConnections()
          if (srvQ.closeAllConnections) srvQ.closeAllConnections()
          await new Promise(r => srvP.close(r))
          await new Promise(r => srvQ.close(r))
          try { fs.rmSync(logP) } catch (e) { }
        }
      })

    await check('access log escapes quotes inside the request line',
      async () => {
        // CLF quotes the request line, so an unescaped '"' in the URL
        // splits the field and every log parser downstream misreads it
        const out = await rawLine(PORT, 'GET /t_q"uote.txt HTTP/1.1')
        assert.ok(out.indexOf('HTTP/1.1 4') >= 0, 'expected a 4xx response')
        await new Promise(r => setTimeout(r, 120))
        assert.ok(stderr.indexOf('"GET /t_q\\"uote.txt HTTP/1.1"') >= 0,
          'a quote in the request target must be logged as \\"')
      })

    // ==================== bridge / _SERVER parity ====================

    await check('HTTP _SERVER has SERVER_PROTOCOL and REQUEST_TIME', async () => {
      writeDemo('t_srvinfo.eta',
        '<%~ _SERVER.SERVER_PROTOCOL %>;<%~ _SERVER.REQUEST_TIME %>;' +
        '<%~ _SERVER.REQUEST_TIME_FLOAT %>')
      const res = await fetch(BASE + '/t_srvinfo.eta')
      assert.strictEqual(res.status, 200)
      const parts = (await res.text()).split(';')
      assert.strictEqual(parts[0], 'HTTP/1.1')
      assert.ok(/^\d+$/.test(parts[1]))
      assert.ok(/^\d+(\.\d+)?$/.test(parts[2]))
    })

    await check('+json content types reach _JSON', async () => {
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.api+json' },
        body: JSON.stringify({ marked: 'json' }),
      })
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.deepStrictEqual(data.json, { marked: 'json' })
    })

    // ==================== static whitelist expansion ====================

    await check('expanded static types served with right Content-Type', async () => {
      writeDemo('t.csv', 'a,b\n1,2')
      writeDemo('t.md', '# hello')
      writeDemo('t.js', 'var x = 1')
      writeDemo('t.webm', 'bytes')
      const expect = [
        ['t.csv', 'text/csv; charset=utf-8'],
        ['t.md', 'text/markdown; charset=utf-8'],
        ['t.js', 'text/javascript; charset=utf-8'],
        ['t.webm', 'video/webm'],
      ]
      for (const item of expect) {
        const res = await fetch(BASE + '/' + item[0])
        assert.strictEqual(res.status, 200, item[0])
        assert.strictEqual(res.headers.get('content-type'), item[1])
        await res.text()
      }
    })

    // ==================== session hardening ====================

    await check('session over 4KB gives 500', async () => {
      writeDemo('t_bigsess.eta',
        '<% _SESSION.blob = "x".repeat(5000) %>ok')
      const res = await fetch(BASE + '/t_bigsess.eta')
      assert.strictEqual(res.status, 500)
      const body = await res.text()
      assert.ok(body.indexOf('4KB') >= 0)
    })

    await check('non-serializable _SESSION gives a clear 500', async () => {
      // JSON.stringify inside the session re-sign was the last
      // unguarded throw site after rendering (decision #22)
      writeDemo('t_sessnos.eta', '<% _SESSION.x = 10n %>ok')
      const res = await fetch(BASE + '/t_sessnos.eta')
      assert.strictEqual(res.status, 500)
      const body = await res.text()
      assert.ok(body.indexOf('JSON-serializable') >= 0, body.slice(0, 200))
      // a circular structure takes the same path
      writeDemo('t_sesscirc.eta',
        '<% const o = {}; o.o = o; _SESSION.o = o %>ok')
      const r2 = await fetch(BASE + '/t_sesscirc.eta')
      assert.strictEqual(r2.status, 500)
      assert.ok((await r2.text()).indexOf('JSON-serializable') >= 0)
    })

    await check('_SESSION is null-prototype on a fresh session too',
      async () => {
        // the restored path has been null-proto since decision #20, the
        // fresh one (no cookie yet) was a plain {} (decision #22)
        writeDemo('t_sessproto.eta',
          '<%~ Object.getPrototypeOf(_SESSION) === null %>' +
          '<% _SESSION.n = 1 %>')
        const r1 = await fetch(BASE + '/t_sessproto.eta')
        assert.strictEqual(await r1.text(), 'true', 'fresh session')
        const c1 = getSessionCookie(r1)
        assert.ok(c1)
        const r2 = await fetch(BASE + '/t_sessproto.eta',
          { headers: { Cookie: c1 } })
        assert.strictEqual(await r2.text(), 'true', 'restored session')
      })

    await check('deriveSecret mixes in the document root', async () => {
      const mod = require(SERVER)
      const a = mod.deriveSecret(ROOT)
      const b = mod.deriveSecret(path.join(ROOT, 'sub'))
      assert.strictEqual(typeof a, 'string')
      assert.strictEqual(a.length, 64)
      assert.notStrictEqual(a, b)
      assert.strictEqual(a, mod.deriveSecret(ROOT))
    })

    await check('explicit --secret replaces the key and the root mixing',
      async () => {
        // decision #21: an explicit secret must produce the SAME key
        // regardless of root, otherwise "I set the signing key" would
        // still leave two instances unable to read each other's cookies
        const mod = require(SERVER)
        const a = mod.deriveSecret(ROOT, 'seed-one')
        const b = mod.deriveSecret(path.join(ROOT, 'sub'), 'seed-one')
        assert.strictEqual(a.length, 64)
        assert.strictEqual(a, b, 'same secret must ignore the root')
        assert.notStrictEqual(a, mod.deriveSecret(ROOT, 'seed-two'))
        assert.notStrictEqual(a, mod.deriveSecret(ROOT))
      })

    await check('two roots sharing --secret accept each other\'s sessions',
      async () => {
        const mod = require(SERVER)
        const tpl = '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>'
        writeDemo('t_secret.eta', tpl)
        writeDemo('sub/t_secret.eta', tpl)
        // a page that does NOT touch the session: only there does the
        // "empty session + incoming cookie" clearing branch run, so it
        // is what discriminates "verified" from "rejected"
        writeDemo('sub/t_plain.eta', 'plain')
        const portS1 = PORT + 7
        const portS2 = PORT + 8
        const srv1 = await mod.startServer(ROOT, portS1, '127.0.0.1',
          { quiet: true, secret: 'shared-seed' })
        const srv2 = await mod.startServer(path.join(ROOT, 'sub'), portS2,
          '127.0.0.1', { quiet: true, secret: 'shared-seed' })
        try {
          const r1 = await fetch('http://127.0.0.1:' + portS1 +
            '/t_secret.eta')
          assert.strictEqual(await r1.text(), '1')
          const c1 = getSessionCookie(r1)
          assert.ok(c1)
          // the second instance verifies a cookie the first one minted,
          // so counting continues instead of restarting
          const r2 = await fetch('http://127.0.0.1:' + portS2 +
            '/t_secret.eta', { headers: { Cookie: c1 } })
          assert.strictEqual(await r2.text(), '2')
          // and a session-less page on the other instance leaves the
          // cookie alone instead of clearing it
          const r3 = await fetch('http://127.0.0.1:' + portS2 +
            '/t_plain.eta', { headers: { Cookie: c1 } })
          assert.strictEqual(await r3.text(), 'plain')
          const all = r3.headers.getSetCookie ? r3.headers.getSetCookie() : []
          const cleared = all.filter((c) => c.startsWith('ETASESSION=') &&
            c.indexOf('Max-Age=0') >= 0)
          assert.strictEqual(cleared.length, 0,
            'a verifiable cookie must not be cleared')
        } finally {
          if (srv1.closeAllConnections) srv1.closeAllConnections()
          if (srv2.closeAllConnections) srv2.closeAllConnections()
          await new Promise(r => srv1.close(r))
          await new Promise(r => srv2.close(r))
        }
      })

    await check('without --secret two roots leave each other\'s cookie alone',
      async () => {
        // the cookie NAME is global and cookies are not port-scoped, so
        // instance two receives a cookie it cannot verify — it used to
        // answer with the Max-Age=0 clear, i.e. opening site B logged
        // you out of site A. Only a verified cookie is ours to clear
        // (decision #22); --secret is still how two roots are made to
        // agree on one session (decision #21)
        const mod = require(SERVER)
        const tpl = '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>'
        writeDemo('t_secret2.eta', tpl)
        writeDemo('sub/t_plain2.eta', 'plain')
        const portS3 = PORT + 9
        const portS4 = PORT + 10
        const srv3 = await mod.startServer(ROOT, portS3, '127.0.0.1',
          { quiet: true })
        const srv4 = await mod.startServer(path.join(ROOT, 'sub'), portS4,
          '127.0.0.1', { quiet: true })
        try {
          const r1 = await fetch('http://127.0.0.1:' + portS3 +
            '/t_secret2.eta')
          assert.strictEqual(await r1.text(), '1')
          const c1 = getSessionCookie(r1)
          const r2 = await fetch('http://127.0.0.1:' + portS4 +
            '/t_plain2.eta', { headers: { Cookie: c1 } })
          assert.strictEqual(await r2.text(), 'plain')
          const all = r2.headers.getSetCookie ? r2.headers.getSetCookie() : []
          assert.strictEqual(all.length, 0,
            'an unverifiable cookie must be left untouched, not cleared')
          // and the first site's session is therefore still alive
          const r3 = await fetch('http://127.0.0.1:' + portS3 +
            '/t_secret2.eta', { headers: { Cookie: c1 } })
          assert.strictEqual(await r3.text(), '2',
            'site A lost its session after a request to site B')
        } finally {
          if (srv3.closeAllConnections) srv3.closeAllConnections()
          if (srv4.closeAllConnections) srv4.closeAllConnections()
          await new Promise(r => srv3.close(r))
          await new Promise(r => srv4.close(r))
        }
      })

    await check('ETA_SERVER_SECRET feeds the same key as --secret',
      async () => {
        // a child server takes the secret from the environment; an
        // in-process instance on a DIFFERENT root passes the same value
        // as an option — the cookie must cross over, which is only true
        // if both channels reach the same derivation
        const mod = require(SERVER)
        const tpl = '<% _SESSION.n = (_SESSION.n || 0) + 1 %><%~ _SESSION.n %>'
        writeDemo('t_secret3.eta', tpl)
        writeDemo('sub/t_secret3.eta', tpl)
        const portS5 = PORT + 11
        const portS6 = PORT + 12
        const childS = spawn(process.execPath,
          [SERVER, '-r', ROOT, '-p', String(portS5), '--quiet'],
          { stdio: ['ignore', 'pipe', 'pipe'],
            env: Object.assign({}, process.env,
              { ETA_SERVER_SECRET: 'env-seed' }) })
        const srv6 = await mod.startServer(path.join(ROOT, 'sub'), portS6,
          '127.0.0.1', { quiet: true, secret: 'env-seed' })
        try {
          let r1 = null
          for (let i = 0; i < 50; i++) {
            try {
              r1 = await fetch('http://127.0.0.1:' + portS5 +
                '/t_secret3.eta')
              break
            } catch (e) { await new Promise(r => setTimeout(r, 200)) }
          }
          assert.ok(r1, 'child server never came up')
          assert.strictEqual(await r1.text(), '1')
          const c1 = getSessionCookie(r1)
          assert.ok(c1)
          const r2 = await fetch('http://127.0.0.1:' + portS6 +
            '/t_secret3.eta', { headers: { Cookie: c1 } })
          assert.strictEqual(await r2.text(), '2',
            'env secret and option secret derived different keys')
        } finally {
          childS.kill()
          if (srv6.closeAllConnections) srv6.closeAllConnections()
          await new Promise(r => srv6.close(r))
        }
      })

    await check('session cookie name monopoly (setcookie dropped)', async () => {
      writeDemo('t_sessmono.eta',
        '<% _SESSION.k = 1 %><% RESP.setcookie("ETASESSION", "evil") %>ok')
      const res = await fetch(BASE + '/t_sessmono.eta')
      assert.strictEqual(res.status, 200)
      await res.text()
      const all = res.headers.getSetCookie
        ? res.headers.getSetCookie() : []
      const sess = all.filter((c) => c.startsWith('ETASESSION='))
      assert.strictEqual(sess.length, 1)
      assert.ok(sess[0].indexOf('evil') < 0)
    })

    await check('setcookie with non-numeric maxage omits Max-Age',
      async () => {
        writeDemo('t_maxage.eta',
          '<% RESP.setcookie("c", "v", {maxage: "abc"}) %>ok')
        const res = await fetch(BASE + '/t_maxage.eta')
        assert.strictEqual(res.status, 200)
        await res.text()
        const all = res.headers.getSetCookie
          ? res.headers.getSetCookie() : []
        const mine = all.filter((c) => c.startsWith('c='))
        assert.strictEqual(mine.length, 1)
        assert.ok(mine[0].indexOf('Max-Age') < 0, 'no Max-Age=NaN')
      })

    await check('hop-by-hop headers from templates are dropped',
      async () => {
        writeDemo('t_hop.eta',
          '<% RESP.header("Transfer-Encoding", "chunked") %>' +
          '<% RESP.header("Connection", "close") %>' +
          '<% RESP.header("X-Ok", "1") %>ok')
        const res = await fetch(BASE + '/t_hop.eta')
        assert.strictEqual(res.status, 200)
        await res.text()
        assert.strictEqual(res.headers.get('transfer-encoding'), null)
        // Node itself may emit its own Connection: keep-alive; the
        // point is the template's 'close' must not pass through
        assert.notStrictEqual(res.headers.get('connection'), 'close')
        assert.strictEqual(res.headers.get('x-ok'), '1')
      })

    await check('header names normalized: lowercase CT overrides, ' +
      'template CL dropped', async () => {
        // a case-sensitive assembly used to ship TWO Content-Length
        // lines here and undici rejected the whole response
        writeDemo('t_hdrnorm.eta',
          '<% RESP.header("content-type", "text/plain; charset=utf-8") %>' +
          '<% RESP.header("content-length", "999") %>' +
          '<% RESP.header("X-Dup", "a") %><% RESP.header("x-dup", "b") %>OK')
        const res = await fetch(BASE + '/t_hdrnorm.eta')
        assert.strictEqual(res.status, 200)
        const body = await res.text()
        assert.strictEqual(body, 'OK')
        assert.strictEqual(res.headers.get('content-type'),
          'text/plain; charset=utf-8')
        assert.strictEqual(res.headers.get('content-length'),
          String(Buffer.byteLength('OK')))
        assert.strictEqual(res.headers.get('x-dup'), 'b',
          'same name in different case must overwrite, not duplicate')
      })

    await check('list-based headers keep every value (Link)', async () => {
      writeDemo('t_multilink.eta',
        '<% RESP.header("Link", "<https://a.example>; rel=preconnect") %>' +
        '<% RESP.header("link", "<https://b.example>; rel=dns-prefetch") %>ok')
      const res = await fetch(BASE + '/t_multilink.eta')
      assert.strictEqual(res.status, 200)
      await res.text()
      const link = String(res.headers.get('link'))
      assert.ok(link.indexOf('<https://a.example>') >= 0)
      assert.ok(link.indexOf('<https://b.example>') >= 0)
    })

    await check('204 status strips body, Content-Length and Content-Type',
      async () => {
        writeDemo('t_204.eta', '<% RESP.status(204) %>leftover')
        const res = await fetch(BASE + '/t_204.eta')
        assert.strictEqual(res.status, 204)
        assert.strictEqual(res.headers.get('content-type'), null)
        assert.strictEqual(res.headers.get('content-length'), null)
        assert.strictEqual(await res.text(), '')
      })

    // ==================== RESP small parity items ====================

    await check('RESP.status(9999) gives 500', async () => {
      writeDemo('t_status.eta', '<% RESP.status(9999) %>x')
      const res = await fetch(BASE + '/t_status.eta')
      assert.strictEqual(res.status, 500)
      const body = await res.text()
      assert.ok(body.indexOf('invalid status') >= 0)
    })

    await check('RESP.escape works like escape()', async () => {
      writeDemo('t_respescape.eta', '<%~ RESP.escape("<a>&") %>')
      const res = await fetch(BASE + '/t_respescape.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), '&lt;a&gt;&amp;')
    })

    await check('RESP.status(0)/(100)/("abc") give 500', async () => {
      writeDemo('t_status0.eta', '<% RESP.status(0) %>x')
      writeDemo('t_statusabc.eta', '<% RESP.status("abc") %>x')
      writeDemo('t_status100.eta', '<% RESP.status(100) %>x')
      const r1 = await fetch(BASE + '/t_status0.eta')
      assert.strictEqual(r1.status, 500)
      await r1.text()
      const r2 = await fetch(BASE + '/t_statusabc.eta')
      assert.strictEqual(r2.status, 500)
      const body = await r2.text()
      assert.ok(body.indexOf('invalid status') >= 0)
      // 1xx is rejected: the buffered-body model has no meaningful
      // interim response, and Node used to emit a fake Content-Length
      // on a body it then dropped (decision #18)
      const r3 = await fetch(BASE + '/t_status100.eta')
      assert.strictEqual(r3.status, 500)
      const body3 = await r3.text()
      assert.ok(body3.indexOf('invalid status') >= 0)
    })

    await check('invalid header names/values fail at render time',
      async () => {
        // used to throw at res.writeHead() instead: an opaque 500 and
        // a mismatched status line ('HTTP/1.1 500 OK'); now the four
        // reachable channels fail during rendering with a coherent 500
        writeDemo('t_badhdr.eta',
          '<% if (_GET.k === "name") RESP.header("X Y", "v") %>' +
          '<% if (_GET.k === "value") RESP.header("X-Y", "a\\nb: c") %>' +
          '<% if (_GET.k === "cookie") RESP.setcookie("c", "v", ' +
          '{ domain: "a\\nb.com" }) %>' +
          '<% if (_GET.k === "redir") RESP.redirect("/a\\nb: c") %>ok')
        for (const k of ['name', 'value', 'cookie', 'redir']) {
          const res = await fetch(BASE + '/t_badhdr.eta?k=' + k)
          assert.strictEqual(res.status, 500, k)
          // the status line must agree with the code (no '500 OK')
          assert.strictEqual(res.statusText, 'Internal Server Error', k)
          const body = await res.text()
          assert.ok(body.indexOf('Internal Server Error') >= 0, k)
        }
        // the happy path is unaffected
        const ok = await fetch(BASE + '/t_badhdr.eta')
        assert.strictEqual(ok.status, 200)
        assert.strictEqual(await ok.text(), 'ok')
      })

    await check('Cache-Control: no-store by default, template wins',
      async () => {
        writeDemo('t_cc.eta', '<% RESP.header("Cache-Control", "max-age=60") %>ok')
        const r1 = await fetch(BASE + '/hello.eta')
        await r1.text()
        assert.strictEqual(r1.headers.get('cache-control'), 'no-store',
          'rendered pages must not be heuristically cacheable')
        const r2 = await fetch(BASE + '/style.css')
        await r2.text()
        assert.strictEqual(r2.headers.get('cache-control'), 'no-store',
          'static assets must not be heuristically cacheable')
        const r3 = await fetch(BASE + '/t_cc.eta')
        await r3.text()
        assert.strictEqual(r3.headers.get('cache-control'), 'max-age=60')
      })

    await check('writeraw chunks keep their order', async () => {
      writeDemo('t_raw.eta',
        '<% for (const s of ["a", "b", "c"]) RESP.writeraw(Buffer.from(s)) %>' +
        'discarded')
      const res = await fetch(BASE + '/t_raw.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), 'abc')
    })

    await check('RESP.write() / echo() interleave with template text', async () => {
      writeDemo('t_echo.eta',
        'A<% echo("X") %>B<% RESP.write("Y") %>C<%= "Z" %>')
      const res = await fetch(BASE + '/t_echo.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), 'AXBYCZ')
    })

    await check('echo() in a loop', async () => {
      writeDemo('t_echol.eta',
        '<% ["a","b","c"].forEach(function(x){ echo("[" + x + "]") }) %>')
      const res = await fetch(BASE + '/t_echol.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), '[a][b][c]')
    })

    await check('RESP.write() is short-circuited by writeraw', async () => {
      writeDemo('t_echoraw.eta',
        'before<% echo("dropped") %><% RESP.writeraw(Buffer.from("OK")) %>after')
      const res = await fetch(BASE + '/t_echoraw.eta')
      assert.strictEqual(res.status, 200)
      assert.strictEqual(await res.text(), 'OK')
    })

    await check('SERVER_NAME comes from the Host header', async () => {
      // CGI semantics: the name the client asked for, not the bind
      // address (which answered a useless '0.0.0.0' under -H 0.0.0.0)
      writeDemo('t_srvname.eta', '<%~ _SERVER.SERVER_NAME %>')
      const r = await rawGet(PORT, 'myapp.localhost:' + PORT, '/t_srvname.eta')
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.body, 'myapp.localhost')
    })

    await check('prototype-named query keys stay plain data', async () => {
      const res = await fetch(BASE +
        '/api.eta?__proto__=pwned&constructor=c&hasOwnProperty=h')
      assert.strictEqual(res.status, 200)
      const data = await res.json()
      assert.strictEqual(data.query.__proto__, 'pwned')
      assert.strictEqual(data.query.constructor, 'c')
      assert.strictEqual(data.query.hasOwnProperty, 'h')
    })

    await check('escaping index.eta/index.html fallbacks give 404', async () => {
      if (!SYMLINK_OK) {
        skip('escaping index.eta/index.html fallbacks give 404',
          'file symlinks need elevation / developer mode')
        return
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-out2-'))
      fs.writeFileSync(path.join(outDir, 'evil.eta'), 'EVIL <%= 1 %>')
      fs.writeFileSync(path.join(outDir, 'secret.html'), 'SECRET')
      const mk = (dir, link, target) => {
        fs.mkdirSync(path.join(ROOT, dir), { recursive: true })
        tmpDemoFiles.push(path.join(ROOT, dir))
        fs.symlinkSync(target, path.join(ROOT, dir, link))
      }
      try {
        mk('t_esc1', 'index.eta', path.join(outDir, 'evil.eta'))
        const r1 = await fetch(BASE + '/t_esc1/')
        await r1.text()
        assert.strictEqual(r1.status, 404, 'escaping index.eta')
        // fail-closed: an escaping index candidate is a 404 even when
        // a legit fallback file exists next to it (fail-closed)
        mk('t_esc2', 'index.eta', path.join(outDir, 'evil.eta'))
        fs.writeFileSync(path.join(ROOT, 't_esc2', 'index.html'), 'OK')
        const r2 = await fetch(BASE + '/t_esc2/')
        await r2.text()
        assert.strictEqual(r2.status, 404, 'escaping index.eta blocks dir')
        mk('t_esc3', 'index.html', path.join(outDir, 'secret.html'))
        const r3 = await fetch(BASE + '/t_esc3/')
        await r3.text()
        assert.strictEqual(r3.status, 404, 'escaping index.html')
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true })
      }
    })

    await check('.404.eta fallback renders custom 404 pages', async () => {
      writeDemo('.404.eta',
        '<% if (_GET.bad) RESP.status("abc") %>' +
        '<% if (_GET.big) _SESSION.blob = "x".repeat(5000) %>' +
        '<% if (_GET.hdr) RESP.header("X Y", "v") %>' +
        '<% if (_GET.val) RESP.header("X-Y", "a\\nb: c") %>' +
        '<% if (_GET.nos) _SESSION.bad = 10n %>' +
        'CUSTOM-404:<%~ _SERVER.REQUEST_URI %>' +
        ':qs=<%~ typeof _SERVER.QUERY_STRING %>')
      const res = await fetch(BASE + '/definitely-missing')
      assert.strictEqual(res.status, 404)
      const body = await res.text()
      assert.ok(body.indexOf('CUSTOM-404:/definitely-missing:qs=string') >= 0)
      // early-404 branches (device names / NUL bytes) must expose
      // QUERY_STRING to the fallback as well (decision #18)
      const r0 = await fetch(BASE + '/NUL?a=1')
      assert.strictEqual(r0.status, 404)
      assert.ok((await r0.text()).indexOf(':qs=string') >= 0)
      // post-render failures must ALSO degrade to the built-in 404:
      // the "never to a non-404" promise covers invalid status codes
      // and oversized sessions, not just render exceptions
      const rb = await fetch(BASE + '/definitely-missing?bad=1')
      assert.strictEqual(rb.status, 404)
      const bodyB = await rb.text()
      assert.ok(bodyB.indexOf('CUSTOM-404') < 0, 'must be the built-in page')
      assert.ok(bodyB.indexOf('Not Found') >= 0)
      const rg = await fetch(BASE + '/definitely-missing?big=1')
      assert.strictEqual(rg.status, 404)
      assert.ok((await rg.text()).indexOf('CUSTOM-404') < 0)
      // ...and invalid response headers (validated at RESP.header()
      // record time, decision #19), and a session value that cannot be
      // serialized at re-sign time (decision #22)
      for (const q of ['hdr=1', 'val=1', 'nos=1']) {
        const rh = await fetch(BASE + '/definitely-missing?' + q)
        assert.strictEqual(rh.status, 404, q)
        assert.ok((await rh.text()).indexOf('CUSTOM-404') < 0, q)
      }
      // rejected paths keep the same status (fail-closed)
      const r2 = await fetch(BASE + '/tests/../eta-server.js')
      assert.strictEqual(r2.status, 404)
      await r2.text()
      // the fallback file itself is hidden: no recursion, still 404
      const r3 = await fetch(BASE + '/.404.eta')
      assert.strictEqual(r3.status, 404)
      await r3.text()
    })

    await check('oversized body receives a real 413 response', async () => {
      const big = 'x'.repeat(64 * 1024 * 1024 + 1024)
      const res = await fetch(BASE + '/api.eta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: big,
      })
      assert.strictEqual(res.status, 413)
      const body = await res.text()
      assert.ok(body.indexOf('Payload Too Large') >= 0)
      // ...but a .404.eta page must never escalate its 404: the body
      // read is one more post-dispatch failure the fallback promise
      // has to cover (decision #20)
      const res2 = await fetch(BASE + '/definitely-missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: big,
      })
      assert.strictEqual(res2.status, 404,
        'over-cap POST to a missing path must stay a 404')
      await res2.text()
    })

    await check('concurrent requests keep their own parameters', async () => {
      // overlapping big POSTs widen the readBody await window while a
      // swarm of tagged GETs checks that no query ever crosses over
      const jobs = []
      const big = 'x'.repeat(4 * 1024 * 1024)
      for (let i = 0; i < 8; i++) {
        jobs.push(fetch(BASE + '/api.eta?post=' + i, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: big,
        }).then((r) => r.json()).then((d) => {
          assert.strictEqual(d.query.post, String(i))
        }))
      }
      for (let i = 0; i < 40; i++) {
        jobs.push(fetch(BASE + '/api.eta?tag=' + i)
          .then((r) => r.json()).then((d) => {
            assert.strictEqual(d.query.tag, String(i))
          }))
      }
      await Promise.all(jobs)
    })

    await check('access log line appears on stderr (CLF)', async () => {
      const res = await fetch(BASE + '/hello.eta')
      await res.text()
      await new Promise(r => setTimeout(r, 100))
      const re = /127\.0\.0\.1 - - \[[^\]]+\] "GET \/hello\.eta HTTP\/1\.1" 200 \d+ \d+ms/
      assert.ok(re.test(stderr), 'stderr missing CLF line for /hello.eta')
      // earlier requests were logged too (finish hook covers all branches)
      assert.ok(/"GET \/index\.eta HTTP\/1\.1" 200 /.test(stderr),
        'stderr missing CLF line for /index.eta')
    })

    await check('access log honors --access-log <file> (append)', async () => {
      const port3 = PORT + 2
      const BASE3 = 'http://127.0.0.1:' + port3
      const logFile = path.join(os.tmpdir(),
        'eta-test-access-' + Date.now() + '.log')
      const child3 = spawn(process.execPath,
        [SERVER, '-r', ROOT, '-p', String(port3), '--access-log', logFile],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let err3 = ''
      child3.stderr.on('data', (c) => { err3 += c.toString() })
      try {
        for (let i = 0; i < 50; i++) {
          try { await (await fetch(BASE3 + '/hello.eta')).text(); break }
          catch (e) { await new Promise(r => setTimeout(r, 200)) }
        }
        await new Promise(r => setTimeout(r, 150))
        const text = fs.readFileSync(logFile, 'utf8')
        assert.ok(/"GET \/hello\.eta HTTP\/1\.1" 200 \d+ \d+ms/.test(text),
          'access log file missing CLF line')
        // file destination diverts the log away from stderr
        assert.ok(!/"GET \/hello\.eta /.test(err3),
          'access log leaked to stderr despite --access-log')
      } finally {
        child3.kill()
        try { fs.rmSync(logFile) } catch (e) { }
      }
    })

    await check('--quiet silences the access log', async () => {
      const port4 = PORT + 3
      const BASE4 = 'http://127.0.0.1:' + port4
      const child4 = spawn(process.execPath,
        [SERVER, '-r', ROOT, '-p', String(port4), '--quiet'],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let out4 = ''
      let err4 = ''
      child4.stdout.on('data', (c) => { out4 += c.toString() })
      child4.stderr.on('data', (c) => { err4 += c.toString() })
      try {
        for (let i = 0; i < 50; i++) {
          try { await (await fetch(BASE4 + '/hello.eta')).text(); break }
          catch (e) { await new Promise(r => setTimeout(r, 200)) }
        }
        await new Promise(r => setTimeout(r, 150))
        assert.ok(!/" \d{3} \d+ \d+ms/.test(err4),
          'access log line found despite --quiet')
        assert.ok(!/" \d{3} \d+ \d+ms/.test(out4),
          'access log line found on stdout despite --quiet')
      } finally {
        child4.kill()
      }
    })

    await check('access log destination is per server instance', async () => {
      // regression: the destination used to be a module-level global,
      // so a second startServer({quiet:true}) silenced the first
      const mod = require(SERVER)
      const portA = PORT + 4
      const portB = PORT + 5
      const logA = path.join(os.tmpdir(), 'eta-iso-' + Date.now() + '.log')
      const srvA = await mod.startServer(ROOT, portA, '127.0.0.1',
        { accessLog: logA })
      const srvB = await mod.startServer(ROOT, portB, '127.0.0.1',
        { quiet: true })
      try {
        await (await fetch('http://127.0.0.1:' + portA +
          '/hello.eta')).text()
        await new Promise(r => setTimeout(r, 150))
        const text = fs.readFileSync(logA, 'utf8')
        assert.ok(/"GET \/hello\.eta HTTP\/1\.1" 200 \d+ \d+ms/.test(text),
          'instance A lost its access log after instance B started')
      } finally {
        if (srvA.closeAllConnections) srvA.closeAllConnections()
        if (srvB.closeAllConnections) srvB.closeAllConnections()
        await new Promise(r => srvA.close(r))
        await new Promise(r => srvB.close(r))
        try { fs.rmSync(logA) } catch (e) { }
      }
    })

    await check('aborted static download releases its fd (no leak)',
      async () => {
        // pipe() only unpipes when the client destroys the response;
        // without an explicit destroy the stream never ends and the
        // fd opened by sendStatic stays open (decision #18)
        writeDemo('t_big.zip', 'x'.repeat(512 * 1024))
        const mod = require(SERVER)
        const portC = PORT + 6
        const srv = await mod.startServer(ROOT, portC, '127.0.0.1',
          { quiet: true })
        let closes = 0
        const origClose = fs.close
        const origCloseSync = fs.closeSync
        fs.close = function (...a) { closes++; return origClose.apply(fs, a) }
        fs.closeSync = function (...a) { closes++; return origCloseSync.apply(fs, a) }
        try {
          const ctrl = new AbortController()
          try {
            const res = await fetch('http://127.0.0.1:' + portC +
              '/t_big.zip', { signal: ctrl.signal })
            const reader = res.body.getReader()
            await reader.read()        // one chunk, then bail out
            ctrl.abort()
          } catch (e) { /* AbortError expected */ }
          await new Promise(r => setTimeout(r, 400))
          assert.ok(closes >= 1,
            'fd not released after client abort (closes=' + closes + ')')
        } finally {
          fs.close = origClose
          fs.closeSync = origCloseSync
          if (srv.closeAllConnections) srv.closeAllConnections()
          await new Promise(r => srv.close(r))
        }
      })
  } finally {
    for (const f of tmpDemoFiles) {
      try { fs.rmSync(f, { recursive: true, force: true }) } catch (e) { }
    }
    child.kill()
  }

  console.log('')
  console.log('passed: ' + passed + ', failed: ' + failed +
    ', skipped: ' + skipped)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
