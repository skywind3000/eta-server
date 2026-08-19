#! /usr/bin/env node
/* =====================================================================
 *
 * eta-server.js - PHP-style dev server for .eta templates
 *
 * File path is route: drop a .eta file in the document root and it
 * becomes a page, no server code changes needed.  Bridge API mirrors
 * PHP superglobals (_GET / _POST / _SERVER / _SESSION / ...).
 *
 * Usage:
 *   eta-server -r <root> -p <port> [-H <host>]
 *   eta-server [options] script.eta [args...]   # CLI render, result to stdout
 *   eta-server [options] - [args...]            # read the script from stdin
 *
 * Created by skywind on 2026/02/16
 * Last Modified: 2026/08/19 22:00:00
 *
 * ===================================================================== */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { createRequire } = require('node:module')
const { Eta } = require('eta')

const VERSION = '0.3.2'
const MAX_BODY = 64 * 1024 * 1024
const SESSION_COOKIE = 'etasess'
const SESSION_TTL = 30 * 60 * 1000          // sliding timeout: 30 min
// cookie capacity guard: an oversized session
// cookie is silently dropped by browsers anyway; fail loudly instead
const SESSION_COOKIE_LIMIT = 4096
const SELF_PATH = path.resolve(__filename)
// realpath of our own file: realpath also expands 8.3 short names
// (ETASE~1.JS), so comparing resolved paths covers them. Note
// realpathSync does NOT normalize case on case-insensitive file
// systems, hence isSelfPath() below compares case-insensitively
const SELF_PATH_REAL = (() => {
  try { return fs.realpathSync(SELF_PATH) } catch (e) { return SELF_PATH }
})()

// self-protection predicate: case-insensitive on EVERY platform, not
// just win32 — macOS APFS (default configuration) and case-insensitive
// mounts on Linux (NTFS / exFAT / Docker Desktop binds) also open
// 'ETA-SERVER.js' for 'eta-server.js', and realpath normalizes case
// on none of them. Worst case: a same-directory file differing only
// in case from the server's own name gets one extra 404
function isSelfPath (p) {
  const lp = String(p).toLowerCase()
  return lp === SELF_PATH.toLowerCase() ||
    lp === SELF_PATH_REAL.toLowerCase()
}

// extension whitelist for static files (fail-closed outside this table);
// null-prototype dict (decision #14 parity)
const STATIC_TYPES = Object.assign(Object.create(null), {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.xz': 'application/x-xz',
})

const HTML_SPECIAL = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}

// RFC 7230 hop-by-hop semantics are owned by the framework: a template
// setting these would clash with the buffered-body Content-Length model
// (e.g. CL + TE double headers, a request-smuggling surface), so they
// are dropped with a stderr warning at response assembly time;
// null-prototype dict, otherwise RESP.header('constructor', ...) would
// hit the inherited Object.prototype member (decision #14 parity)
const HOP_BY_HOP_HEADERS = Object.assign(Object.create(null), {
  'connection': 1, 'keep-alive': 1, 'proxy-authenticate': 1,
  'proxy-authorization': 1, 'te': 1, 'trailer': 1,
  'transfer-encoding': 1, 'upgrade': 1,
})

// list-based response headers that legitimately carry multiple
// values: repeated RESP.header() calls accumulate (emitted joined by
// ', ' per RFC 9110 list syntax) instead of the usual last-write-wins;
// null-prototype dict (decision #14 parity)
const MULTI_VALUE_HEADERS = Object.assign(Object.create(null), {
  'link': 1, 'www-authenticate': 1, 'proxy-authenticate': 1,
})

/* ---------------------------------------------------------------------
 * utilities
 * ------------------------------------------------------------------- */

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, c => HTML_SPECIAL[c])
}

// utf-8-sig semantics: tolerate a leading BOM (file and stdin alike)
function stripBom (text) {
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1)
  return text
}

function errorPage (code, title, detail) {
  let body = '<!DOCTYPE html>\n<html><head><meta charset="utf-8">'
  body += '<title>' + code + ' ' + escapeHtml(title) + '</title>'
  body += '<style>body{font-family:monospace;margin:2em}'
  body += 'pre{background:#f5f5f5;padding:1em;overflow:auto}</style></head>'
  body += '<body><h1>' + code + ' ' + escapeHtml(title) + '</h1>'
  if (detail) body += '<pre>' + escapeHtml(detail) + '</pre>'
  body += '<hr><p>eta-server ' + VERSION + '</p></body></html>\n'
  return body
}

function sendError (res, code, title, detail) {
  if (res.headersSent) {
    try { res.destroy() } catch (e) { /* ignore */ }
    return
  }
  const body = errorPage(code, title, detail)
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(req_HEAD(res) ? undefined : body)
}

function req_HEAD (res) {
  return res.req && res.req.method === 'HEAD'
}

// per-user persistent random master secret: ~/.eta-server-secret
// (mode 0600). The old design derived the secret from a machine
// fingerprint including every NIC MAC — but os.networkInterfaces()
// only reports currently-active interfaces, so starting/stopping WSL
// or VMware, connecting a VPN or unplugging a cable changed the MAC
// set and silently invalidated every session. A persisted random
// secret is immune to all of that, and keeps sessions valid across
// server restarts as a bonus. Falls back to a diskless fingerprint
// (hostname / user / home — deliberately WITHOUT MACs) when the home
// directory is not writable.
let masterSecret = null

function fingerprintSeed () {
  let username = ''
  let home = ''
  try {
    const info = os.userInfo()
    username = info.username || ''
    home = info.homedir || ''
  } catch (e) {
    home = os.homedir()
  }
  return ['eta-server', os.hostname(), username, home].join('|')
}

function loadMasterSecret () {
  if (masterSecret) return masterSecret
  let dir = ''
  try {
    dir = path.join(os.homedir(), '.eta-server')
  } catch (e) {
    dir = ''
  }
  if (dir) {
    const file = path.join(dir, 'session-secret')
    try {
      const text = fs.readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{64}$/.test(text)) {
        masterSecret = text
        return masterSecret
      }
    } catch (e) { /* not created yet */ }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const fresh = crypto.randomBytes(32).toString('hex')
      // 0600: the secret must not be world-readable (the mode is a
      // no-op on Windows, which protects the profile directory itself)
      fs.writeFileSync(file, fresh + '\n', { mode: 0o600 })
      masterSecret = fresh
      return masterSecret
    } catch (e) { /* fall through to the fingerprint below */ }
  }
  console.error('eta-server: warning: cannot persist a session secret ' +
    'in the home directory; falling back to a machine fingerprint')
  masterSecret = crypto.createHash('sha256')
    .update(fingerprintSeed()).digest('hex')
  return masterSecret
}

