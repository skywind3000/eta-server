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
 * Last Modified: 2026/08/20 03:20:00
 *
 * ===================================================================== */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const net = require('node:net')
const { createRequire } = require('node:module')
const { Eta } = require('eta')

const VERSION = '0.11.0'
const MAX_BODY = 64 * 1024 * 1024
const SESSION_COOKIE = 'ETASESSION'
const SESSION_TTL = 30 * 60 * 1000          // default sliding timeout: 30 min
// cookie capacity guard: an oversized session
// cookie is silently dropped by browsers anyway; fail loudly instead
const SESSION_COOKIE_LIMIT = 4096

// multipart/form-data guards: keep the dev-server surface bounded so
// a malformed or malicious upload cannot exhaust temp disk space or
// create an unbounded number of files/fields.
const MULTIPART_MAX_FIELDS = 256
const MULTIPART_MAX_FILES = 64
const MULTIPART_MAX_FILE_SIZE = 16 * 1024 * 1024   // 16 MB per file
const MULTIPART_MAX_HEADER_SIZE = 8192             // 8 KB per-part headers

// Eta plugin: inject a per-invocation wrapper into the compiled template
// so that RESP.write() / echo() emit text during rendering.
//
// Eta 4.1+ path: with `outputFunctionName: '__templateOutputFunction'`
// the compiled template defines a public helper function that pushes into
// `__eta.res`. We bind RESP.write / echo to that helper — no internal
// `__eta.res` access from our side.
//
// Eta 3.x fallback: no outputFunctionName support, so we create a wrapper
// via Object.create and define a function that writes to `__eta.res`.
//
// In both cases the shared RESP object is left untouched; the wrapper is
// created per invocation so concurrent async templates stay isolated.
const WRITE_HOOK_PLUGIN = {
  processFnString: function (fnStr) {
    // Eta 4.1+: use the public outputFunctionName helper.
    // The helper is declared inside the `with` block before template code,
    // so we inject the binding right after it — that way echo()/RESP.write()
    // are available while the template code executes.
    if (fnStr.indexOf('function __templateOutputFunction') >= 0) {
      return fnStr.replace(
        /function __templateOutputFunction\(s\)\{__eta\.res\+=s;\}/,
        function (match) {
          return match + '\n' +
            'if (it) {\n' +
            '  it.RESP.write = __templateOutputFunction;\n' +
            '  it.echo = it.RESP.write;\n' +
            '}\n'
        }
      )
    }
    // Eta 3.x fallback: match the whole `let __eta = { ... };` declaration
    // and inject a wrapper that writes to `__eta.res`.
    return fnStr.replace(
      /let __eta = \{[\s\S]*?\};\n/,
      function (match) {
        return match +
          'if (it) {\n' +
          '  it.RESP = Object.create(it.RESP || {});\n' +
          '  it.RESP.write = function(s){__eta.res += (s==null?"":String(s))};\n' +
          '  it.echo = it.RESP.write;\n' +
          '}\n'
      }
    )
  }
}

const SELF_PATH = path.resolve(__filename)

// canonical realpath (decision #20). fs.realpathSync — the JS
// implementation, which is what the plain name resolves to — walks the
// path with lstat/readlink: it resolves symlinks but canonicalizes
// NEITHER win32 8.3 short names ('NODE_M~1' opens 'node_modules',
// 'ETA-SE~1.JS' opens 'eta-server.js') NOR case. Every check that runs
// on a realpath result therefore used to see the alias and miss it, so
// one filesystem-level naming trick walked straight through both
// self-protection and the hidden-path convention. fs.realpathSync.native
// goes through GetFinalPathNameByHandle and hands back the true long
// name in its on-disk case, which kills the whole aliasing family at
// the root instead of one alias at a time. The JS implementation stays
// as a fallback for the exotic paths native rejects; when it throws too
// the caller (realInside) fails closed
function realpathCanon (p) {
  try {
    return fs.realpathSync.native(p)
  } catch (e) {
    return fs.realpathSync(p)
  }
}

