// Tests the source gathering the page does before a build boots.
//
// The rule the whole module exists for: nothing here throws. A recipe
// whose tarball is on a host that refuses the page, whose patch only
// the visitor has, or whose source is a git checkout still has to come
// back as a list the page can draw — bytes where there are bytes, and a
// reason the visitor can act on where there are not.
//
// No test touches the network: `fetch` is injected, and the recipes are
// small .SRCINFO texts (plus one real fixture, for the local sources a
// hand-written recipe would not get right by accident).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { digestOf, fetchSources, sourceRows } from "../../site/js/recipe.js";
import { parseSrcinfo } from "../../site/js/srcinfo.js";

const read = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const encoder = new TextEncoder();
const TARBALL = encoder.encode("a tarball, for the purposes of this test\n");
const OTHER = encoder.encode("some other file entirely\n");

async function sha256(bytes) {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const TARBALL_SHA256 = await sha256(TARBALL);

// A one-package .SRCINFO whose pkgbase lines are the ones under test.
const recipeOf = (...lines) =>
  parseSrcinfo(
    [
      "pkgbase = demo",
      "\tpkgver = 1.0",
      "\tpkgrel = 1",
      ...lines.map((line) => `\t${line}`),
      "",
      "pkgname = demo",
    ].join("\n"),
  );

// A fetcher that never was a network: it records what it was asked for
// and answers with the bytes the test wants.
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const answer = answers[url];
    if (answer === undefined) {
      // What a host without a CORS header gives a page, wrapped the way
      // fetchWithProgress wraps it.
      throw new Error(`${url}: Failed to fetch`);
    }
    options.onTotal?.(answer.byteLength);
    options.onBytes?.(answer.byteLength);
    return answer;
  };
  return { fetch, calls };
}

test("digestOf takes the strongest checksum a browser can check", () => {
  assert.deepEqual(digestOf({ sha1: "aa", sha256: "bb", sha512: "cc" }), {
    algorithm: "SHA-512",
    hex: "cc",
  });
  assert.deepEqual(digestOf({ sha256: "bb", sha384: "dd" }), {
    algorithm: "SHA-384",
    hex: "dd",
  });
  assert.deepEqual(digestOf({ sha1: "aa", sha256: "bb" }), {
    algorithm: "SHA-256",
    hex: "bb",
  });
  assert.deepEqual(digestOf({ sha1: "aa" }), { algorithm: "SHA-1", hex: "aa" });

  // md5, b2 (BLAKE2b) and sha224 are not in WebCrypto, so the page
  // cannot pre-check the download. makepkg still checks them in the
  // guest, so this is a missing convenience, not a missing check.
  assert.equal(digestOf({ md5: "aa", sha224: "bb", b2: "cc" }), null);
  assert.equal(digestOf({}), null);
  assert.equal(digestOf(undefined), null);

  // The shape sourceList actually builds: every sum present, all null,
  // which is what a source with no checksums or a "SKIP" carries.
  const skipped = recipeOf("source = x.tar.gz", "sha256sums = SKIP");
  assert.equal(digestOf(skipped.sources[0].sums), null);
});

test("a remote source is fetched with its digest and its progress", async () => {
  const url = "https://example.invalid/dl/demo-1.0.tar.gz";
  const recipe = recipeOf(`source = ${url}`, `sha256sums = ${TARBALL_SHA256}`);
  const { fetch, calls } = fakeFetch({ [url]: TARBALL });

  let seen = 0;
  let total = null;
  const { files, problems } = await fetchSources(recipe, {
    fetch,
    onBytes: (n) => (seen += n),
    onTotal: (n) => (total = n),
  });

  assert.deepEqual(problems, []);
  assert.deepEqual([...files.keys()], ["demo-1.0.tar.gz"]);
  assert.deepEqual([...files.get("demo-1.0.tar.gz")], [...TARBALL]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, url);
  // The checksum travels with the download, so a body that arrives
  // short is caught here rather than in the guest.
  assert.deepEqual(calls[0].options.digest, {
    algorithm: "SHA-256",
    hex: TARBALL_SHA256,
  });
  // Fewer attempts than a mirror gets: a refused cross-origin read
  // fails every attempt identically, and a recipe has many sources.
  assert.equal(calls[0].options.attempts, 2);
  assert.equal(seen, TARBALL.byteLength);
  assert.equal(total, TARBALL.byteLength);
});