// stable per-site secret: HMAC of the document root's realpath keyed
// by the master secret — same machine, different roots get different
// secrets, so a session cookie from site A never verifies on site B
// even when both run on this host (per-site isolation kept from the
// fingerprint design)
function deriveSecret (rootDir) {
  let rootReal = ''
  try {
    rootReal = fs.realpathSync(rootDir)
  } catch (e) {
    rootReal = path.resolve(rootDir)
  }
  return crypto.createHmac('sha256', loadMasterSecret())
    .update('eta-server-session|' + rootReal).digest('hex')
}

// percent-encode a decoded path for use in a Location header (each
// segment separately so '/' separators survive); search kept raw
function encodeLocationPath (p) {
  return p.split('/').map(encodeURIComponent).join('/')
}

function signPayload (secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

function encodeSession (data, secret) {
  const payload = JSON.stringify({ d: data, e: Date.now() + SESSION_TTL })
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  return b64 + '.' + signPayload(secret, b64)
}

// returns the session dict, or null if missing / tampered / expired
function decodeSession (cookie, secret) {
  if (!cookie || typeof cookie !== 'string') return null
  const i = cookie.lastIndexOf('.')
  if (i <= 0) return null
  const b64 = cookie.slice(0, i)
  const sig = cookie.slice(i + 1)
  const expect = signPayload(secret, b64)
  if (sig.length !== expect.length) return null
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expect)
    if (!crypto.timingSafeEqual(a, b)) return null
  } catch (e) {
    return null
  }
  let payload = null
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
  } catch (e) {
    return null
  }
  if (!payload || typeof payload.e !== 'number') return null
  if (payload.e < Date.now()) return null
  if (!payload.d || typeof payload.d !== 'object') return null
  return payload.d
}

