// Tests the fetch helpers. The rules that matter to a boot are: a 404
// is an answer and is never retried (a mirror deletes a superseded
// package within hours, and the caller has to move on to the next
// source), anything else is retried a few times, and a body that does
// not match its digest is neither used nor kept.
//
// cache.js opens the Cache API once and keeps it, so there is one fake
// cache for the file and a URL per test rather than a cache per test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchWithProgress,
  mapConcurrent,
  warmHttpCache,
} from "../../site/js/net.js";

const encoder = new TextEncoder();
const BODY = encoder.encode("hello tryarch\n");

const ok = (bytes) =>
  new Response(bytes, {
    status: 200,
    headers: { "Content-Length": String(bytes.byteLength) },
  });

// An in-memory stand-in for the Cache API.
const store = new Map();
globalThis.caches = {
  open: async () => ({
    match: async (url) => {
      const bytes = store.get(url);
      return bytes === undefined ? undefined : ok(bytes);
    },
    put: async (url, res) => {
      store.set(url, new Uint8Array(await res.arrayBuffer()));
    },
    delete: async (url) => store.delete(url),
  }),
};

async function sha256(bytes) {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const GOOD = { algorithm: "SHA-256", hex: await sha256(BODY) };

test("a fetched body is returned and kept", async () => {
  const url = "https://mirror.invalid/kept.pkg.tar.zst";
  globalThis.fetch = async () => ok(BODY);

  const bytes = await fetchWithProgress(url);
  assert.deepEqual([...bytes], [...BODY]);
  assert.deepEqual([...store.get(url)], [...BODY]);
});

test("a cached body is used without a fetch", async () => {
  const url = "https://mirror.invalid/hit.pkg.tar.zst";
  store.set(url, BODY);
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return ok(BODY);
  };

  let seen = 0;
  const bytes = await fetchWithProgress(url, { onBytes: (n) => (seen += n) });
  assert.deepEqual([...bytes], [...BODY]);
  assert.equal(fetched, 0);
  // A hit still reports its size, so a progress row fills rather than
  // sitting at zero.
  assert.equal(seen, BODY.byteLength);
});

test("a cached body that fails its digest is evicted and fetched again", async () => {
  const url = "https://mirror.invalid/stale.pkg.tar.zst";
  store.set(url, encoder.encode("truncated"));
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return ok(BODY);
  };

  let seen = 0;
  const bytes = await fetchWithProgress(url, {
    digest: GOOD,
    onBytes: (n) => (seen += n),
  });
  assert.deepEqual([...bytes], [...BODY]);
  assert.equal(fetched, 1);
  // What replaced it is the good copy, and the bad copy's bytes were
  // taken back off the progress bar.
  assert.deepEqual([...store.get(url)], [...BODY]);
  assert.equal(seen, BODY.byteLength);
});

test("a downloaded body that fails its digest is not kept", async () => {
  const url = "https://mirror.invalid/corrupt.pkg.tar.zst";
  globalThis.fetch = async () => ok(encoder.encode("wrong"));

  await assert.rejects(
    () => fetchWithProgress(url, { digest: GOOD }),
    /SHA-256 does not match/,
  );
  assert.equal(store.has(url), false);
});

test("a 404 is not retried and says so", async () => {
  const url = "https://mirror.invalid/gone.pkg.tar.zst";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("gone", { status: 404 });
  };

  const err = await fetchWithProgress(url).then(
    () => null,
    (caught) => caught,
  );
  assert.equal(attempts, 1);
  assert.equal(err.status, 404);
  assert.match(err.message, /HTTP 404/);
});

test("a hiccup is retried", async () => {
  const url = "https://mirror.invalid/flaky.pkg.tar.zst";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      // What a reset connection looks like: no status, no URL.
      throw new TypeError("Failed to fetch");
    }
    return ok(BODY);
  };

  const bytes = await fetchWithProgress(url);
  assert.equal(attempts, 2);
  assert.deepEqual([...bytes], [...BODY]);
});

test("a retry takes back the progress it reported", async () => {
  const url = "https://mirror.invalid/short.pkg.tar.zst";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1 ? ok(encoder.encode("short")) : ok(BODY);
  };

  let seen = 0;
  const bytes = await fetchWithProgress(url, {
    digest: GOOD,
    onBytes: (n) => (seen += n),
  });
  assert.deepEqual([...bytes], [...BODY]);
  // The failed attempt's bytes were subtracted, or the bar overcounts.
  assert.equal(seen, BODY.byteLength);
});

test("a dead source gives up after four attempts", async () => {
  const url = "https://mirror.invalid/dead.pkg.tar.zst";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(() => fetchWithProgress(url), /Failed to fetch/);
  assert.equal(attempts, 4);
});

test("a caller can ask for fewer attempts", async () => {
  // A recipe's sources are mostly on hosts that refuse the page, and a
  // refusal fails every attempt identically: the backoff buys nothing
  // and there are a dozen of them per recipe.
  const url = "https://downloads.invalid/demo-1.0.tar.gz";
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  };

  await assert.rejects(
    () => fetchWithProgress(url, { attempts: 2 }),
    /Failed to fetch/,
  );
  assert.equal(attempts, 2);
});

test("warmHttpCache reads the body and reports its size", async () => {
  globalThis.fetch = async () => ok(BODY);
  let total = null;
  let seen = 0;
  await warmHttpCache("https://example.invalid/qemu.wasm", {
    onTotal: (n) => (total = n),
    onBytes: (n) => (seen += n),
  });
  assert.equal(total, BODY.byteLength);
  assert.equal(seen, BODY.byteLength);
  // The engine is not held by the page, so nothing is stored here.
  assert.equal(store.has("https://example.invalid/qemu.wasm"), false);

  globalThis.fetch = async () => new Response("gone", { status: 404 });
  await assert.rejects(
    () => warmHttpCache("https://example.invalid/qemu.wasm"),
    /HTTP 404/,
  );
});

test("mapConcurrent keeps order and a bound", async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  let running = 0;
  let peak = 0;

  const results = await mapConcurrent(items, 3, async (item, i) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    running -= 1;
    return `${i}:${item}`;
  });

  assert.deepEqual(results, ["0:1", "1:2", "2:3", "3:4", "4:5", "5:6", "6:7"]);
  assert.equal(peak, 3);
});

test("mapConcurrent handles fewer items than workers", async () => {
  assert.deepEqual(await mapConcurrent([], 4, async (x) => x), []);
  assert.deepEqual(await mapConcurrent([1], 4, async (x) => x * 2), [2]);
});
