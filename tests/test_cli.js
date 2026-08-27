/* =====================================================================
 *
 * test_cli.js - CLI rendering mode tests for eta-server.js
 *
 * Covers: file render to stdout, argv passthrough, stdin '-' render,
 * degraded _SERVER keys, include base dir, writeraw/json shortcuts,
 * BOM tolerance, error paths (missing file, render failure -> exit 1).
 * Requires Node 18+.
 *
 * Created by skywind on 2026/08/18
 * Last Modified: 2026/08/27 23:40:00
 *
 * ===================================================================== */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert')

const SERVER = path.join(__dirname, '..', 'eta-server.js')

let passed = 0
let failed = 0
let tmpdir = null

function check (name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (err) {
    failed++
    console.log('  FAIL  ' + name)
    console.log('        ' + String(err && err.message || err))
  }
}

// run "node eta-server.js <args>", optional stdin text, optional cwd
function run (args, stdinText, cwd) {
  const res = spawnSync(process.execPath, [SERVER].concat(args), {
    input: stdinText === undefined ? undefined : stdinText,
    cwd: cwd || tmpdir,
    encoding: 'utf8',
  })
  return { code: res.status, out: res.stdout, err: res.stderr }
}

function writeTmp (name, text) {
  const p = path.join(tmpdir, name)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}