function parseCookies (header) {
  const out = Object.create(null)
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const key = part.slice(0, i).trim()
    const val = part.slice(i + 1).trim()
    if (!key || (key in out)) continue
    try {
      out[key] = decodeURIComponent(val)
    } catch (e) {
      out[key] = val
    }
  }
  return out
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (chunk) => {
      if (over) return
      size += chunk.length
      if (size > MAX_BODY) {
        // keep draining the socket (bounded memory) and only reply
        // once the client finishes uploading: destroying the socket
        // here would hand the client an ECONNRESET with no response
        over = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (over) {
        const err = new Error('request body too large')
        err.status = 413
        reject(err)
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function parseForm (buf) {
  const out = Object.create(null)
  const sp = new URLSearchParams(buf.toString('utf8'))
  for (const pair of sp.entries()) {
    out[pair[0]] = pair[1]
  }
  return out
}

/* ---------------------------------------------------------------------
 * access log (decision #16)
 * ------------------------------------------------------------------- */

// HTTP-mode access log, one Common Log Format line per completed
// request, written from the response 'finish' event (single hook that
// covers every dispatcher branch — template, static, redirect, error).
// Destination defaults to stderr (stdout stays clean in every mode,
// including piping); --access-log <file> appends to a file; --quiet
// silences it. The destination is per server instance (stored on ctx
// at startServer time), not a process global: a second startServer()
// in the same process must not silently redirect the first server's
// log. Immutable startup config, not per-request state (decision #14).
const LOG_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2 (n) {
  return n < 10 ? '0' + n : String(n)
}

// Apache / NCSA timestamp: [19/Aug/2026:10:23:45 +0800]
function formatCltTime (d) {
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return pad2(d.getDate()) + '/' + LOG_MONTHS[d.getMonth()] + '/' +
    d.getFullYear() + ':' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) +
    ':' + pad2(d.getSeconds()) + ' ' + sign +
    pad2(Math.floor(abs / 60)) + pad2(abs % 60)
}

// Content-Length cannot be read back from res after
// writeHead(code, headersObject): getHeader() only sees headers set
// through the setHeader() API. So the finish hook below captures it
// here, when writeHead is called — every response branch goes through
// writeHead, and the few object-less calls (301 / 308 / 405) carry an
// empty body, hence the 0 default
function responseBytes (state) {
  return state.bytes
}

function trackWriteHead (res, state) {
  const orig = res.writeHead
  res.writeHead = function (...args) {
    for (const a of args) {
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        for (const k of Object.keys(a)) {
          if (k.toLowerCase() === 'content-length') {
            state.bytes = Number(a[k]) || 0
          }
        }
      }
    }
    return orig.apply(res, args)
  }
}

function accessLine (req, res, state, start) {
  const remote = (req.socket && req.socket.remoteAddress) || '-'
  const ms = Date.now() - start
  return remote + ' - - [' + formatCltTime(new Date(start)) + '] "' +
    req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '" ' +
    res.statusCode + ' ' + responseBytes(state) + ' ' + ms + 'ms'
}

// open the --access-log destination: '-' means stdout, anything else
// is a file opened in append mode (write errors are reported once,
// never crash the server)
function openAccessLog (spec) {
  if (spec === '-') return process.stdout
  if (!spec) return process.stderr
  const stream = fs.createWriteStream(spec, { flags: 'a' })
  stream.once('error', (err) => {
    console.error('eta-server: access log write error: ' + err.message)
  })
  return stream
}

/* ---------------------------------------------------------------------
 * path hardening helpers
 * ------------------------------------------------------------------- */

// Windows reserved device names, with or without an extension
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

// a path segment that Win32 cannot open as a regular file: ADS colon
// (foo.txt::$DATA, foo:bar) or a reserved device name
function win32BadSegment (name) {
  if (name.indexOf(':') >= 0) return true
  return DEVICE_NAME.test(name)
}

// containment check: p equals root or lives strictly inside it.
// The first-segment test (rather than a '..' prefix test) keeps legal
// names like '..b' servable: path.relative reports '..b.eta' for them,
// which a startsWith('..') check would mistake for an escape
function containsPath (root, p) {
  if (p === root) return true
  const rel = path.relative(root, p)
  if (rel === '' || path.isAbsolute(rel)) return false
  return rel.split(path.sep)[0] !== '..'
}

// realpath containment: resolve symlinks / junctions, reject anything
// whose real location lives outside the real document root. Returns
// the real path, or null when missing / escaping.
function realInside (rootReal, abs) {
  let real = null
  try {
    real = fs.realpathSync(abs)
  } catch (e) {
    return null
  }
  return containsPath(rootReal, real) ? real : null
}

// hidden-path convention (decision #17, re-chosen in #18): segments
// starting with '.' plus node_modules directories (matched case-
// insensitively — win32 / APFS open 'NODE_MODULES' as 'node_modules',
// and realpathSync normalizes case on neither) are never served: not
// as templates, not as static files, not as directory indexes,
// fail-closed 404. '.well-known' is exempt (RFC 8615: ACME challenges,
// apple-app-site-association). Underscore prefixes are deliberately
// PUBLIC: mainstream build tools emit them (_next/, _astro/, _nuxt/,
// _app/, _static/) and "drop a static export into the docroot" is the
// most common usage — the original underscore rule silently 404'd
// every asset there. Server-side files belong behind dot names instead
// (.config.json, .lib/util.ts — .ts is outside the static whitelist
// anyway). Every block logs one stderr line (decision #18), so a
// mysterious 404 is diagnosable at a glance. The .404.eta fallback
// page is unroutable by the same dot rule.
function isPrivateSegment (seg) {
  // the exemption folds case like the node_modules match beside it
  // (fail-closed either way — ACME only uses lowercase)
  if (seg.toLowerCase() === '.well-known') return false
  return seg.toLowerCase() === 'node_modules' || seg.charAt(0) === '.'
}

// one stderr line per hidden-path 404: turns "why does this 404?"
// from archaeology into a glance (decision #18)
function logBlocked (req) {
  console.error('eta-server: blocked by hidden-path convention: ' +
    req.method + ' ' + req.url)
}

// URL level: pathname always starts with '/', the empty first segment
// never matches
function isPrivatePathname (pathname) {
  for (const seg of pathname.split('/')) {
    if (isPrivateSegment(seg)) return true
  }
  return false
}

// realpath level: relative against the real root, catching symlinks
// inside the root whose TARGET lives under a private name
function isPrivateReal (rootReal, real) {
  if (real === rootReal) return false
  const rel = path.relative(rootReal, real)
  if (rel === '' || path.isAbsolute(rel)) return true   // fail-closed
  return isPrivatePathname('/' + rel.split(path.sep).join('/'))
}

/* ---------------------------------------------------------------------
 * response control object injected into templates as RESP
 * ------------------------------------------------------------------- */

function makeResp (defaultStatus) {
  const resp = {
    // fallback pages (_404.eta) start at 404 instead of 200; the
    // script may still override with RESP.status()
    code: defaultStatus || 200,
    headers: [],                 // list of [name, value] pairs
    binary: null,                // writeraw buffer, null until touched
    text: null,                  // RESP.json() body, null until set
    header: function (name, value) {
      resp.headers.push([String(name), String(value)])
    },
    status: function (code) {
      // stored raw: validated at assembly time (non 100-999 integer
      // becomes a 500); coercing here
      // would silently turn status('abc') / status(0) into 200
      resp.code = code
    },
    redirect: function (url, code) {
      resp.code = code || 302
      resp.headers.push(['Location', String(url)])
    },
    setcookie: function (name, value, opts) {
      // session cookie name monopoly: a script
      // setcookie() with the session name would fight the framework
      // over the same cookie; drop the script's line and warn
      if (String(name) === SESSION_COOKIE) {
        console.error('eta-server: warning: RESP.setcookie() with the ' +
          'session cookie name "' + SESSION_COOKIE + '" is ignored')
        return
      }
      opts = opts || {}
      let s = encodeURIComponent(name) + '=' + encodeURIComponent(String(value))
      if (opts.maxage != null) {
        // non-numeric maxage ('abc' -> NaN) is ignored rather than
        // shipped as 'Max-Age=NaN'
        const ma = Math.floor(Number(opts.maxage))
        if (Number.isFinite(ma)) s += '; Max-Age=' + ma
      }
      if (opts.expires) {
        const exp = opts.expires.toUTCString
          ? opts.expires.toUTCString() : String(opts.expires)
        s += '; Expires=' + exp
      }
      s += '; Path=' + (opts.path || '/')
      if (opts.domain) s += '; Domain=' + opts.domain
      s += '; SameSite=' + (opts.samesite || 'Lax')
      if (opts.httponly !== false) s += '; HttpOnly'
      if (opts.secure) s += '; Secure'
      resp.headers.push(['Set-Cookie', s])
    },
    json: function (data) {
      resp.header('Content-Type', 'application/json; charset=utf-8')
      resp.text = JSON.stringify(data)
    },
    writeraw: function (chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new TypeError('RESP.writeraw() only accepts bytes')
      }
      const buf = Buffer.from(chunk)
      resp.binary = resp.binary ? Buffer.concat([resp.binary, buf]) : buf
    },
    write: function () {
      // no-op alias: in eta, output goes through template text / <%= %>
      throw new Error('use template text or <%= %> for output')
    },
    escape: escapeHtml,
  }
  return resp
}

/* ---------------------------------------------------------------------
 * hot reload for require()'d local files
 * ------------------------------------------------------------------- */

// Node's module cache is process-wide: every createRequire instance
// shares it, so libraries loaded by a template would survive edits
// until a restart — defeating the "edits take effect immediately"
// promise for the recommended thin-template + .ts-library split.
// Track the mtime seen at load time for files under the document root
// and drop the cache entry when the file on disk becomes newer.
// node_modules and out-of-root files stay cached (reloading framework
// dependencies mid-flight is unsafe). Invalidation is shallow: only
// the entry itself is dropped — cached parents keep their old
// references (see known limitations).
const hotMtimes = new Map()

