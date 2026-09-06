// Fetch helpers shared by the boot flow.

import { cachedResponse, evictFromCache, storeInCache } from "./cache.js";
import { verifyDigest } from "./hash.js";
import { log } from "./log.js";

// A fetch can simply fail: a connection reset, a CDN hiccup, a browser
// declining under pressure. All of them arrive as a bare TypeError
// with no status and no URL. Retrying a few times turns most of them
// into a slower success rather than a dead boot.
const ATTEMPTS = 4;
const BACKOFF_MS = 400;

const NOT_FOUND = 404;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read a response body into one buffer, reporting chunk sizes as they
// arrive.
async function drain(res, { onBytes, onTotal } = {}) {
  const length = res.headers.get("Content-Length");
  onTotal?.(length === null ? null : Number(length));

  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    onBytes?.(value.byteLength);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// The bytes against the digest that named them. Null means good;
// otherwise the reason. An unverifiable digest (no SubtleCrypto) is not
// a reason: the boot proceeds unverified rather than not at all.
async function check(bytes, digest) {
  if (digest === null || digest === undefined) {
    return null;
  }
  const ok = await verifyDigest(bytes, digest);
  return ok === false ? `${digest.algorithm} does not match` : null;
}

// Fetch a URL into bytes, through the persistent cache. A hit is read
// from storage (and still reports its size, so a progress row fills);
// a miss is fetched, returned, and stored once it is complete.
//
// `digest` is { algorithm, hex } or null. A body can arrive short
// without the fetch failing — a mobile connection that drops
// mid-download looks like a clean end — and a bad body must be neither
// used nor kept: a cached hit that fails is evicted and fetched again, a
// download that fails is retried like any other failed attempt, and only
// what passes is stored.
//
// A 404 is not retried. Mirrors delete superseded packages within hours
// of a sync, so a missing file is an answer, not a hiccup: the error
// carries `.status = 404` and the caller moves to the next mirror.
//
// `attempts` overrides how many times a failure is retried. A mirror is
// worth all four — the file is on it and the boot needs it — but a
// caller with many URLs and a low expectation of any of them working (a
// recipe's sources, most of which no page is allowed to read) asks for
// fewer rather than paying the backoff over and over.
export async function fetchWithProgress(url, options = {}) {
  const digest = options.digest ?? null;
  const attempts = options.attempts ?? ATTEMPTS;

  const hit = await cachedResponse(url);
  if (hit !== null) {
    const bytes = await drain(hit, options);
    const problem = await check(bytes, digest);
    if (problem === null) {
      return bytes;
    }
    log(`cached copy of ${url} is bad (${problem}); fetching again`);
    await evictFromCache(url);
    options.onBytes?.(-bytes.byteLength);
  }

  let downloaded = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      // A retry restarts the download, so the progress a failed
      // attempt reported has to be taken back or the bar overcounts.
      const onBytes = (n) => {
        downloaded += n;
        options.onBytes?.(n);
      };
      const bytes = await drain(res, { ...options, onBytes });

      const problem = await check(bytes, digest);
      if (problem !== null) {
        throw new Error(problem);
      }

      await storeInCache(url, bytes);
      return bytes;
    } catch (err) {
      options.onBytes?.(-downloaded);
      downloaded = 0;

      if (err.status === NOT_FOUND) {
        const gone = new Error(`${url}: HTTP ${NOT_FOUND}`);
        gone.status = NOT_FOUND;
        throw gone;
      }

      if (attempt >= attempts) {
        log(`giving up on ${url} after ${attempt} attempts: ${err.message}`);
        throw new Error(`${url}: ${err.message}`);
      }
      log(`retrying ${url} (attempt ${attempt} failed: ${err.message})`);
      await delay(BACKOFF_MS * attempt);
    }
  }
}

// Download a URL into the browser's HTTP cache and throw the bytes
// away, reporting progress on the way.
//
// This is for the engine's wasm, which the page deliberately does not
// hold: emscripten fetches it by URL and hands the response to
// WebAssembly.instantiateStreaming, which compiles as the bytes arrive
// and lets the browser keep the compiled code across visits — neither
// of which happens for a buffer the page passes in. What the page can
// still do is get the download on its way with a progress bar, so
// that later fetch is answered from the HTTP cache.
export async function warmHttpCache(url, options = {}) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  await drain(res, options);
}

// Run tasks with a bounded number in flight, preserving result order.
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