function main () {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-cli-'))
  console.log('CLI rendering mode:')

  const basic = writeTmp('basic.eta',
    'hello <%= _SERVER.REQUEST_METHOD %>')

  check('file renders to stdout', () => {
    const r = run([basic])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'hello GET')
    assert.strictEqual(r.err, '')
  })

  check('argv passthrough (argv[0] = script, rest verbatim)', () => {
    const p = writeTmp('argv.eta',
      '<%~ _SERVER.argv.join("|") %>')
    const r = run([p, 'one', '--two', '-H', 'x'])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, p + '|one|--two|-H|x')
  })

  check('degraded _SERVER keys', () => {
    const p = writeTmp('keys.eta',
      '<%~ _SERVER.SCRIPT_NAME %>;<%~ _SERVER.SCRIPT_FILENAME %>;' +
      '<%~ _SERVER.SCRIPT_DIRNAME %>;<%~ _SERVER.QUERY_STRING %>;' +
      '<%~ _SERVER.PATH_INFO %>;<%~ _SERVER.REQUEST_TIME %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    const parts = r.out.split(';')
    assert.strictEqual(parts[0], p)
    assert.strictEqual(parts[1], p)
    assert.strictEqual(parts[2], tmpdir)
    assert.strictEqual(parts[3], '')
    assert.strictEqual(parts[4], '')
    assert.ok(/^\d+$/.test(parts[5]), 'REQUEST_TIME is seconds')
  })

  check('bridge degraded: empty GET/POST/SESSION/BODY, no REQUEST_URI', () => {
    const p = writeTmp('bridge.eta',
      '<%~ JSON.stringify(_GET) %><%~ JSON.stringify(_POST) %>' +
      '<%~ _BODY.length %><%~ _JSON %><%~ ("REQUEST_URI" in _SERVER) %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '{}{}0nullfalse')
  })

  check('extension not enforced (.txt renders too)', () => {
    const p = writeTmp('script.txt', 'plain <%= 1 + 1 %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'plain 2')
  })

  check('no such file -> stderr + exit 1', () => {
    const r = run(['nope.eta'])
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.out, '')
    assert.ok(r.err.indexOf('no such file') >= 0)
  })

  check('render error -> stderr + exit 1, stdout clean', () => {
    const p = writeTmp('bad.eta', 'prefix<%= undefinedFn() %>')
    const r = run([p])
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.out, '')
    assert.ok(r.err.indexOf('undefinedFn') >= 0)
  })

  check('include resolves against the script directory', () => {
    writeTmp(path.join('inc', 'part.eta'), 'INCLUDED')
    const p = writeTmp(path.join('inc', 'main.eta'),
      '<%~ include("./part") %>!')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'INCLUDED!')
  })

  check('require anchored at script directory', () => {
    writeTmp(path.join('req', 'lib.js'), 'module.exports = 42')
    const p = writeTmp(path.join('req', 'main.eta'),
      '<%~ require("./lib.js") %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '42')
  })

  check('RESP.writeraw short-circuits text', () => {
    const p = writeTmp('raw.eta',
      'text<%~ RESP.writeraw(Buffer.from([0x41, 0x42])) %>more')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'AB')
  })

  check('echo() interleaves with template text', () => {
    const p = writeTmp('echo.eta',
      'A<% echo("X") %>B<% RESP.write("Y") %>C<%~ "Z" %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'AXBYCZ')
  })

  check('echo() in a loop', () => {
    const p = writeTmp('echol.eta',
      '<% ["a","b","c"].forEach(function(x){ echo("[" + x + "]") }) %>')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '[a][b][c]')
  })

  check('RESP.json short-circuits rendered text', () => {
    const p = writeTmp('json.eta',
      '<%~ RESP.json({ok: 1}) %>ignored')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '{"ok":1}')
  })

  check('RESP header/status are no-ops (no crash, no effect)', () => {
    const p = writeTmp('noop.eta',
      '<% RESP.status(302) %><% RESP.header("X", "y") %>' +
      '<% RESP.redirect("/x") %><% RESP.setcookie("c", "v") %>done')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'done')
  })

  check('BOM is tolerated (file)', () => {
    const p = writeTmp('bom.eta', '\ufeffBOM-ok')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'BOM-ok')
  })

  check('trailing newline preserved (no rstrip)', () => {
    const p = writeTmp('tail.eta', 'end\n')
    const r = run([p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'end\n')
  })

  check('server options before the script are accepted', () => {
    const p = writeTmp('opt.eta', 'ok')
    const r = run(['-r', tmpdir, '-p', '5999', p])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'ok')
  })

  // ---- stdin mode ----

  check('stdin "-" renders', () => {
    const r = run(['-'], 'hello <%~ _SERVER.argv[0] %>')
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'hello -')
  })

  check('stdin _SERVER keys: SCRIPT_NAME/FILENAME "-", DIRNAME cwd', () => {
    const r = run(['-'],
      '<%~ _SERVER.SCRIPT_NAME %>;<%~ _SERVER.SCRIPT_FILENAME %>;' +
      '<%~ _SERVER.SCRIPT_DIRNAME %>')
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '-;-;' + tmpdir)
  })

  check('stdin argv[0] = "-", rest passthrough', () => {
    const r = run(['-', 'a', '-b'], '<%~ _SERVER.argv.join(",") %>')
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, '-,a,-b')
  })

  check('stdin include/require resolve against cwd', () => {
    writeTmp('part.eta', 'CWD-PART')
    writeTmp('stdinlib.js', 'module.exports = 7')
    const r1 = run(['-'], '<%~ include("./part") %>')
    assert.strictEqual(r1.code, 0)
    assert.strictEqual(r1.out, 'CWD-PART')
    const r2 = run(['-'], '<%~ require("./stdinlib.js") %>')
    assert.strictEqual(r2.code, 0)
    assert.strictEqual(r2.out, '7')
  })

  check('stdin render error -> exit 1, stdout clean', () => {
    const r = run(['-'], '<%~ noSuchFn() %>')
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.out, '')
    assert.ok(r.err.indexOf('noSuchFn') >= 0)
  })

  check('stdin BOM tolerated', () => {
    const r = run(['-'], '\ufeffBOM-STDIN')
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'BOM-STDIN')
  })

  check('--secret rejects a missing or blank value', () => {
    // a blank secret would look configured while silently falling back
    // to the automatic key (decision #21)
    const r1 = run(['--secret'])
    assert.strictEqual(r1.code, 1)
    assert.ok(r1.err.indexOf('missing value for --secret') >= 0, r1.err)
    const r2 = run(['--secret', '   '])
    assert.strictEqual(r2.code, 1)
    assert.ok(r2.err.indexOf('empty value for --secret') >= 0, r2.err)
  })

  check('--secret before a script is accepted and ignored (CLI mode)', () => {
    writeTmp('sec.eta', 'SEC-OK')
    const r = run(['--secret', 'abc', path.join(tmpdir, 'sec.eta')])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'SEC-OK')
  })

  check('--allow-uploads before a script is accepted and ignored (CLI mode)', () => {
    // CLI mode has no request body, so the flag is meaningless there —
    // but accepting it keeps the "options before the script name"
    // leniency uniform (PHP-style, decision #11)
    writeTmp('aup.eta', 'AUP-OK')
    const r = run(['--allow-uploads', path.join(tmpdir, 'aup.eta')])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'AUP-OK')
  })

  check('--session-ttl validates its value', () => {
    // invalid values are rejected up front, never a silent fallback to
    // the 30-minute default (decision #24)
    const r1 = run(['--session-ttl', 'abc'])
    assert.strictEqual(r1.code, 1)
    assert.ok(r1.err.indexOf('invalid session TTL') >= 0, r1.err)
    const r2 = run(['--session-ttl', '0'])
    assert.strictEqual(r2.code, 1)
    const r3 = run(['--session-ttl'])
    assert.strictEqual(r3.code, 1)
    assert.ok(r3.err.indexOf('missing value for --session-ttl') >= 0, r3.err)
  })

  check('RESP.info() renders plain text in CLI mode', () => {
    const r = run([path.join(__dirname, '..', 'demo', 'etainfo.eta')])
    assert.strictEqual(r.code, 0)
    assert.ok(r.out.indexOf('[System]') >= 0)
    assert.ok(r.out.indexOf('eta-server Version =>') >= 0)
    assert.ok(r.out.indexOf('[This Request (_SERVER)]') >= 0)
    assert.ok(r.out.indexOf('REQUEST_METHOD => GET') >= 0)
    assert.ok(r.out.indexOf('<!DOCTYPE') < 0, 'CLI output must not be HTML')
  })

  fs.rmSync(tmpdir, { recursive: true, force: true })

  console.log('\n%d passed, %d failed', passed, failed)
  if (failed > 0) process.exit(1)
}

main()