function makeDevRequire (rootReal, scriptAbs) {
  const base = createRequire(scriptAbs)
  const devRequire = function (spec) {
    let resolved = null
    try { resolved = base.resolve(String(spec)) } catch (e) { /* below */ }
    if (resolved && containsPath(rootReal, resolved)) {
      let mtimeMs = -1
      try { mtimeMs = fs.statSync(resolved).mtimeMs } catch (e) { /* -1 */ }
      if (mtimeMs >= 0) {
        const seen = hotMtimes.get(resolved)
        if (seen !== undefined && mtimeMs > seen) {
          delete require.cache[resolved]
        }
        hotMtimes.set(resolved, mtimeMs)
      }
    }
    return base(spec)
  }
  devRequire.resolve = base.resolve
  devRequire.resolve.paths = base.resolve.paths
  devRequire.cache = require.cache
  return devRequire
}

/* ---------------------------------------------------------------------
 * template rendering pipeline
 * ------------------------------------------------------------------- */

function buildServerEnv (req, parsed, scriptAbs, scriptName, pathInfo, ctx,
  reqStart) {
  const headers = req.headers
  // request-start instant captured at dispatcher entry (PHP semantics:
  // REQUEST_TIME marks the arrival of the request, not the moment the
  // body upload finished)
  const now = reqStart || Date.now()
  const env = Object.create(null)
  Object.assign(env, {
    REQUEST_METHOD: req.method,
    QUERY_STRING: parsed.queryString,
    REQUEST_URI: req.url,
    SCRIPT_NAME: scriptName,
    PATH_INFO: pathInfo,
    SCRIPT_FILENAME: scriptAbs,
    SCRIPT_DIRNAME: path.dirname(scriptAbs),
    DOCUMENT_ROOT: ctx.root,
    REMOTE_ADDR: req.socket.remoteAddress || '',
    CONTENT_TYPE: headers['content-type'] || '',
    CONTENT_LENGTH: headers['content-length'] || '',
    SERVER_NAME: ctx.host,
    SERVER_PORT: String(ctx.port),
    REQUEST_SCHEME: 'http',
    SERVER_PROTOCOL: 'HTTP/' + (req.httpVersion || '1.1'),
    REQUEST_TIME: Math.floor(now / 1000),
    REQUEST_TIME_FLOAT: now / 1000,
  })
  for (const key of Object.keys(headers)) {
    const name = 'HTTP_' + key.toUpperCase().replace(/-/g, '_')
    if (!(name in env)) env[name] = String(headers[key])
  }
  return env
}