test("a source the page may not read becomes a problem naming the URL", async () => {
  const url = "https://downloads.invalid/demo-1.0.tar.gz";
  const recipe = recipeOf(`source = ${url}`);
  const { fetch } = fakeFetch({});

  const { files, problems } = await fetchSources(recipe, { fetch });

  assert.equal(files.size, 0);
  // The URL is a field of its own, so the reason says only what the
  // browser said — and then what the visitor can do about it.
  assert.deepEqual(problems, [
    {
      filename: "demo-1.0.tar.gz",
      url,
      kind: "remote",
      reason:
        "could not fetch it (Failed to fetch) — download it and drop it here",
    },
  ]);
});

test("a supplied file is used instead of fetching it", async () => {
  const url = "https://downloads.invalid/demo-1.0.tar.gz";
  const recipe = recipeOf(`source = ${url}`, `sha256sums = ${TARBALL_SHA256}`);
  const { fetch, calls } = fakeFetch({ [url]: OTHER });

  const { files, problems } = await fetchSources(recipe, {
    fetch,
    supplied: new Map([["demo-1.0.tar.gz", TARBALL]]),
  });

  // The visitor went and got it because the page could not, so their
  // copy wins and nothing goes out over the network at all.
  assert.deepEqual(problems, []);
  assert.deepEqual([...files.get("demo-1.0.tar.gz")], [...TARBALL]);
  assert.equal(calls.length, 0);
});

test("a supplied file that is not the file the recipe names is refused", async () => {
  const recipe = recipeOf(
    "source = https://downloads.invalid/demo-1.0.tar.gz",
    `sha256sums = ${TARBALL_SHA256}`,
  );
  const { fetch } = fakeFetch({});

  const { files, problems } = await fetchSources(recipe, {
    fetch,
    supplied: new Map([["demo-1.0.tar.gz", OTHER]]),
  });

  // Node has SubtleCrypto, so the check really runs here. In a page
  // without it verifyDigest answers null rather than false, and the
  // file is taken unverified — makepkg checks it again in the guest.
  assert.equal(files.size, 0);
  assert.deepEqual(problems, [
    {
      filename: "demo-1.0.tar.gz",
      url: "https://downloads.invalid/demo-1.0.tar.gz",
      kind: "remote",
      reason: "does not match the recipe's sha256",
    },
  ]);
});

test("a local file nobody supplied is a problem", async () => {
  // nvm's recipe: one download and two files that only ever existed
  // beside the PKGBUILD, which is exactly the shape the page has to
  // ask the visitor about.
  const recipe = parseSrcinfo(await read("nvm.SRCINFO"));
  const url = "https://github.com/nvm-sh/nvm/archive/v0.40.2.tar.gz";
  const { fetch, calls } = fakeFetch({ [url]: TARBALL });

  const { files, problems } = await fetchSources(recipe, { fetch });

  // Only the download was ever a download.
  assert.deepEqual(
    calls.map((call) => call.url),
    [url],
  );
  assert.deepEqual([...files.keys()], ["nvm-0.40.2.tar.gz"]);
  assert.deepEqual(problems, [
    {
      filename: "init-nvm.sh",
      url: null,
      kind: "local",
      reason: "not supplied",
    },
    {
      filename: "install-nvm-exec",
      url: null,
      kind: "local",
      reason: "not supplied",
    },
  ]);
  assert.deepEqual(
    sourceRows(recipe, { files, problems }).map((row) => row.status),
    ["ready", "missing", "missing"],
  );
});

test("a supplied local file needs nothing from the network", async () => {
  const recipe = recipeOf("source = fix-build.patch");
  const { fetch, calls } = fakeFetch({});

  const { files, problems } = await fetchSources(recipe, {
    fetch,
    supplied: new Map([["fix-build.patch", OTHER]]),
  });

  // No checksum in the recipe, so there is nothing to check it
  // against; makepkg will say so in the guest if it minds.
  assert.deepEqual(problems, []);
  assert.deepEqual([...files.get("fix-build.patch")], [...OTHER]);
  assert.equal(calls.length, 0);
  assert.deepEqual(sourceRows(recipe, { files, problems }), [
    {
      filename: "fix-build.patch",
      url: null,
      kind: "local",
      status: "ready",
      size: OTHER.byteLength,
      reason: null,
    },
  ]);
});

