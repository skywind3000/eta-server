# Draft: Hot Reload for ESM Modules Required by Templates

> Status: **draft / decision pending**. Not implemented.
> Investigation date: 2026-08. Verified against Node.js v24.19.0 (Windows).

## Problem

When a `.eta` template `require()`s a local library (e.g. `./mylib.ts`), edits to
that file are **not** picked up on subsequent requests if the file uses ESM
syntax (`import` / `export`). CommonJS-style files (`module.exports`) reload
correctly. The discrepancy is user-visible and defeats the "edits take effect
immediately" promise for the recommended thin-template + `.ts`-library workflow.

### Verified reproduction

| Library style | Edit file, re-request | Result |
|---|---|---|
| CJS (`module.exports`) | next request | ✅ new code |
| ESM (`import`/`export`) | next request, any number of times | ❌ stale forever, restart required |

Additionally, even in CJS mode invalidation is **shallow**: only the entry
file (the one the template requires directly) is evicted; transitive
dependencies keep their old cached copies (documented known limitation).

## Root cause analysis (experimentally confirmed)

`require(esm)` (stable since Node 22.12) is cached in **two layers**:

1. **`require.cache` facade entry** — a CJS `Module` shell marked with the
   internal symbol `kIsCachedByESMLoader`. This is what the existing
   `makeDevRequire()` hot-reload logic deletes (`delete require.cache[resolved]`).
2. **ESM loader `loadCache`** — inside the (internal) cascaded ESM loader,
   keyed by the plain file URL (`file:///.../mylib.ts`, no query string).
   `importSyncForRequire()` consults this cache *before* compiling the source
   that the CJS loader passes in:

   ```js
   // node:internal/modules/esm/loader (Node 24 source)
   importSyncForRequire(mod, filename, source, isMain, parent) {
     const url = pathToFileURL(filename).href;
     let job = this.loadCache.get(url, kImplicitTypeAttribute);
     if (job !== undefined) { ...return stale namespace... }
     const wrap = compileSourceTextModule(url, source, this);   // fresh compile
     ...
   }
   ```

Deleting layer 1 is therefore a no-op for ESM: the next `require()` falls
through to layer 2, which returns the stale evaluated module.

### Dead ends that were tested and rejected

| Approach | Result |
|---|---|
| URL versioning (`?t=<mtime>` query) via `registerHooks` resolve hook | ❌ `import()` honors query cache-busting, but the `require(esm)` path builds a plain `pathToFileURL(filename)` URL and ignores hook-returned URLs for its cache lookup |
| Bumping a global "generation" counter + URL versioning | ❌ same reason |
| Only deleting the `require.cache` facade (current behavior) | ❌ layer 2 still hits |
| `load` hook returning fresh source | ❌ cache hit short-circuits before the load hook runs |
| Making template `require` async (to use `import()` with query busting) | ❌ breaks synchronous template semantics |

## Option 1 — Evict the ESM `loadCache` directly (internal API)

### Mechanism (prototype verified end-to-end)

```
1st            : lib1/dep1   (tracked: 2 files)
no edits       : module identity stable (cache preserved)
edit deep dep  : lib1/dep2   ← transitive reload works (better than CJS shallow!)
edit entry lib : lib2/dep2
edit dep again : lib2/dep3
```

Components:

1. **Self re-exec with `--expose-internals`**: if missing from
   `process.execArgv`, spawn self with the flag (`child_process.spawn`,
   stdio inherit, forward exit code). ~10 lines, cross-platform.
2. **`registerHooks` resolve hook**: record every in-root file URL that gets
   resolved (this also observes imports inside ESM graphs → full transitive
   tracking). Maintain a `Map<path, mtimeMs>`.
3. **`devRequire` mtime check (existing pattern, extended)**: per request,
   `statSync` all tracked files; if any is newer, bulk-evict:
   `loader.loadCache.delete(pathToFileURL(p).href)` + `delete require.cache[p]`
   for every tracked file (whole in-root graph reloads together — simple,
   correct semantics), then refresh recorded mtimes.

### Cost

| Dimension | Cost |
|---|---|
| Runtime, no edits | one `statSync` per tracked in-root file per request (few to dozens of files, ~10–50 µs each on Windows) — negligible |
| After an edit | one full re-read + type-strip + recompile of the in-root ESM graph on the next request; same order as today's CJS reload |
| Memory | zero growth — evicted module jobs are GC-eligible (unlike URL versioning, which leaks one instance per version) |
| Module identity | reset after edit (module-level state re-initialized) — consistent with existing CJS reload semantics |
| Startup | one extra re-exec, tens of ms |
| Implementation size | ~80–120 lines |

### Risks

- **Unstable internal API**: `getOrInitializeCascadedLoader` / `loadCache`
  require `require('internal/...')` under `--expose-internals`. Node gives no
  compatibility guarantee for internals.
- **Version spread**: the "cascaded loader" structure (`getOrInitializeCascadedLoader`,
  `importSyncForRequire`, `LoadCache`) is from the Node 24-era loader rewrite;
  Node 22.x internals differ (engines floor is 22.18) → per-major feature
  detection branches needed, or accept 24+ only.
- `--expose-internals` is not permitted in `NODE_OPTIONS` (security block),
  hence the re-exec requirement.

### Mandatory defensive posture (no-crash rule)

All internal access is wrapped in startup feature detection; on any failure
`evictEsm = null` and behavior **degrades to status quo** (ESM edits require
restart; CJS hot reload unaffected), with a one-line startup notice. A Node
upgrade can at worst disable the feature — never crash the server.

## Option 2 — Auto-restart on ESM change (zero-risk, public API only)

- eta-server is **fully stateless** (sessions live in signed cookies; no
  files, no in-process user data), so a process restart is invisible to users.
- Watch the document root (`fs.watch`, recursive); when a tracked ESM file
  changes, restart the serving process (supervisor parent + worker child, or
  self-exec with inherited listen socket on platforms that support it).
- Restart cost: tens of ms of brief unavailability — acceptable for a dev server.
- Uses only public APIs (`fs.watch`, `child_process`): **immune to any Node
  upgrade**.
- Downside: slightly coarser UX than in-place reload; all in-root module state
  (CJS caches included) resets; in-flight requests during restart are dropped
  (dev-server acceptable).

## Option 3 — Hybrid (recommended)

1. At startup, feature-detect the internal eviction path (Option 1).
2. If available → seamless in-place ESM hot reload.
3. If unavailable → fall back to Option 2 (auto-restart) automatically.
4. If even that is undesirable in some deployment → degrade to status quo +
   documented limitation (restart, or write libs in CJS style).

Worst case under any future Node release: behavior is a restart, never a crash.

## Also worth noting

- Option 1's bulk-graph eviction incidentally **fixes the shallow-invalidation
  limitation for ESM** (editing a transitive dependency reloads the whole
  chain). CJS keeps its current shallow semantics unless we extend
  `hotMtimes` tracking the same way.
- Per spec decision rules: whichever option ships, `docs/spec.md` gets a new
  decision entry and `docs/prd.md` semantics are updated in the same commit.

## Open questions

- Accept the internal-API maintenance tax (per-major detection branches), or
  gate Option 1 to "Node ≥ 24 only" and let 22.x users get Option 2?
- Should CJS hot reload also be upgraded to deep (transitive) invalidation
  while we are touching this area, or stay shallow for behavior stability?
- Debounce window for Option 2 restart (editors may write twice in quick
  succession, e.g. save + format).