async function renderTemplate (req, res, ctx, parsed, scriptAbs, scriptName,
  pathInfo, reqStart, opts) {
  opts = opts || {}
  let bodyBuf = Buffer.alloc(0)
  try {
    bodyBuf = await readBody(req)
  } catch (err) {
    if (err.status === 413) {
      return sendError(res, 413, 'Payload Too Large', err.message)
    }
    return sendError(res, 400, 'Bad Request', err.message)
  }

  const query = Object.create(null)
  for (const pair of parsed.searchParams.entries()) {
    query[pair[0]] = pair[1]
  }

  let post = Object.create(null)
  let jsonVal = null
  const ctype = String(req.headers['content-type'] || '')
  if (ctype.indexOf('multipart/form-data') >= 0) {
    // _FILES is phase two; without this line a multipart form would
    // "submit successfully" with every parameter silently missing
    console.error('eta-server: warning: multipart/form-data body is not ' +
      'parsed (no _FILES yet); _POST stays empty, raw bytes in _BODY')
  } else if (ctype.indexOf('application/x-www-form-urlencoded') >= 0) {
    post = parseForm(bodyBuf)
  } else if (ctype.indexOf('json') >= 0) {
    // any json-ish content type (application/json, application/*+json,
    // text/json) is parsed
    try {
      jsonVal = JSON.parse(bodyBuf.toString('utf8'))
    } catch (e) {
      jsonVal = null
    }
  }

  const cookies = parseCookies(req.headers['cookie'])
  const session = decodeSession(cookies[SESSION_COOKIE], ctx.secret) || {}
  const hadSessionCookie = (SESSION_COOKIE in cookies)

  const resp = makeResp(opts.defaultStatus)
  const data = {
    _GET: query,
    _POST: post,
    _REQUEST: Object.assign(Object.create(null), query, post),
    _SERVER: buildServerEnv(req, parsed, scriptAbs, scriptName, pathInfo,
      ctx, reqStart),
    _COOKIE: cookies,
    _SESSION: session,
    _BODY: bodyBuf,
    _JSON: jsonVal,
    RESP: resp,
    escape: escapeHtml,
    require: makeDevRequire(ctx.rootReal, scriptAbs),
  }

  let html = ''
  try {
    // read the file ourselves and render the string: bypasses eta's
    // file resolution quirks and gives mtime-based reload for free
    const src = stripBom(fs.readFileSync(scriptAbs, 'utf8'))
    html = await ctx.eta.renderStringAsync(src, data)
  } catch (err) {
    if (opts.plain404OnError) {
      // fallback pages must never turn a 404 into anything else —
      // but do not swallow the template bug silently (decision #18)
      console.error('eta-server: fallback page crashed, degrading to ' +
        'the built-in 404: ' + ((err && err.stack) ? err.stack : err))
      return sendError(res, 404, 'Not Found')
    }
    const detail = (err && err.stack) ? err.stack : String(err)
    return sendError(res, 500, 'Internal Server Error', detail)
  }

  // ---- status validation: checked
  // right after rendering, before session re-signing, so an invalid
  // code wastes neither the session update nor the response. The 1xx
  // class is rejected too (decision #18): a buffered-body model has
  // no meaningful interim response, and Node used to emit a fake
  // Content-Length on a body it then dropped ----
  if (!Number.isInteger(resp.code) || resp.code < 200 || resp.code > 999) {
    if (opts.plain404OnError) {
      // the spec promise holds past rendering too: a fallback page
      // must never turn a 404 into a non-404 (decision #18)
      console.error('eta-server: fallback page set an invalid status ' +
        '(' + resp.code + '), degrading to the built-in 404')
      return sendError(res, 404, 'Not Found')
    }
    return sendError(res, 500, 'Internal Server Error',
      'invalid status code: ' + resp.code)
  }

  // ---- session reassignment: the template may replace _SESSION
  // wholesale (`_SESSION = {}` is PHP users' natural session-clear
  // idiom); with(useWith) the assignment lands on data._SESSION, so
  // re-read it here — trusting only the pre-render capture would
  // silently discard the reassignment ----
  let sessionOut = session
  if (data._SESSION !== session) {
    if (data._SESSION === null || data._SESSION === undefined) {
      sessionOut = {}                       // null clears the session
    } else if (typeof data._SESSION === 'object') {
      sessionOut = data._SESSION            // {} / [] / new dict
    } else {
      console.error('eta-server: warning: _SESSION was reassigned to a ' +
        'non-object value and the reassignment is ignored')
    }
  }

  // ---- assemble response headers: normalized by lowercased name
  // (case variants can no longer duplicate a header), Content-Length
  // unconditionally framework-owned, list-based names accumulate ----
  const hmap = new Map()          // lowercased name -> [displayName, values[]]
  const setCookies = []
  for (const pair of resp.headers) {
    const name = pair[0]
    const lname = name.toLowerCase()
    if (lname === 'set-cookie') {
      setCookies.push(pair[1])
      continue
    }
    if (lname === 'content-length') {
      // a template-set CL can only ever contradict the buffered body
      // (broken responses / smuggling surface), hence drop + warn
      console.error('eta-server: warning: RESP.header("' + name + '") ' +
        'targets the framework-owned Content-Length and is ignored')
      continue
    }
    if (HOP_BY_HOP_HEADERS[lname]) {
      // hop-by-hop headers are framework-owned (see HOP_BY_HOP_HEADERS)
      console.error('eta-server: warning: RESP.header("' + name + '") is ' +
        'a hop-by-hop header and is ignored')
      continue
    }
    const entry = hmap.get(lname)
    if (entry) {
      entry[0] = name               // display case: last writer wins
      entry[1].push(pair[1])
    } else {
      hmap.set(lname, [name, [pair[1]]])
    }
  }

  // 204 / 205 / 304 never carry a body: drop the residual template
  // bytes AND Content-Length / Content-Type (RFC 7230/7231; strict
  // proxies reject the combination)
  const noBody = resp.code === 204 || resp.code === 205 || resp.code === 304

  const headers = {}
  for (const [lname, entry] of hmap) {
    if (noBody && lname === 'content-type') continue
    const values = entry[1]
    headers[entry[0]] = (values.length > 1 && MULTI_VALUE_HEADERS[lname])
      ? values : values[values.length - 1]
  }

  // ---- session cookie: re-sign (sliding) when session has data ----
  if (Object.keys(sessionOut).length > 0) {
    const sessCookie = SESSION_COOKIE + '=' +
      encodeSession(sessionOut, ctx.secret) + '; Path=/; HttpOnly; SameSite=Lax'
    if (Buffer.byteLength(sessCookie, 'utf8') > SESSION_COOKIE_LIMIT) {
      if (opts.plain404OnError) {
        // same fallback promise: degrade, never escalate (decision #18)
        console.error('eta-server: fallback page session exceeded the ' +
          'cookie capacity limit, degrading to the built-in 404')
        return sendError(res, 404, 'Not Found')
      }
      // browsers silently drop oversized cookies; fail loudly instead
      return sendError(res, 500, 'Internal Server Error',
        'session data exceeds the cookie capacity limit (about 4KB)')
    }
    setCookies.push(sessCookie)
  } else if (hadSessionCookie) {
    setCookies.push(SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax' +
      '; Max-Age=0')
  }
  if (setCookies.length > 0) headers['Set-Cookie'] = setCookies

  if (noBody) {
    res.writeHead(resp.code, headers)
    res.end()
    return
  }

  if (!('Content-Type' in headers) && !hmap.has('content-type')) {
    headers['Content-Type'] = 'text/html; charset=utf-8'
  }

  // ---- pick body: binary short-circuit > RESP.json() > rendered html ----
  let body = html
  if (resp.binary !== null) {
    body = resp.binary
  } else if (resp.text !== null) {
    body = resp.text
  }

  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  headers['Content-Length'] = buf.length
  res.writeHead(resp.code, headers)
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/* ---------------------------------------------------------------------
 * static files
 * ------------------------------------------------------------------- */

function sendStatic (req, res, abs, type) {
  // open once, fstat the SAME fd: a stat-then-stream pair can observe
  // two generations of the file when it is rewritten in between, and
  // the declared Content-Length would disagree with the streamed bytes
  let fd = null
  try {
    fd = fs.openSync(abs, 'r')
  } catch (e) {
    return sendError(res, 404, 'Not Found')
  }
  let stat = null
  try {
    stat = fs.fstatSync(fd)
  } catch (e) {
    try { fs.closeSync(fd) } catch (e2) { /* ignore */ }
    return sendError(res, 404, 'Not Found')
  }
  if (!stat.isFile()) {
    try { fs.closeSync(fd) } catch (e) { /* ignore */ }
    return sendError(res, 404, 'Not Found')
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size
  })
  if (req.method === 'HEAD') {
    try { fs.closeSync(fd) } catch (e) { /* ignore */ }
    res.end()
    return
  }
  // fd handed over to the stream (autoClose releases it on end/error)
  const stream = fs.createReadStream(abs, { fd })
  stream.on('error', () => {
    try { res.destroy() } catch (e) { /* ignore */ }
  })
  // client aborts (page reload, cancelled media loads) destroy res,
  // but pipe() only UNPIPES the source — without this the stream never
  // ends and autoClose never fires, leaking the fd (decision #18)
  res.on('close', () => {
    try { stream.destroy() } catch (e) { /* ignore */ }
  })
  stream.pipe(res)
}

/* ---------------------------------------------------------------------
 * request dispatcher
 * ------------------------------------------------------------------- */

// degraded parse result for requests whose URL failed to parse: just
// enough structure for the 404 fallback template to render
function fallbackParsed (req) {
  const p = new URL('/', 'http://localhost')
  const url = req.url || ''
  const i = url.indexOf('?')
  p.queryString = i >= 0 ? url.slice(i + 1) : ''
  return p
}