test("a vcs source says which checkout nothing here can make", async () => {
  const recipe = recipeOf(
    "source = git+https://github.invalid/a/demo.git#tag=v1.0",
    "source = docs::hg+https://hg.invalid/docs",
  );
  const { fetch, calls } = fakeFetch({});

  const { files, problems } = await fetchSources(recipe, { fetch });

  assert.equal(files.size, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(problems, [
    {
      filename: "demo",
      url: "https://github.invalid/a/demo.git",
      kind: "vcs",
      reason: "git sources need a checkout nothing here can make",
    },
    {
      filename: "docs",
      url: "https://hg.invalid/docs",
      kind: "vcs",
      reason: "hg sources need a checkout nothing here can make",
    },
  ]);
});

test("a filename the recipe names twice is handled once", async () => {
  const first = "https://example.invalid/demo.tar.gz";
  const recipe = recipeOf(
    `source = ${first}`,
    "source = demo.tar.gz::https://elsewhere.invalid/copy.tar.gz",
  );
  const { fetch, calls } = fakeFetch({ [first]: TARBALL });

  const { files, problems } = await fetchSources(recipe, { fetch });

  // First wins: one download, one file, and the second mention neither
  // fetched nor reported as missing.
  assert.deepEqual(problems, []);
  assert.equal(files.size, 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    [first],
  );
  assert.deepEqual(
    sourceRows(recipe, { files, problems }).map((row) => row.filename),
    ["demo.tar.gz"],
  );
});

test("remote sources are fetched a few at a time", async () => {
  const urls = [1, 2, 3, 4, 5, 6, 7].map(
    (n) => `https://example.invalid/part-${n}.tar.gz`,
  );
  const recipe = recipeOf(...urls.map((url) => `source = ${url}`));

  let running = 0;
  let peak = 0;
  const fetch = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return TARBALL;
  };

  const { files } = await fetchSources(recipe, { fetch });
  assert.equal(files.size, urls.length);
  assert.equal(peak, 3);
});

test("sourceRows says what the page has and what it is still missing", async () => {
  const good = "https://example.invalid/demo-1.0.tar.gz";
  const bad = "https://downloads.invalid/demo-docs.tar.gz";
  const recipe = recipeOf(
    `source = ${good}`,
    `source = ${bad}`,
    "source = fix-build.patch",
    "source = git+https://github.invalid/a/demo.git",
  );
  const { fetch } = fakeFetch({ [good]: TARBALL });

  const gathered = await fetchSources(recipe, { fetch });
  const rows = sourceRows(recipe, gathered);

  // Recipe order, whatever order the downloads finished in.
  assert.deepEqual(rows, [
    {
      filename: "demo-1.0.tar.gz",
      url: good,
      kind: "remote",
      status: "ready",
      size: TARBALL.byteLength,
      reason: null,
    },
    {
      filename: "demo-docs.tar.gz",
      url: bad,
      kind: "remote",
      status: "missing",
      size: null,
      reason:
        "could not fetch it (Failed to fetch) — download it and drop it here",
    },
    {
      filename: "fix-build.patch",
      url: null,
      kind: "local",
      status: "missing",
      size: null,
      reason: "not supplied",
    },
    {
      filename: "demo",
      url: "https://github.invalid/a/demo.git",
      kind: "vcs",
      status: "unsupported",
      size: null,
      reason: "git sources need a checkout nothing here can make",
    },
  ]);
});

test("sourceRows draws a recipe nothing has been gathered for yet", () => {
  const recipe = recipeOf(
    "source = https://example.invalid/demo-1.0.tar.gz",
    "source = fix-build.patch",
  );

  assert.deepEqual(
    sourceRows(recipe, {}).map((row) => [row.status, row.size, row.reason]),
    [
      ["missing", null, null],
      ["missing", null, null],
    ],
  );
});