// realpath of our own file, canonical: 8.3 short names and case are
// both resolved here. isSelfPath() still folds case on top of that —
// the dispatcher fast path compares a target that has NOT been through
// realpath, and the case fold is the only thing catching it there
const SELF_PATH_REAL = (() => {
  try { return realpathCanon(SELF_PATH) } catch (e) { return SELF_PATH }
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
//
// An explicit secret (--secret / ETA_SERVER_SECRET, decision #21)
// replaces BOTH inputs: the persisted master secret AND the per-root
// mixing. "I set the signing key myself" has to mean the same value
// yields the same key everywhere, which is what makes the option
// useful — a reproducible key in containers / CI with no writable
// home, deliberate rotation, and the manual way out of the shared
// cookie-name collision (two instances handed one secret verify each
// other's cookies instead of clearing them; see known limitations).
// The cost is deliberate, documented and printed at startup: per-site
// isolation is off, so every root started with this secret shares one
// session namespace
function deriveSecret (rootDir, explicit) {
  if (explicit) {
    return crypto.createHmac('sha256', String(explicit))
      .update('eta-server-session|explicit').digest('hex')
  }
  let rootReal = ''
  try {
    // canonical form (decision #20): the plain realpath keeps whatever
    // case the caller typed, so '-r E:\www' and '-r e:\WWW' derived two
    // different keys for one site and dropped every session on restart
    rootReal = realpathCanon(rootDir)
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

function encodeSession (data, secret, ttl) {
  const payload = JSON.stringify({ d: data, e: Date.now() + (ttl || SESSION_TTL) })
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
  // null-prototype like every other bridge dict (decision #14 parity):
  // JSON.parse hands back an Object.prototype-backed object, which made
  // _SESSION the only dict where inherited members shine through
  return Object.assign(Object.create(null), payload.d)
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

// PHP $_ENV: a request-level snapshot of process.env as a null-prototype
// dict. Unlike process.env (a plain object with Object.prototype), this
// is safe against prototype-pollution-style key lookups in templates.
function buildEnvSnapshot () {
  return Object.assign(Object.create(null), process.env)
}

// PHP $_FILES upload error codes (match PHP UPLOAD_ERR_* constants)
const UPLOAD_ERR_OK = 0
const UPLOAD_ERR_INI_SIZE = 1
const UPLOAD_ERR_FORM_SIZE = 2
const UPLOAD_ERR_PARTIAL = 3
const UPLOAD_ERR_NO_FILE = 4
const UPLOAD_ERR_NO_TMP_DIR = 6
const UPLOAD_ERR_CANT_WRITE = 7
const UPLOAD_ERR_EXTENSION = 8

// Parse a multipart/form-data body into { fields, files }.
// `fields` is a plain dict of name -> value (last value wins for
// repeated names, matching how URLSearchParams behaves).
// `files` follows PHP's $_FILES shape:
//   single:  files[name] = { name, type, size, tmp_name, error }
//   multiple (name="f[]"): files[name] = { name:[...], type:[...],
//            size:[...], tmp_name:[...], error:[...] }
// File contents are written to a temp directory so templates can read
// them via fs, mirroring PHP's tmp_name semantics. The caller receives
// the list of temp file paths so it can clean them up after the response.
function parseMultipart (buf, contentType) {
  const fields = Object.create(null)
  const files = Object.create(null)
  const tempFiles = []
  let fieldCount = 0
  let fileCount = 0
  let error = null

  function fail (msg) {
    error = new Error(msg)
    return true
  }

  // extract boundary from Content-Type
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
  if (!m) return { fields, files, tempFiles, tmpDir: null, error }
  const boundary = '--' + (m[1] || m[2]).trim()
  const boundaryBuf = Buffer.from(boundary, 'latin1')
  const endBoundaryBuf = Buffer.from(boundary + '--', 'latin1')

  // create a temp directory for uploaded files
  let tmpDir = null
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eta-up-'))
  } catch (e) {
    // no temp dir available: files will have tmp_name '' and error set
    tmpDir = null
  }

  // split body on boundary; each part is between two boundary lines
  // we scan byte by byte looking for boundary occurrences
  let pos = 0
  const parts = []
  while (true) {
    const idx = buf.indexOf(boundaryBuf, pos)
    if (idx === -1) break
    if (pos > 0) {
      // part content is between the previous boundary end and this one
      // strip trailing \r\n before the boundary
      let end = idx
      if (end >= 2 && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2
      parts.push(buf.slice(pos, end))
    }
    // move past this boundary line (boundary + \r\n, or boundary + --)
    const after = idx + boundaryBuf.length
    if (buf.slice(idx, idx + endBoundaryBuf.length).equals(endBoundaryBuf)) {
      break // final boundary
    }
    pos = after
    // skip \r\n after boundary
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2
  }

  if (parts.length > MULTIPART_MAX_FIELDS + MULTIPART_MAX_FILES) {
    fail('multipart: too many parts')
  }

  for (const part of parts) {
    if (error) break
    // split headers from body at the first blank line (\r\n\r\n)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    if (headerEnd > MULTIPART_MAX_HEADER_SIZE) {
      fail('multipart: part header too large')
      break
    }
    const headerBlock = part.slice(0, headerEnd).toString('latin1')
    const body = part.slice(headerEnd + 4)

    // parse Content-Disposition
    const nameMatch = headerBlock.match(/name="([^"]*)"/i)
    const fileMatch = headerBlock.match(/filename="([^"]*)"/i)
    const typeMatch = headerBlock.match(/content-type:\s*([^\r\n]+)/i)

    if (!nameMatch) continue
    let fieldName = nameMatch[1]

    if (fileMatch) {
      if (fileCount >= MULTIPART_MAX_FILES) {
        fail('multipart: too many files')
        break
      }
      // file upload
      const origName = fileMatch[1]
      const mime = typeMatch ? typeMatch[1].trim() : 'application/octet-stream'
      const isArrayField = fieldName.endsWith('[]')
      if (isArrayField) fieldName = fieldName.slice(0, -2)

      if (body.length > MULTIPART_MAX_FILE_SIZE) {
        fail('multipart: file too large')
        break
      }

      let tmpName = ''
      let err = UPLOAD_ERR_OK
      if (tmpDir === null) {
        err = UPLOAD_ERR_NO_TMP_DIR
      } else if (origName === '') {
        // empty filename means no file was selected (PHP UPLOAD_ERR_NO_FILE)
        err = UPLOAD_ERR_NO_FILE
      } else {
        try {
          const fname = path.join(tmpDir, 'up-' +
            crypto.randomBytes(8).toString('hex'))
          fs.writeFileSync(fname, body)
          tmpName = fname
          tempFiles.push(fname)
        } catch (e) {
          err = UPLOAD_ERR_CANT_WRITE
        }
      }

      fileCount++
      const entry = {
        name: origName,
        type: mime,
        size: body.length,
        tmp_name: tmpName,
        error: err,
      }

      if (isArrayField) {
        if (!files[fieldName]) {
          files[fieldName] = {
            name: [], type: [], size: [], tmp_name: [], error: [],
          }
        }
        const arr = files[fieldName]
        arr.name.push(entry.name)
        arr.type.push(entry.type)
        arr.size.push(entry.size)
        arr.tmp_name.push(entry.tmp_name)
        arr.error.push(entry.error)
      } else {
        files[fieldName] = entry
      }
    } else {
      if (fieldCount >= MULTIPART_MAX_FIELDS) {
        fail('multipart: too many fields')
        break
      }
      // regular form field
      fields[fieldName] = body.toString('utf8')
      fieldCount++
    }
  }

  return { fields, files, tempFiles, tmpDir, error }
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

// CLF wraps the request line in double quotes, so a literal '"' (or a
// backslash) inside the request target splits the field and every
// downstream parser (awk / goaccess) misreads the line — an attacker
// picks the URL, hence picks what the fields look like. Apache escapes
// both as \" / \\ and so do we (decision #20; the third review had
// marked this channel clean, the seventh reproduced it: GET /a"b logged
// an unescaped quote). Control characters need no handling — llhttp
// rejects them in the request line, so no full line injection exists
function clfEscape (value) {
  return String(value).replace(/[\\"]/g, (c) => '\\' + c)
}

function accessLine (req, res, state, start, ctx) {
  // behind a trusted proxy every peer address is the proxy itself, so
  // the log would read 127.0.0.1 for the whole world; the forwarded
  // client is what makes the log useful (and is only trusted under
  // --behind-proxy, like _SERVER.REMOTE_ADDR)
  const remote = (ctx && ctx.behindProxy
    ? forwardedClientIp(req.headers) : '') ||
    (req.socket && req.socket.remoteAddress) || '-'
  const ms = Date.now() - start
  // the client field is escaped like the request line: forwarded
  // addresses are validated as IP literals (decision #23), so this is
  // belt-and-braces for anything else that could ever land here
  return clfEscape(remote) + ' - - [' + formatCltTime(new Date(start)) + '] "' +
    clfEscape(req.method) + ' ' + clfEscape(req.url) +
    ' HTTP/' + req.httpVersion + '" ' +
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
 * Host header allowlist — DNS rebinding defense (decision #20)
 * ------------------------------------------------------------------- */

// A loopback bind is NOT an access control: any page the developer
// happens to visit can point a hostname it controls at 127.0.0.1 (a
// short-TTL DNS rebind), and the browser will then treat this server as
// same-origin with the attacker's page — so it may not only send
// requests but READ the responses. SameSite=Lax does not help (it is
// same-site after the rebind), CORS does not help (nothing is
// cross-origin any more), and the "local / trusted environment"
// positioning does not help either: the attacker is remote while the
// victim's own browser makes the request. The only real defense is to
// check the Host header, which is why vite / webpack-dev-server /
// angular all ship an allowlist. Accepted by default: loopback names,
// any *.localhost (RFC 6761), the bind address, and every literal IP.
function hostnameOf (hostHeader) {
  let h = String(hostHeader || '').trim()
  if (!h) return ''
  if (h.charAt(0) === '[') {                 // [::1]:5000 -> ::1
    const i = h.indexOf(']')
    return i > 0 ? h.slice(1, i).toLowerCase() : ''
  }
  // A bare IP literal (IPv4 or IPv6) should be accepted as-is; this
  // fixes the case where Host: ::1 was mishandled by the host:port
  // splitting logic below.
  if (net.isIP(h) !== 0) return h.toLowerCase()
  const i = h.lastIndexOf(':')
  // one colon only = host:port; several = malformed IPv6-with-port, keep it
  if (i >= 0 && h.indexOf(':') === i) h = h.slice(0, i)
  return h.toLowerCase()
}

// null means "check disabled" (--allowed-hosts all)
function buildAllowedHosts (host, spec) {
  const s = spec ? String(spec).trim() : ''
  if (s === 'all' || s === '*') return null
  const out = Object.assign(Object.create(null), {
    'localhost': 1, 'localhost.localdomain': 1,
  })
  const add = (v) => { const n = hostnameOf(v); if (n) out[n] = 1 }
  add(host)
  if (s) for (const item of s.split(',')) add(item)
  return out
}

/* ---------------------------------------------------------------------
 * reverse proxy support (--behind-proxy, decision #20 amendment)
 * ------------------------------------------------------------------- */

// There is NO way to tell a proxied request from a DNS-rebound one by
// inspection: both arrive on the loopback interface with an
// attacker-influenceable Host, and after a rebind the attacker's page is
// same-origin, so it can set X-Forwarded-* freely (no CORS preflight to
// stop it). The operator has to declare the topology — which is exactly
// why vite / webpack-dev-server make it configuration too. `--behind-
// proxy` is that declaration, and it is worth a flag of its own because
// it also fixes what the proxy setup silently lost: the documented
// Apache / nginx configs forward X-Real-IP and X-Forwarded-Proto, and
// nothing here used to read them, so every request looked like plain
// http from 127.0.0.1 (in _SERVER and in every access-log line).
//
// Trusting these headers is safe ONLY because the flag asserts a proxy
// owns the port. Without it they stay ignored, so a rebound page cannot
// forge a client IP.

// forwarded values are attacker-controlled input: --behind-proxy only
// asserts that a proxy owns the port, it cannot make the header
// contents true, and anything reaching the port directly picks them.
// An unvalidated address forged a whole CLF field prefix in the access
// log ('1.2.3.4 - - [pwned] "GET /x" 200 0' — header values may
// contain spaces and quotes, only control characters are rejected by
// llhttp) and handed templates arbitrary text where _SERVER.REMOTE_ADDR
// promises an address. So a value that is not an IP literal is dropped
// in favour of the real peer, the same way Apache mod_remoteip and
// Express 'trust proxy' validate theirs (decision #23)
function normalizeIp (value) {
  let v = String(value).trim()
  if (!v) return ''
  // Accept a plain IP literal first; this covers bare IPv6 addresses
  // such as ::1 without requiring brackets.
  if (net.isIP(v) !== 0) return v
  // some proxies append the source port: '[2001:db8::1]:443' or
  // '192.0.2.1:1234' — the address is the part we want
  if (v.charAt(0) === '[') {
    const i = v.indexOf(']')
    if (i > 0) v = v.slice(1, i)
  } else if (v.indexOf(':') > 0 && v.indexOf(':') === v.lastIndexOf(':')) {
    v = v.slice(0, v.indexOf(':'))
  }
  return net.isIP(v) !== 0 ? v : ''
}

// host grammar, RFC 1123 shape with underscores allowed: they are
// illegal in a strict reading but ordinary in dev setups (docker
// container names, 'my_app.local') and harmless in the HTML / URL
// contexts templates build out of SERVER_NAME. The point of this check
// is to keep quotes, angle brackets and spaces out, not to police DNS
const HOSTNAME_RE =
  /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/

// the forwarded host lands in _SERVER.SERVER_NAME, out of which
// templates build URLs and links. The Host header is safe by
// construction on the normal path (it passed the allowlist first), but
// --behind-proxy skips that check, so both channels get validated here.
// Deliberately NOT folded into hostnameOf(): that function feeds the
// allowlist, where an empty return means "no Host at all" and is
// ALLOWED — rejecting junk there would turn a malformed Host into a
// bypass (decision #23)
function validHostname (name) {
  if (!name) return ''
  if (net.isIP(name) !== 0) return name
  if (name.length > 253) return ''
  return HOSTNAME_RE.test(name) ? name : ''
}

// leftmost X-Forwarded-For entry is the original client (each hop
// appends its peer); X-Real-IP is nginx's single-value equivalent
function forwardedClientIp (headers) {
  const xff = headers['x-forwarded-for']
  if (xff) {
    const first = normalizeIp(String(xff).split(',')[0])
    if (first) return first
  }
  const real = headers['x-real-ip']
  if (real) {
    const one = normalizeIp(real)
    if (one) return one
  }
  return ''
}

// only http / https are accepted: the value lands in _SERVER and
// templates build URLs out of it
function forwardedScheme (headers) {
  const proto = headers['x-forwarded-proto']
  if (!proto) return ''
  const first = String(proto).split(',')[0].trim().toLowerCase()
  return (first === 'http' || first === 'https') ? first : ''
}

function isHostAllowed (allowed, hostHeader) {
  if (allowed === null) return true
  const name = hostnameOf(hostHeader)
  // no Host at all (HTTP/1.0 client, hand-written curl): browsers
  // always send one, so this is never the rebinding channel
  if (name === '') return true
  // a literal IP cannot be rebound — the browser sends the name it
  // navigated to, and a DNS *name* is the only thing an attacker
  // controls, so an IP Host is authentic by construction. Keeps LAN
  // access through -H 0.0.0.0 working without configuration
  if (net.isIP(name) !== 0) return true
  if (allowed[name]) return true
  // RFC 6761 reserves .localhost for the loopback: 'myapp.localhost'
  // reaches this server with no DNS involved at all
  if (name.endsWith('.localhost')) return true
  return false
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
// the real path in canonical form (8.3 short names expanded, case
// normalized — see realpathCanon), or null when missing / escaping.
// Every caller feeds this result to isSelfPath / isPrivateReal, so the
// canonicalization here is what makes those two rules alias-proof
function realInside (rootReal, abs) {
  let real = null
  try {
    real = realpathCanon(abs)
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

// THE gate: every filesystem path the dispatcher is about to serve goes
// through here, and nothing is served without its return value. Returns
// the canonical real path, or null when the candidate escapes the root,
// resolves to the server's own file, or lands under a private name
// (that last case logs one stderr line, the others stay silent —
// fail-closed 404 is indistinguishable from "does not exist").
//
// This used to be three calls written out at four call sites (template
// branch, directory/static branch, index.eta candidate, index.html
// candidates), and the copies are why the same class of hole kept
// coming back: decision #15 found the index candidates missing their
// isSelfPath check, decision #18 found a new rule that had only landed
// in some copies, decision #20 found an aliasing bug that had to be
// fixed in every copy at once. One chokepoint means a rule is written
// once. The single deliberate exception is the .404.eta lookup in
// sendNotFound(), which must bypass the private-name rule because the
// fallback page is a dot file by design — spelled out there.
function gateReal (req, rootReal, abs) {
  const real = realInside(rootReal, abs)
  if (!real || isSelfPath(real)) return null
  if (isPrivateReal(rootReal, real)) {
    logBlocked(req)
    return null
  }
  return real
}

/* ---------------------------------------------------------------------
 * RESP.info() — phpinfo()-style diagnostic page
 * ------------------------------------------------------------------- */

// mask env vars whose names look sensitive, same heuristic as the demo
const INFO_SECRET_NAME_RE =
  /SECRET|TOKEN|PASS(WORD|WD)?|CREDENTIAL|PRIVATE|SESSION_KEY|AUTH|(^|_)KEY(_|$)|API_?KEY/i

function infoSortedEntries (obj) {
  return Object.keys(obj).sort().map(k => [k, obj[k]])
}

function infoFilesEntries (obj) {
  return Object.keys(obj).sort().map(k => {
    const v = obj[k]
    return [k, JSON.stringify(v)]
  })
}

function infoNowString () {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' +
    pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) +
    ':' + pad(now.getSeconds())
}

// eta's exports field does not expose ./package.json, so climb from
// require.resolve('eta') to the package root by hand.
function infoPkgVersion (name) {
  let dir = path.dirname(require.resolve(name))
  while (true) {
    const f = path.join(dir, 'package.json')
    if (fs.existsSync(f)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (pkg.name === name) return pkg.version || '?'
      } catch (e) { /* keep climbing */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return '?'
    dir = parent
  }
}

let _cachedEtaVersion = null
function infoEtaVersion () {
  if (_cachedEtaVersion == null) {
    _cachedEtaVersion = infoPkgVersion('eta')
  }
  return _cachedEtaVersion
}

function infoMaskedEnv () {
  return infoSortedEntries(process.env).map(
    (p) => INFO_SECRET_NAME_RE.test(p[0]) ? [p[0], '(masked by RESP.info)'] : p)
}

function infoModuleSearchPaths (scriptDirname) {
  const out = []
  let dir = scriptDirname || process.cwd()
  while (true) {
    out.push(path.join(dir, 'node_modules'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out.join('\n')
}

function infoInstalledPackages (docRoot) {
  if (!docRoot) return []
  const pkgFile = path.join(docRoot, 'package.json')
  let pkg
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { return [] }
  const deps = Object.entries(pkg.dependencies || {}).map(
    ([name, ver]) => ({ name, version: String(ver), dev: false }))
  const devDeps = Object.entries(pkg.devDependencies || {}).map(
    ([name, ver]) => ({ name, version: String(ver), dev: true }))
  return deps.concat(devDeps).sort((a, b) => a.name.localeCompare(b.name))
}

// read npm's version from its bundled package.json next to the Node.js
// binary — works cross-platform without spawning a subprocess.
function infoNpmVersion () {
  let dir = path.dirname(process.execPath)
  while (true) {
    const f = path.join(dir, 'node_modules', 'npm', 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (pkg.name === 'npm') return pkg.version || '?'
    } catch { /* not here */ }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// walk up from a start directory looking for the nearest package.json,
// returning its containing directory (or null).
function infoProjectRoot (startDir) {
  if (!startDir) return null
  let dir = startDir
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function infoSections (bridge) {
  const server = bridge._SERVER || Object.create(null)
  const config = bridge._infoConfig || null
  const mu = process.memoryUsage()
  const nowStr = infoNowString()

  const sections = []

  const runtimeExtra = Object.entries(process.versions)
    .filter(([k]) => k !== 'node')
    .map(([k, v]) => k + ' ' + v)
    .join(', ')
  const cpuCount = (os.cpus() || []).length

  sections.push({
    title: 'System',
    pairs: [
        ['eta-server Version', VERSION],
        ['Node.js Version', process.version],
        ['Node.js Executable', process.execPath],
        ...(runtimeExtra
          ? [['Node.js Runtime', runtimeExtra]]
          : []),
        ['Platform', os.platform() + ' ' + os.release()],
        ['OS / Architecture', os.type() + ' / ' + os.arch()],
        ['Hostname', os.hostname()],
        ...(cpuCount
          ? [['Machine', cpuCount + ' CPU(s)']]
          : []),
        ['System Uptime',
          (os.uptime() / 3600).toFixed(1) + ' hours'],
        ['Process ID', String(process.pid)],
        ['Process Uptime',
          (process.uptime() / 3600).toFixed(1) + ' hours'],
        ['Current Working Directory', process.cwd()],
        ['Memory (RSS / Heap Used)',
          (mu.rss / 1048576).toFixed(1) + ' MB / ' +
          (mu.heapUsed / 1048576).toFixed(1) + ' MB'],
        ['Server Time', nowStr],
      ]
    })

  const fwPairs = [
    ['Eta', infoEtaVersion()],
    ['Node.js', process.version],
  ]
  const npmVer = infoNpmVersion()
  if (npmVer) fwPairs.push(['npm', npmVer])

  const docRoot = server.DOCUMENT_ROOT
    || infoProjectRoot(server.SCRIPT_DIRNAME || process.cwd())
  const pkgs = infoInstalledPackages(docRoot)
  if (pkgs.length) {
    const depCount = pkgs.filter(p => !p.dev).length
    const devCount = pkgs.filter(p => p.dev).length
    const counts = [depCount + ' dependencies', devCount + ' devDependencies']
      .filter(s => !s.startsWith('0 ')).join(', ')
    fwPairs.push(['Installed Packages (' + counts + ')',
      pkgs.map(p => p.name + ' ' + p.version + (p.dev ? ' (dev)' : '')).join('\n')])
  }

  sections.push({
    title: 'Frameworks & Dependencies',
    pairs: fwPairs
  })

  if (config) {
    const ttlMin = config.sessionTtl / 60000
    const ttlStr = Number.isInteger(ttlMin) ? String(ttlMin) : ttlMin.toFixed(2)
    const allowed = config.allowedHosts === null
      ? 'disabled (--behind-proxy or --allowed-hosts all)'
      : Object.keys(config.allowedHosts).join(', ')
    sections.push({
      title: 'Server Configuration',
      pairs: [
        ['Listen Address', config.host + ':' + config.port],
        ['Document Root', config.root],
        ['Session Timeout', ttlStr + ' minutes'],
        ['Behind Proxy', config.behindProxy ? 'yes' : 'no'],
        ['Allowed Hosts', allowed],
      ]
    })
  }

  sections.push({ title: 'This Request (_SERVER)', pairs: infoSortedEntries(server) })
  sections.push({
    title: 'Request Parameters',
      subTables: [
        { header: '_GET', pairs: infoSortedEntries(bridge._GET || Object.create(null)) },
        { header: '_POST', pairs: infoSortedEntries(bridge._POST || Object.create(null)) },
        { header: '_REQUEST (GET + POST)', pairs: infoSortedEntries(bridge._REQUEST || Object.create(null)) },
        { header: '_COOKIE', pairs: infoSortedEntries(bridge._COOKIE || Object.create(null)) },
        { header: '_FILES', pairs: infoFilesEntries(bridge._FILES || Object.create(null)) },
      ]
    })

  sections.push({ title: 'Session (_SESSION)', pairs: infoSortedEntries(bridge._SESSION || Object.create(null)) })
  sections.push({
    title: 'Environment Variables (process.env)',
      note: 'Names that look like secrets are masked — see the RESP.info() implementation.',
      pairs: infoMaskedEnv()
    })

  sections.push({
    title: 'Paths',
      pairs: [
        ['DOCUMENT_ROOT', server.DOCUMENT_ROOT || '-'],
        ['SCRIPT_FILENAME', server.SCRIPT_FILENAME || '-'],
        ['SCRIPT_DIRNAME', server.SCRIPT_DIRNAME || '-'],
        ['require() search path (node_modules)', infoModuleSearchPaths(server.SCRIPT_DIRNAME)],
      ]
    })

  sections.push({
    title: 'Bridge API (injected names)',
      pairs: [
        ['template text / <%= %> / <%~ %>', 'output channels: plain text passes through; <%= %> interpolates with HTML escaping; <%~ %> interpolates raw'],
        ['escape(value)', 'PHP htmlspecialchars equivalent: String() first, then escapes & < > " \', returns the escaped string'],
        ['RESP.header(name, value)', 'set a response header (Set-Cookie appends, others overwrite; output is buffered throughout rendering, no headers-already-sent limitation)'],
        ['RESP.status(code)', 'set the response status code'],
        ['RESP.redirect(url, code=302)', 'convenience redirect (does not stop rendering; the script returns itself)'],
        ['RESP.json(data)', 'JSON response (Content-Type: application/json; does not stop rendering, pair it with a top-level return)'],
        ['RESP.setcookie(name, value, opts)', 'set a cookie (values percent-encoded by default, matches PHP setcookie)'],
        ['RESP.writeraw(buf)', 'binary output channel: accepts bytes only; once used it short-circuits all text output; set Content-Type yourself via RESP.header'],
        ['RESP.write(str) / echo(str)', 'output text from a code block (like PHP echo); interleaves correctly with template text and <%= %>; short-circuited by writeraw() and json()'],
        ['RESP.info()', 'print a phpinfo()-style report of the server, request and runtime environment (HTML in HTTP mode, plain text in CLI mode)'],
        ['require(spec)', 'Node require anchored at this template\'s directory: relative paths resolve against the .eta file\'s dir, bare names climb up searching node_modules; for ESM use the dynamic await import() form'],
        ['_GET / _POST / _REQUEST', 'request parameters (plain objects; _REQUEST merges GET+POST, POST wins)'],
        ['_SERVER', 'request environment (REQUEST_METHOD / SCRIPT_NAME / PATH_INFO / REQUEST_URI / SCRIPT_FILENAME / SCRIPT_DIRNAME / DOCUMENT_ROOT / HTTP_* etc.)'],
        ['_ENV', 'environment variables snapshot (null-prototype dict, like PHP $_ENV)'],
        ['_FILES', 'uploaded files from multipart/form-data (PHP $_FILES shape: name/type/size/tmp_name/error per field; temp files cleaned up after the response)'],
        ['_BODY / _JSON', 'raw request body Buffer; auto-parsed when Content-Type contains json (null on failure)'],
        ['_COOKIE', 'client cookie dict (values percent-decoded)'],
        ['_SESSION', 'session object (signed cookie + timestamp, no server-side storage, sliding 30 minutes; mutate in place, do not reassign the whole object)'],
      ]
    })

  return sections
}

function infoRenderCli (sections) {
  const out = []
  for (const sec of sections) {
    out.push('[' + sec.title + ']')
    if (sec.pairs) {
      for (const [k, v] of sec.pairs) {
        out.push(k + ' => ' + String(v).replace(/\n/g, '\\n'))
      }
    }
    if (sec.subTables) {
      for (const sub of sec.subTables) {
        out.push('  [' + sub.header + ']')
        for (const [k, v] of sub.pairs) {
          out.push('  ' + k + ' => ' + String(v).replace(/\n/g, '\\n'))
        }
      }
    }
    out.push('')
  }
  return out.join('\n') + '\n'
}

function infoRenderHtml (sections) {
  const nowStr = infoNowString()
  const etaVer = infoEtaVersion()
  const rows = []

  for (const sec of sections) {
    rows.push('<h2>' + escapeHtml(sec.title) + '</h2>')
    if (sec.note) {
      rows.push('<p class="note">' + escapeHtml(sec.note) + '</p>')
    }
    if (sec.pairs) {
      rows.push('<table>')
      for (const [k, v] of sec.pairs) {
        rows.push('  <tr><td class="e">' + escapeHtml(k) + '</td>' +
          '<td class="v">' + escapeHtml(String(v)).replace(/\n/g, '<br>') + '</td></tr>')
      }
      if (!sec.pairs.length) {
        rows.push('  <tr><td class="e" colspan="2">(empty)</td></tr>')
      }
      rows.push('</table>')
    }
    if (sec.subTables) {
      for (const sub of sec.subTables) {
        rows.push('<h3>' + escapeHtml(sub.header) + '</h3>')
        rows.push('<table>')
        for (const [k, v] of sub.pairs) {
          rows.push('  <tr><td class="e">' + escapeHtml(k) + '</td>' +
            '<td class="v">' + escapeHtml(String(v)).replace(/\n/g, '<br>') + '</td></tr>')
        }
        if (!sub.pairs.length) {
          rows.push('  <tr><td class="e" colspan="2">(empty)</td></tr>')
        }
        rows.push('</table>')
      }
    }
  }

  return '<!DOCTYPE html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<title>etainfo()</title>\n' +
    '<style>\n' +
    'body {background:#fff; color:#222; margin:0; padding:0; ' +
      'font-family:Verdana,Arial,Helvetica,sans-serif; font-size:12px;}\n' +
    '.banner {background:#666699; color:#fff; padding:10px 18px;}\n' +
    '.banner h1 {margin:0; font-size:22px; font-weight:bold;}\n' +
    '.banner span {color:#ccccff;}\n' +
    '.wrap {max-width:920px; margin:0 auto; padding:8px 18px 40px 18px;}\n' +
    'h2 {background:#9999cc; color:#fff; font-size:14px; padding:4px 10px; ' +
      'margin:26px 0 0 0;}\n' +
    'h3 {color:#666699; font-size:12px; margin:10px 0 4px 0; ' +
      'font-weight:bold;}\n' +
    'table {border-collapse:collapse; width:100%; margin:0 0 2px 0;}\n' +
    'td {border:1px solid #9999cc; padding:3px 8px; vertical-align:top;}\n' +
    'td.e {background:#ccccff; font-weight:bold; width:300px;}\n' +
    'td.v {background:#f8f8ff; word-break:break-all; white-space:pre-wrap;}\n' +
    'td.h {background:#666699; color:#fff; font-weight:bold;}\n' +
    'p.foot {color:#888; margin-top:30px;}\n' +
    'p.note {color:#666; margin:4px 0 6px 0;}\n' +
    'a {color:#666699;}\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div class="banner">\n' +
    '<h1>etainfo() <span>- eta-server ' + escapeHtml(VERSION) + '</span></h1>\n' +
    '</div>\n' +
    '<div class="wrap">\n' +
    rows.join('\n') + '\n' +
    '<p class="foot">\n' +
    'etainfo() - generated at ' + escapeHtml(nowStr) + ' by eta-server ' +
      escapeHtml(VERSION) + '\n' +
    '(Eta ' + escapeHtml(etaVer) + ' / Node.js ' + escapeHtml(process.version) + ')\n' +
    '</p>\n' +
    '</div>\n' +
    '</body>\n' +
    '</html>\n'
}

function renderInfo (bridge) {
  const server = bridge._SERVER || Object.create(null)
  const isCli = !server.REQUEST_URI
  const sections = infoSections(bridge)
  return isCli ? infoRenderCli(sections) : infoRenderHtml(sections)
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
    binary: null,                // writeraw chunk list, null until touched
    text: null,                  // RESP.json() body, null until set
    writeBuf: [],                // RESP.write() / echo() text buffer
    header: function (name, value) {
      const n = String(name)
      const v = String(value)
      // validated NOW, not at res.writeHead(): thrown here it surfaces
      // as a render-time error (normal pages get a 500 whose stack
      // points at the offending template line; a .404.eta page
      // degrades cleanly to 404 via plain404OnError). Escaping all
      // the way to writeHead produced an opaque 500 — worse, the
      // failed writeHead's statusMessage survived into the retry
      // ("HTTP/1.1 500 OK") — and broke the fallback "never to a
      // non-404" promise (sixth review). Node's own validators,
      // zero dependencies
      http.validateHeaderName(n)
      http.validateHeaderValue(n, v)
      resp.headers.push([n, v])
    },
    status: function (code) {
      // stored raw: validated at assembly time (non 100-999 integer
      // becomes a 500); coercing here
      // would silently turn status('abc') / status(0) into 200
      resp.code = code
    },
    redirect: function (url, code) {
      resp.code = code || 302
      // through resp.header() so the Location value gets the same
      // render-time validation (a newline in the URL used to throw
      // at writeHead instead)
      resp.header('Location', url)
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
      // domain / path / expires come straight from template opts, so
      // validate the assembled line through the same channel as
      // RESP.header() (sixth review)
      http.validateHeaderValue('Set-Cookie', s)
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
      // chunks accumulate in a list and are joined once at assembly
      // time: concatenating on every call copied the whole buffer each
      // time, i.e. O(n^2) bytes for a template streaming out an image
      // in pieces (decision #20)
      if (resp.binary === null) resp.binary = []
      resp.binary.push(Buffer.from(chunk))
    },
    write: function (str) {
      // buffered text output from code blocks — like PHP echo.
      // accumulates in writeBuf and is prepended to the rendered
      // template text at assembly time; short-circuited by writeraw()
      // and json() just like template text is.
      resp.writeBuf.push(str === undefined || str === null
        ? '' : String(str))
    },
    info: function () {
      // phpinfo()-style diagnostic page; HTML in HTTP mode, plain text
      // in CLI mode. The bridge data is attached after makeResp returns.
      return renderInfo(resp._infoBridge || Object.create(null))
    },
    escape: escapeHtml,
    echo: null,   // alias for write, assigned below to avoid circular ref
  }
  resp.echo = resp.write
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
    // behind a trusted proxy the peer is the proxy, so the real client
    // comes from X-Forwarded-For / X-Real-IP (mod_remoteip semantics:
    // REMOTE_ADDR *becomes* the client, the raw peer stays visible in
    // HTTP_X_FORWARDED_FOR). Ignored without --behind-proxy so a
    // rebound page cannot forge an address
    REMOTE_ADDR: (ctx.behindProxy ? forwardedClientIp(headers) : '') ||
      req.socket.remoteAddress || '',
    CONTENT_TYPE: headers['content-type'] || '',
    CONTENT_LENGTH: headers['content-length'] || '',
    // CGI / PHP semantics: SERVER_NAME is the name the client asked
    // for, not the bind address (which reported a useless '0.0.0.0'
    // under -H 0.0.0.0). Safe to trust now that the Host header passes
    // the allowlist first (decision #20); the bind address remains the
    // fallback for clients that send no Host at all. X-Forwarded-Host
    // wins when trusted — a proxy that does NOT preserve Host puts the
    // public name only there
    // validated against the host grammar (decision #23): the allowlist
    // vouches for the Host header on the normal path, but --behind-proxy
    // skips it, so neither channel is trusted blindly here
    SERVER_NAME: (ctx.behindProxy
      ? validHostname(hostnameOf(headers['x-forwarded-host'])) : '') ||
      validHostname(hostnameOf(headers['host'])) || ctx.host,
    SERVER_PORT: String(ctx.port),
    // https terminates at the proxy, so the scheme the client actually
    // used is only knowable from X-Forwarded-Proto
    REQUEST_SCHEME: (ctx.behindProxy ? forwardedScheme(headers) : '') ||
      'http',
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
    if (opts.plain404OnError) {
      // the "a fallback page never turns a 404 into anything else"
      // promise covers the body read too, not just rendering: an
      // over-cap POST to a missing path used to answer 413 from the
      // .404.eta path (decision #20, the fourth hole in that family)
      console.error('eta-server: fallback page body read failed (' +
        ((err && err.message) || err) +
        '), degrading to the built-in 404')
      return sendError(res, 404, 'Not Found')
    }
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
  let files = Object.create(null)
  let uploadedTempFiles = []
  const ctype = String(req.headers['content-type'] || '')
  if (ctype.indexOf('multipart/form-data') >= 0) {
    const parsed = parseMultipart(bodyBuf, ctype)
    if (parsed.error) {
      // clean up any temp files that were created before the limit was hit
      for (const f of parsed.tempFiles) {
        try { fs.unlinkSync(f) } catch (e) { /* already gone */ }
      }
      if (parsed.tmpDir) {
        try { fs.rmdirSync(parsed.tmpDir) } catch (e) { /* ignore */ }
      }
      const err = parsed.error
      err.status = 413
      if (opts.plain404OnError) {
        console.error('eta-server: fallback page multipart parse failed (' +
          err.message + '), degrading to the built-in 404')
        return sendError(res, 404, 'Not Found')
      }
      return sendError(res, 413, 'Payload Too Large', err.message)
    }
    post = parsed.fields
    files = parsed.files
    uploadedTempFiles = parsed.tempFiles
    // clean up uploaded temp files once the response finishes or the
    // connection closes (whichever comes first, including aborts)
    if (uploadedTempFiles.length || parsed.tmpDir) {
      const cleanupUploads = () => {
        for (const f of uploadedTempFiles) {
          try { fs.unlinkSync(f) } catch (e) { /* already gone */ }
        }
        if (parsed.tmpDir) {
          try { fs.rmdirSync(parsed.tmpDir) } catch (e) { /* ignore */ }
        }
      }
      res.once('close', cleanupUploads)
    }
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
  // null-prototype even when there is no cookie at all: the restored
  // path has been null-proto since decision #20, but the fresh path was
  // a plain {}, which made _SESSION the one bridge dict whose prototype
  // depended on whether the visitor already had a session (decision #22)
  const decoded = decodeSession(cookies[SESSION_COOKIE], ctx.secret)
  const session = decoded || Object.create(null)
  // only a cookie we could VERIFY is ours to clear. The cookie name is
  // a global constant and cookies are not port-scoped, so a second
  // eta-server on another port receives the first one's cookie, fails
  // the HMAC, and used to answer with the Max-Age=0 clearing line —
  // i.e. opening site B logged you out of site A (decision #22). An
  // unverifiable value is left alone; --secret (decision #21) is still
  // how two roots are made to agree on one session
  const hadSessionCookie = (decoded !== null)

  const resp = makeResp(opts.defaultStatus)
  const data = {
    _GET: query,
    _POST: post,
    _REQUEST: Object.assign(Object.create(null), query, post),
    _SERVER: buildServerEnv(req, parsed, scriptAbs, scriptName, pathInfo,
      ctx, reqStart),
    _COOKIE: cookies,
    _SESSION: session,
    _ENV: buildEnvSnapshot(),
    _FILES: files,
    _BODY: bodyBuf,
    _JSON: jsonVal,
    RESP: resp,
    echo: resp.echo,
    escape: escapeHtml,
    require: makeDevRequire(ctx.rootReal, scriptAbs),
    _infoConfig: {
      sessionTtl: ctx.sessionTtl,
      behindProxy: ctx.behindProxy,
      allowedHosts: ctx.allowedHosts,
      host: ctx.host,
      port: ctx.port,
      root: ctx.root,
    },
  }
  resp._infoBridge = data
  resp._infoConfig = data._infoConfig

  let html = ''
  try {
    // read the file ourselves and render the string: bypasses eta's
    // file resolution quirks and gives mtime-based reload for free
    const src = stripBom(await fs.promises.readFile(scriptAbs, 'utf8'))
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
    if (data._SESSION === null || data._SESSION === undefined ||
      data._SESSION === false) {
      // the three ways people write "no session"; every other
      // primitive is a mistake and gets warned about below. `false`
      // used to fall into that warning despite the docs listing it
      // as a clear (decision #20)
      sessionOut = Object.create(null)
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
  // Secure is added when the client actually used https, which this
  // server can only learn from a trusted proxy (node:http never
  // terminates TLS itself). Without it the session cookie of a
  // documented reverse-proxy deployment travels over any plain-http
  // request to the same host; with it, local http development is
  // untouched because the scheme is then plain http (decision #23)
  const cookieAttrs = '; Path=/; HttpOnly; SameSite=Lax' +
    ((ctx.behindProxy && forwardedScheme(req.headers) === 'https')
      ? '; Secure' : '')
  if (Object.keys(sessionOut).length > 0) {
    let sessCookie = ''
    try {
      sessCookie = SESSION_COOKIE + '=' +
        encodeSession(sessionOut, ctx.secret, ctx.sessionTtl) +
        cookieAttrs
    } catch (err) {
      // JSON.stringify throws on a BigInt, a circular structure or a
      // toJSON() that throws. This was the last unguarded throw site
      // after rendering, and therefore the fifth escape from the "a
      // fallback page never turns a 404 into anything else" promise
      // that decisions #18/#19/#20 closed for render exceptions,
      // invalid statuses, oversized sessions and invalid headers
      // (decision #22). The PRD requires JSON-serializable session
      // values; name the constraint instead of leaking a framework
      // stack that points nowhere near the offending template line
      if (opts.plain404OnError) {
        console.error('eta-server: fallback page stored a non-serializable ' +
          '_SESSION value, degrading to the built-in 404: ' +
          ((err && err.message) || err))
        return sendError(res, 404, 'Not Found')
      }
      return sendError(res, 500, 'Internal Server Error',
        '_SESSION values must be JSON-serializable: ' +
        ((err && err.message) || err))
    }
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
    setCookies.push(SESSION_COOKIE + '=' + cookieAttrs + '; Max-Age=0')
  }
  if (setCookies.length > 0) headers['Set-Cookie'] = setCookies

  // ---- last-resort response guard: RESP.header / setcookie / redirect
  // all validate at record time, so nothing invalid should reach
  // writeHead; should it ever happen anyway, keep it out of the
  // dispatcher catch-all. res.statusMessage must be cleared first: a
  // failed writeHead leaves its reason phrase behind, and the retry
  // would emit "HTTP/1.1 500 OK" (sixth review) ----
  const writeFailed = (err) => {
    res.statusMessage = undefined
    if (opts.plain404OnError) {
      console.error('eta-server: fallback response assembly failed (' +
        ((err && err.message) || err) +
        '), degrading to the built-in 404')
      return sendError(res, 404, 'Not Found')
    }
    return sendError(res, 500, 'Internal Server Error',
      String((err && err.stack) || err))
  }

  if (noBody) {
    try {
      res.writeHead(resp.code, headers)
    } catch (err) {
      return writeFailed(err)
    }
    res.end()
    return
  }

  if (!('Content-Type' in headers) && !hmap.has('content-type')) {
    headers['Content-Type'] = 'text/html; charset=utf-8'
  }

  // "edits take effect immediately" (decision #1) is only true of the
  // server: a response carrying neither Cache-Control nor Last-Modified
  // is fair game for the browser's heuristic cache, so an unchanged URL
  // could still answer from disk. no-store by default, and templates
  // wanting real caching just set the header themselves (decision #20)
  if (!hmap.has('cache-control')) headers['Cache-Control'] = 'no-store'

  // ---- pick body: binary short-circuit > RESP.json() > rendered html ----
  // writeBuf holds any RESP.write()/echo() calls made outside the Eta
  // plugin's reach (e.g. before/after rendering); inside templates the
  // plugin pushes directly into __eta.res so writeBuf stays empty.
  let body = html
  if (resp.binary !== null) {
    body = Buffer.concat(resp.binary)       // writeraw chunk list
  } else if (resp.text !== null) {
    body = resp.text
  } else if (resp.writeBuf.length) {
    body = resp.writeBuf.join('') + html
  }

  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  headers['Content-Length'] = buf.length
  try {
    res.writeHead(resp.code, headers)
  } catch (err) {
    return writeFailed(err)
  }
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/* ---------------------------------------------------------------------
 * static files
 * ------------------------------------------------------------------- */

// Promise wrappers around the numeric-fd fs APIs.  We intentionally avoid
// fs.promises.open() here: its FileHandle closes the descriptor on garbage
// collection, and handing handle.fd to fs.createReadStream({ fd }) makes
// two owners for the same fd, which produces EBADF when the stream and the
// GC finalizer both call close().
function openFd (p) {
  return new Promise((resolve, reject) => {
    fs.open(p, 'r', (err, fd) => {
      if (err) return reject(err)
      resolve(fd)
    })
  })
}

function fstatFd (fd) {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (err, stat) => {
      if (err) return reject(err)
      resolve(stat)
    })
  })
}

function closeFd (fd) {
  return new Promise((resolve) => {
    fs.close(fd, () => resolve())
  })
}

async function sendStatic (req, res, abs, type) {
  // open once, fstat the SAME fd: a stat-then-stream pair can observe
  // two generations of the file when it is rewritten in between, and
  // the declared Content-Length would disagree with the streamed bytes
  let fd
  try {
    fd = await openFd(abs)
  } catch (e) {
    return sendError(res, 404, 'Not Found')
  }
  let stat
  try {
    stat = await fstatFd(fd)
  } catch (e) {
    await closeFd(fd)
    return sendError(res, 404, 'Not Found')
  }
  if (!stat.isFile()) {
    await closeFd(fd)
    return sendError(res, 404, 'Not Found')
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    // same reason as the template branch: a dev server must not let
    // the browser heuristically cache an asset it is about to re-edit
    'Cache-Control': 'no-store'
  })
  if (req.method === 'HEAD') {
    await closeFd(fd)
    res.end()
    return
  }
  // fd handed over to the stream (autoClose releases it on end/error).
  // The numeric fd is used so the close path goes through fs.close,
  // which existing regression tests intercept to verify that client
  // aborts do not leak descriptors.
  const stream = fs.createReadStream('', { fd })
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
    st = await fs.promises.stat(fb)
  } catch (e) { /* no fallback */ }
  if (st && st.isFile()) {
    // the one deliberate exception to gateReal(): the fallback page is
    // a dot file by design, so the private-name rule would reject the
    // very file this branch exists to render. Containment and
    // self-protection still apply — a '.404.eta' symlinked out of the
    // root, or at the server's own source, is not rendered
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
  // ---- Host allowlist, before anything else touches the path: a
  // foreign Host means the request arrived through a name this server
  // was never reached by, i.e. a DNS rebind (decision #20). 403 with a
  // pointer to the flag rather than the fail-closed 404 used elsewhere:
  // this one is a configuration problem, and a silent 404 would be
  // undebuggable for someone running behind a custom dev hostname ----
  if (!isHostAllowed(ctx.allowedHosts, req.headers['host'])) {
    const host = String(req.headers['host'])
    console.error('eta-server: blocked by host allowlist: "' + host +
      '" (' + req.method + ' ' + req.url + ')')
    return sendError(res, 403, 'Forbidden',
      'Host header "' + host + '" is not on the allowlist.\n\n' +
      'This dev server answers to loopback names, *.localhost, literal\n' +
      'IP addresses and its own bind address only, so a remote page\n' +
      'cannot reach it by pointing a hostname at 127.0.0.1.\n\n' +
      'Serving a custom hostname on purpose? Start the server with\n' +
      '  --allowed-hosts ' + hostnameOf(host) + '\n' +
      'or turn the check off entirely with --allowed-hosts all.')
  }
  // ---- slash merging: //a///b -> 308 /a/b (checked on the raw URL
  // first, because new URL() would treat a leading '//' as
  // protocol-relative and misparse the host part). An absolute-form
  // request target (e.g. GET http://host/path HTTP/1.1) is split into
  // its scheme://authority prefix and path, so only the path is
  // normalized and the protocol's own '//' is never merged. ----
  const rawUrl = req.url || ''
  const rawPath = rawUrl.split(/[?#]/)[0]
  // '\\' is EQUIVALENT to '/' in an http(s) URL per the WHATWG standard,
  // which is what the new URL() call below implements and what browsers
  // apply before they ever send the request. Two consequences, both
  // reproduced (decision #22): '/\\host/admin.eta' parsed as an
  // authority, so the host part was silently dropped and the request
  // served '/admin.eta' — the served path bearing no resemblance to the
  // request target that a fronting proxy, an access rule or the access
  // log sees; and the 308 below, splicing the raw target, answered
  // '//\\evil.example/x' with 'Location: /\\evil.example/x', which the
  // browser re-normalizes into '//evil.example/x' — an open redirect.
  // Normalizing here makes the guard see exactly what the parser will,
  // and the redirect target carries no backslash at all. A literal
  // backslash in a filename stays reachable through %5C, which is
  // decoded later and never passes through this guard (decision #12)
  const ABSOLUTE_FORM_RE = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)/i
  const absMatch = ABSOLUTE_FORM_RE.exec(rawPath)
  const absPrefix = absMatch ? absMatch[1] : ''
  const pathForCheck = absPrefix ? rawPath.slice(absPrefix.length) : rawPath
  const pathNorm = pathForCheck.replace(/\\/g, '/')
  if (pathNorm !== pathForCheck || pathNorm.indexOf('//') >= 0) {
    const loc = absPrefix + pathNorm.replace(/\/{2,}/g, '/') +
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
      stat = await fs.promises.stat(scriptAbs)
    } catch (e) { /* handled below */ }
    if (stat && stat.isFile()) {
      // a symlink / junction inside root pointing outside must not be
      // rendered; neither may a route whose real location is the
      // server's own file or a hidden name
      if (!gateReal(req, ctx.rootReal, scriptAbs)) {
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
    stat = await fs.promises.stat(target)
  } catch (e) {
    return sendNotFound(req, res, ctx, parsed, reqStart)
  }
  // the gate applies to both directories and static files: a symlink /
  // junction escaping the root is a plain 404 — as is any route whose
  // real location resolves to the server's own file or to a hidden name
  // (a symlink pointing at '.config/' inside root)
  const real = gateReal(req, ctx.rootReal, target)
  if (!real) {
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
      const idxStat = await fs.promises.stat(idxEta)
      if (idxStat.isFile()) {
        // index candidates go through the gate on their own: the
        // directory passed, but an index symlink inside it may still
        // point outside the root — or at the server's own file, which
        // the containment check cannot catch because the target is
        // inside the root
        if (!gateReal(req, ctx.rootReal, idxEta)) {
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
        const idxStat = await fs.promises.stat(f)
        if (idxStat.isFile()) {
          const realF = gateReal(req, ctx.rootReal, f)
          if (!realF) {
            return sendNotFound(req, res, ctx, parsed, reqStart)
          }
          // Content-Type judged by the realpath extension (decision
          // #12), not the symlink's own name; outside the whitelist
          // stays fail-closed 404 (no fallback to the next candidate)
          const type = STATIC_TYPES[path.extname(realF).toLowerCase()]
          if (!type) {
            return sendNotFound(req, res, ctx, parsed, reqStart)
          }
          return await sendStatic(req, res, realF, type)
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
  return await sendStatic(req, res, real, type)
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
    // null-prototype like every other bridge dict, and like the HTTP
    // side on both the fresh and the restored path (decision #22)
    _SESSION: Object.create(null),
    _ENV: buildEnvSnapshot(),
    _FILES: Object.create(null),
    _BODY: Buffer.alloc(0),
    _JSON: null,
    RESP: resp,
    escape: escapeHtml,
    require: createRequire(script === '-'
      ? path.join(baseDir, 'stdin.js') : scriptAbs),
  }
  resp._infoBridge = data
  resp._infoConfig = null

  const eta = new Eta({ views: baseDir, cache: false, useWith: true, autoTrim: false, outputFunctionName: '__templateOutputFunction', plugins: [WRITE_HOOK_PLUGIN] })
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
    body = Buffer.concat(resp.binary)       // writeraw chunk list
  } else if (resp.text !== null) {
    body = resp.text
  } else if (resp.writeBuf.length) {
    body = resp.writeBuf.join('') + html
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
  // null = check disabled; immutable startup config like every other
  // ctx member (decision #14). --behind-proxy asserts that a proxy owns
  // this port, which is exactly the assertion the Host check would
  // otherwise ask for — so it stands in for the allowlist. An explicit
  // --allowed-hosts still wins: naming your domains is strictly
  // stronger than trusting whatever the proxy forwards
  const behindProxy = !!options.behindProxy
  const allowedHosts = (behindProxy && !options.allowedHosts)
    ? null : buildAllowedHosts(host, options.allowedHosts)

  // sliding session timeout, in minutes (--session-ttl /
  // options.sessionTtl, decision #24); absent = the built-in 30
  // minutes. Rejected up front like a bad document root: a silent
  // fallback to the default would make "configured" TTLs expire on
  // the wrong schedule with no diagnostic anywhere
  let sessionTtl = SESSION_TTL
  if (options.sessionTtl != null) {
    const m = Number(options.sessionTtl)
    if (!Number.isFinite(m) || m <= 0) {
      return Promise.reject(new Error('invalid session TTL "' +
        options.sessionTtl + '" (must be a positive number of minutes)'))
    }
    sessionTtl = Math.max(1, Math.round(m * 60 * 1000))
  }

  const ctx = {
    root: root,
    // canonical: containment and the hidden-path rule compare relative
    // paths against this, so it must be produced by the same resolver
    // as every realInside() result (decision #20)
    rootReal: realpathCanon(root),
    host: host,
    port: port,
    // options.secret (--secret / ETA_SERVER_SECRET) overrides the
    // persisted key AND the per-root derivation (decision #21)
    secret: deriveSecret(root, options.secret),
    sessionTtl: sessionTtl,
    eta: new Eta({ views: root, cache: false, useWith: true, autoTrim: false, outputFunctionName: '__templateOutputFunction', plugins: [WRITE_HOOK_PLUGIN] }),
    accessLog: accessLog,
    allowedHosts: allowedHosts,
    behindProxy: behindProxy,
  }

  if (allowedHosts === null) {
    if (behindProxy) {
      // not the same risk as --allowed-hosts all: the flag's contract is
      // "only the proxy can reach this port", so say what breaks it
      console.error('eta-server: --behind-proxy: Host check off, ' +
        'X-Forwarded-For / -Proto / -Host trusted. Keep the bind address ' +
        'private (-H 127.0.0.1) — on a reachable interface any client can ' +
        'now forge its address and scheme')
    } else {
      console.error('eta-server: warning: Host allowlist disabled ' +
        '(--allowed-hosts all) — any web page the browser visits can now ' +
        'reach this server through a rebound DNS name and read the responses')
    }
  }

  // an explicit key silently drops the per-site isolation decision #13
  // documents, so say it once at startup like every other flag that
  // trades a default away (decision #21)
  if (options.secret) {
    console.error('eta-server: session key taken from --secret / ' +
      'ETA_SERVER_SECRET — the per-root derivation is off, so every ' +
      'document root started with this secret shares one session ' +
      'namespace (sessions also survive across machines)')
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
      if (stream) stream.write(accessLine(req, res, state, start, ctx) + '\n')
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
  console.log('  --allowed-hosts <l> extra Host names to accept, comma')
  console.log('                      separated (default: loopback names,')
  console.log('                      *.localhost, literal IPs and the bind')
  console.log('                      address); "all" disables the check')
  console.log('  --secret <value>    session signing key, set it yourself')
  console.log('                      instead of the automatic per-user /')
  console.log('                      per-root key; instances sharing a secret')
  console.log('                      accept each other\'s session cookies.')
  console.log('                      Env: ETA_SERVER_SECRET (HTTP mode only)')
  console.log('  --session-ttl <m>   sliding session timeout in minutes')
  console.log('                      (default: 30, HTTP mode only)')
  console.log('  --behind-proxy      running behind a reverse proxy: skip the')
  console.log('                      Host check and take the client address /')
  console.log('                      scheme / host from X-Forwarded-For,')
  console.log('                      X-Forwarded-Proto, X-Forwarded-Host')
  console.log('  -h, --help          show this help')
  console.log('')
  console.log('CLI mode:')
  console.log('  script              script path (any extension); "-" reads stdin')
  console.log('  args...             everything after the script name is passed')
  console.log('                      through verbatim, readable via _SERVER.argv')
}

function parseArgs (argv) {
  const opts = { root: process.cwd(), port: 5000, host: '127.0.0.1',
    quiet: false, accessLog: null, allowedHosts: null, behindProxy: false,
    // env channel for the same value, and the one to prefer: a command
    // line is readable by every process on the box (ps / Task Manager)
    // and lands in shell history, while the supervisor config in the
    // README keeps it in a file on disk. --secret wins when both are set
    secret: process.env.ETA_SERVER_SECRET || null,
    sessionTtl: null,
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
    } else if (a === '--allowed-hosts') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      opts.allowedHosts = args[++i]
    } else if (a === '--secret') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      const v = args[++i]
      // a blank value would look configured and silently fall back to
      // the automatic key — the one outcome nobody asked for
      if (!v.trim()) throw new Error('empty value for ' + a)
      opts.secret = v
    } else if (a === '--session-ttl') {
      if (i + 1 >= args.length) throw new Error('missing value for ' + a)
      const m = Number(args[++i])
      if (!Number.isFinite(m) || m <= 0) {
        throw new Error('invalid session TTL (must be a positive number of minutes)')
      }
      opts.sessionTtl = m
    } else if (a === '--behind-proxy') {
      opts.behindProxy = true
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
      allowedHosts: opts.allowedHosts, behindProxy: opts.behindProxy,
      secret: opts.secret,
      sessionTtl: opts.sessionTtl,
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