// 404 with an optional custom error page (decision #17, renamed from
// _404.eta in #18): when the document root contains a '.404.eta'
// script it is rendered with a default status of 404 (the script may
// override via RESP.status()). The dot convention keeps the file
// itself unroutable, so the fallback can never recurse; a missing or
// broken fallback degrades to the built-in error page — never to a
// non-404
async function sendNotFound (req, res, ctx, parsed, reqStart) {
  const fb = path.join(ctx.root, '.404.eta')
  let st = null
  try {
    st = fs.statSync(fb)
  } catch (e) { /* no fallback */ }
  if (st && st.isFile()) {
    const real = realInside(ctx.rootReal, fb)
    if (real && !isSelfPath(real)) {
      return renderTemplate(req, res, ctx, parsed || fallbackParsed(req),
        fb, '/.404.eta', '', reqStart,
        { defaultStatus: 404, plain404OnError: true })
    }
  }
  return sendError(res, 404, 'Not Found')
}

async function handleRequest (req, res, ctx) {
  // PHP semantics: REQUEST_TIME marks request arrival, captured before
  // the body upload (which can take a while for big POSTs)
  const reqStart = Date.now()
  // ---- slash merging: //a///b -> 308 /a/b (checked on the raw URL
  // first, because new URL() would treat a leading '//' as
  // protocol-relative and misparse the host part) ----
  const rawUrl = req.url || ''
  const rawPath = rawUrl.split(/[?#]/)[0]
  if (rawPath.indexOf('//') >= 0) {
    const loc = rawPath.replace(/\/{2,}/g, '/') +
      (rawUrl.length > rawPath.length ? rawUrl.slice(rawPath.length) : '')
    res.writeHead(308, { 'Location': loc })
    res.end()
    return
  }

  let parsed = null
  let pathname = ''
  try {
    parsed = new URL(req.url, 'http://localhost')
    pathname = decodeURIComponent(parsed.pathname)
  } catch (e) {
    return sendNotFound(req, res, ctx, null, reqStart)
  }
  // assigned right after the parse: every branch below can reach the
  // 404 fallback template (NUL bytes, device names, ...), which
  // expects the same _SERVER.QUERY_STRING contract as normal requests
  parsed.queryString = (req.url.indexOf('?') >= 0)
    ? req.url.slice(req.url.indexOf('?') + 1) : ''
  if (pathname.indexOf('\0') >= 0) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  if (pathname.indexOf('//') >= 0) {
    // %2f-encoded slashes survive the raw check above; normalize them
    // the same way once decoded
    const loc = encodeLocationPath(pathname.replace(/\/{2,}/g, '/')) +
      (parsed.search || '')
    res.writeHead(308, { 'Location': loc })
    res.end()
    return
  }
  if (process.platform === 'win32') {
    // Win32 silently drops trailing dots / spaces when opening files
    // ('demo.eta.' resolves to 'demo.eta'); strip them up front so
    // extension decisions and containment checks agree with what the
    // file system actually opens
    pathname = pathname.replace(/[. ]+$/, '') || '/'
    // ADS colons (foo.txt::$DATA) and reserved device names (NUL,
    // CON.txt, ...) cannot be served as regular files: fail-closed
    for (const seg of pathname.split('/')) {
      if (seg && win32BadSegment(seg)) {
        return sendNotFound(req, res, ctx, parsed, reqStart)
      }
    }
  }

  const root = ctx.root
  let target = path.resolve(root, '.' + pathname)
  if (!containsPath(root, target)) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  // ---- self-protection, fast path: exact / case-variant / 8.3 match
  // against the server's own file. Checked again after realpath
  // resolution below (symlinked / junctioned routes to the same real
  // file are covered there) ----
  if (isSelfPath(target)) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }

  // ---- template branch: xxx.eta or xxx.eta/PATH_INFO ----
  const lower = pathname.toLowerCase()
  let scriptRel = null
  let pathInfo = ''
  if (lower.endsWith('.eta')) {
    scriptRel = pathname
  } else {
    const i = lower.indexOf('.eta/')
    if (i >= 0) {
      scriptRel = pathname.slice(0, i + 4)
      pathInfo = pathname.slice(i + 4)
    }
  }
  // ---- hidden-path convention (decision #17/#18): checked on the
  // file part only — the PATH_INFO tail of a real script is data, not
  // a file path, so '/api.eta/.user/1' stays legal ----
  if (isPrivatePathname(scriptRel !== null ? scriptRel : pathname)) {
    logBlocked(req)
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  if (scriptRel !== null) {
    const scriptAbs = path.resolve(root, '.' + scriptRel)
    if (!containsPath(root, scriptAbs)) {
      return sendNotFound(req, res, ctx, parsed, reqStart)
    }
    let stat = null
    try {
      stat = fs.statSync(scriptAbs)
    } catch (e) { /* handled below */ }
    if (stat && stat.isFile()) {
      // realpath containment: a symlink / junction inside root pointing
      // outside must not be rendered; a route whose real location is
      // the server's own file or a hidden name is 404 too
      const realScript = realInside(ctx.rootReal, scriptAbs)
      if (!realScript || isSelfPath(realScript)) {
        return sendNotFound(req, res, ctx, parsed, reqStart)
      }
      if (isPrivateReal(ctx.rootReal, realScript)) {
        logBlocked(req)
        return sendNotFound(req, res, ctx, parsed, reqStart)
      }
      return renderTemplate(req, res, ctx, parsed, scriptAbs, scriptRel,
        pathInfo, reqStart)
    }
    if (!stat) {
      return sendNotFound(req, res, ctx, parsed, reqStart)
    }
    // a DIRECTORY whose name contains '.eta': the PATH_INFO split
    // applies to files only, so fall through to the directory / static
    // branch below (its target covers the full pathname)
  }

  // ---- directory branch: 301 slash, then index fallbacks ----
  let stat = null
  try {
    stat = fs.statSync(target)
  } catch (e) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  // realpath containment applies to both directories and static files:
  // a symlink / junction escaping the root is a plain 404 — as is any
  // route whose real location resolves to the server's own file (case-
  // insensitive everywhere, 8.3 short names expanded by realpath) or
  // to a hidden name (a symlink pointing at '.config/' inside root)
  const real = realInside(ctx.rootReal, target)
  if (!real || isSelfPath(real)) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  if (isPrivateReal(ctx.rootReal, real)) {
    logBlocked(req)
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  if (stat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      const loc = encodeLocationPath(pathname) + '/' + (parsed.search || '')
      res.writeHead(301, { 'Location': loc })
      res.end()
      return
    }
    const idxEta = path.join(real, 'index.eta')
    try {
      if (fs.statSync(idxEta).isFile()) {
        // index candidates get their own containment check: the
        // directory passed, but an index symlink inside it may still
        // point outside the root — or at the server's own file (a
        // target inside the root escapes the containment check, so
        // isSelfPath is the only guard here)
        const realIdx = realInside(ctx.rootReal, idxEta)
        if (!realIdx || isSelfPath(realIdx)) {
          return sendNotFound(req, res, ctx, parsed, reqStart)
        }
        if (isPrivateReal(ctx.rootReal, realIdx)) {
          logBlocked(req)
          return sendNotFound(req, res, ctx, parsed, reqStart)
        }
        const name = pathname + 'index.eta'
        return renderTemplate(req, res, ctx, parsed, idxEta, name, '',
          reqStart)
      }
    } catch (e) { /* no index.eta */ }
    for (const name of ['index.html', 'index.htm']) {
      const f = path.join(real, name)
      try {
        if (fs.statSync(f).isFile()) {
          const realF = realInside(ctx.rootReal, f)
          if (!realF || isSelfPath(realF)) {
            return sendNotFound(req, res, ctx, parsed, reqStart)
          }
          if (isPrivateReal(ctx.rootReal, realF)) {
            logBlocked(req)
            return sendNotFound(req, res, ctx, parsed, reqStart)
          }
          // Content-Type judged by the realpath extension (decision
          // #12), not the symlink's own name; outside the whitelist
          // stays fail-closed 404 (no fallback to the next candidate)
          const type = STATIC_TYPES[path.extname(realF).toLowerCase()]
          if (!type) {
            return sendNotFound(req, res, ctx, parsed, reqStart)
          }
          return sendStatic(req, res, realF, type)
        }
      } catch (e) { /* keep looking */ }
    }
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }

  // ---- static file branch: whitelist + method check ----
  const ext = path.extname(real).toLowerCase()
  const type = STATIC_TYPES[ext]
  if (!type) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' })
    res.end()
    return
  }
  return sendStatic(req, res, real, type)
}

/* ---------------------------------------------------------------------
 * CLI rendering mode
 * ------------------------------------------------------------------- */

async function renderCli (script, args) {
  // render a single script like "php xxx.php", writing the result to
  // stdout. A script name of '-' reads the template source from stdin
  // (POSIX convention; PHP CLI likewise uses argv[0] = '-' for stdin
  // scripts). Exits with 1 on failure (no partial content on stdout:
  // eta rendering is a pure function returning the full string).
  let src = null
  let scriptAbs = null
  let baseDir = null
  if (script === '-') {
    // stdin mode: includes resolve against cwd, the only natural
    // anchor when there is no script file
    baseDir = process.cwd()
    scriptAbs = '-'
    try {
      src = fs.readFileSync(0, 'utf8')
    } catch (err) {
      console.error('eta-server: cannot read stdin: ' + err.message)
      process.exit(1)
    }
  } else {
    scriptAbs = path.resolve(script)
    let stat = null
    try {
      stat = fs.statSync(scriptAbs)
    } catch (e) { /* fall through to the error below */ }
    if (!stat || !stat.isFile()) {
      console.error('eta-server: no such file: ' + script)
      process.exit(1)
    }
    baseDir = path.dirname(scriptAbs)
    try {
      src = fs.readFileSync(scriptAbs, 'utf8')
    } catch (err) {
      console.error('eta-server: cannot read file: ' + script)
      process.exit(1)
    }
  }
  src = stripBom(src)

  // bridge degraded to CLI values: no
  // request, no session, empty body; argv[0] = the script itself
  const resp = makeResp()
  const now = Date.now()
  const data = {
    _GET: Object.create(null),
    _POST: Object.create(null),
    _REQUEST: Object.create(null),
    _SERVER: Object.assign(Object.create(null), {
      REQUEST_METHOD: 'GET',
      QUERY_STRING: '',
      SCRIPT_NAME: scriptAbs,
      SCRIPT_FILENAME: scriptAbs,
      SCRIPT_DIRNAME: baseDir,
      PATH_INFO: '',
      REMOTE_ADDR: '',
      SERVER_NAME: '',
      SERVER_PORT: '',
      CONTENT_TYPE: '',
      CONTENT_LENGTH: '',
      REQUEST_TIME: Math.floor(now / 1000),
      REQUEST_TIME_FLOAT: now / 1000,
      argv: [script].concat(args),
    }),
    _COOKIE: Object.create(null),
    _SESSION: {},
    _BODY: Buffer.alloc(0),
    _JSON: null,
    RESP: resp,
    escape: escapeHtml,
    require: createRequire(script === '-'
      ? path.join(baseDir, 'stdin.js') : scriptAbs),
  }
  const eta = new Eta({ views: baseDir, cache: false, useWith: true, autoTrim: false })
  let html = ''
  try {
    html = await eta.renderStringAsync(src, data)
  } catch (err) {
    // traceback goes to stderr, stdout stays clean
    console.error((err && err.stack) ? err.stack : String(err))
    process.exit(1)
  }

  // body priority identical to HTTP mode (decision #6): writeraw
  // short-circuit > RESP.json() > rendered text
  let body = html
  if (resp.binary !== null) {
    body = resp.binary
  } else if (resp.text !== null) {
    body = resp.text
  }
  process.stdout.write(body)
}

/* ---------------------------------------------------------------------
 * server bootstrap
 * ------------------------------------------------------------------- */

function startServer (rootDir, port, host, options) {
  const root = path.resolve(rootDir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return Promise.reject(new Error('document root not found: ' + root))
  }
  port = Number(port) || 5000
  host = host || '127.0.0.1'
  options = options || {}

  // access-log destination is per instance (on ctx), NOT a module
  // global: a second startServer() must not re-route the first one's
  // log. --quiet takes precedence over an explicit destination
  const accessLog = options.quiet ? null : openAccessLog(options.accessLog)
  // a file-stream destination must be released on BOTH shutdown paths:
  // a listen failure (EADDRINUSE) and server.close() — otherwise
  // repeated startServer() calls accumulate open handles (decision #18);
  // stdout/stderr are shared process streams and never closed here
  const ownsAccessLog = !!accessLog && accessLog !== process.stdout &&
    accessLog !== process.stderr
  const releaseAccessLog = () => {
    if (ownsAccessLog) {
      try { accessLog.end() } catch (e) { /* ignore */ }
    }
  }
  const ctx = {
    root: root,
    rootReal: fs.realpathSync(root),
    host: host,
    port: port,
    secret: deriveSecret(root),
    eta: new Eta({ views: root, cache: false, useWith: true, autoTrim: false }),
    accessLog: accessLog,
  }

  // loopback binds are the intended usage; anything else deserves a
  // loud reminder that 500 pages expose stack traces + absolute paths
  const LOOPBACK_HOSTS = { '127.0.0.1': 1, 'localhost': 1, '::1': 1 }
  if (!LOOPBACK_HOSTS[host]) {
    console.error('eta-server: warning: binding to non-loopback address ' +
      '"' + host + '" — this is a trusted-environment dev server; ' +
      '500 pages expose full stack traces and absolute paths')
  }

  const server = http.createServer((req, res) => {
    const start = Date.now()
    const state = { bytes: 0 }
    trackWriteHead(res, state)
    // 'finish' covers every dispatcher branch without touching them;
    // aborted connections (destroyed before completion) are not logged
    res.on('finish', () => {
      const stream = ctx.accessLog
      if (stream) stream.write(accessLine(req, res, state, start) + '\n')
    })
    handleRequest(req, res, ctx).catch((err) => {
      sendError(res, 500, 'Internal Server Error', String(err && err.stack || err))
    })
  })

  // 'close' fires once the server has fully shut down: release the
  // access-log file stream with it
  server.on('close', releaseAccessLog)

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      releaseAccessLog()     // the server never starts: drop the stream
      if (err.code === 'EADDRINUSE') {
        reject(new Error('port ' + port + ' is already in use on ' + host))
      } else {
        reject(err)
      }
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      // once listening, the startup error path is over: leaving the
      // handler around would reject an already-settled promise on any
      // later server-level error
      server.removeListener('error', onError)
      resolve(server)
    })
  })
}

function printBanner (root, port, host) {
  console.log('eta-server ' + VERSION + ' (PHP-style .eta server)')
  console.log('  root : ' + root)
  console.log('  url  : http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) +
    ':' + port + '/')
  console.log('  press Ctrl+C to stop')
}

function printHelp () {
  console.log('usage: eta-server [options] [script] [args...]')
  console.log('')
  console.log('with no positional argument, start the HTTP dev server;')
  console.log('with a script argument, render it once to stdout (CLI mode)')
  console.log('like "php script.php"; use "-" to read the script from stdin')
  console.log('')
  console.log('options:')
  console.log('  -r, --root <dir>    document root (default: cwd, HTTP mode only)')
  console.log('  -p, --port <port>   listen port (default: 5000, HTTP mode only)')
  console.log('  -H, --host <host>   bind address (default: 127.0.0.1, HTTP mode only)')
  console.log('  -q, --quiet         no access log (HTTP mode only)')
  console.log('  --access-log <p>    write the access log to <p>, appending;')
  console.log('                      "-" means stdout (default: stderr)')
  console.log('  -h, --help          show this help')
  console.log('')
  console.log('CLI mode:')
  console.log('  script              script path (any extension); "-" reads stdin')
  console.log('  args...             everything after the script name is passed')
  console.log('                      through verbatim, readable via _SERVER.argv')
}

function parseArgs (argv) {
  const opts = { root: process.cwd(), port: 5000, host: '127.0.0.1',
    quiet: false, accessLog: null,
    script: null, args: [] }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-r' || a === '--root') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      opts.root = path.resolve(args[++i])
    } else if (a === '-p' || a === '--port') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error('invalid port')
      }
      opts.port = n
    } else if (a === '-H' || a === '--host') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      opts.host = args[++i]
    } else if (a === '-q' || a === '--quiet') {
      opts.quiet = true
    } else if (a === '--access-log') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      opts.accessLog = args[++i]
    } else if (a === '-h' || a === '--help') {
      printHelp()
      process.exit(0)
    } else {
      // first positional argument is the script: CLI render mode.
      // everything after the script name is never parsed and passed
      // through verbatim (argparse REMAINDER semantics),
      // including arguments that look like options
      opts.script = a
      opts.args = args.slice(i + 1)
      break
    }
  }
  return opts
}

if (require.main === module) {
  let opts = null
  try {
    opts = parseArgs(process.argv)
  } catch (err) {
    console.error('eta-server: ' + err.message)
    process.exit(1)
  }
  if (opts.script) {
    renderCli(opts.script, opts.args).catch((err) => {
      console.error((err && err.stack) ? err.stack : String(err))
      process.exit(1)
    })
  } else {
    // crash guards: a bug in a template's detached async callback
    // (setTimeout, an orphan .then chain) must not kill the whole dev
    // server — log and keep serving (single-process equivalent of
    // PHP-FPM's per-request worker isolation)
    process.on('uncaughtException', (err) => {
      console.error('eta-server: uncaught exception (server kept alive):')
      console.error((err && err.stack) ? err.stack : String(err))
    })
    process.on('unhandledRejection', (reason) => {
      console.error('eta-server: unhandled rejection (server kept alive):')
      console.error((reason && reason.stack) ? reason.stack : String(reason))
    })
    startServer(opts.root, opts.port, opts.host, {
      quiet: opts.quiet, accessLog: opts.accessLog,
    }).then((server) => {
      printBanner(path.resolve(opts.root), opts.port, opts.host)
      const shutdown = () => {
        server.close(() => process.exit(0))
        setTimeout(() => process.exit(0), 1000).unref()
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    }).catch((err) => {
      console.error('eta-server: ' + err.message)
      process.exit(1)
    })
  }
}

module.exports = { startServer, renderCli, deriveSecret, VERSION }
