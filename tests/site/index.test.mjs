// Tests the index layer against an in-memory copy of what
// tools/build-index.py writes. The shard vectors are checked against
// the Python rule directly, because a mismatch there means the page
// fetches a shard that exists and simply does not hold the name — a
// silent "no such package" rather than an error.
//
// These tests share module state on purpose (a pasted repo, a
// refreshed repo) and run in file order: the pure cases first, then the
// index, then the overrides that change what the index means.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import {
  addRepo,
  buildFromMeta,
  current,
  extraRepos,
  indexInfo,
  names,
  pkgbuildUrl,
  providersOf,
  refreshRepo,
  searchNames,
  setFetcher,
  shardOf,
} from "../../site/js/index.js";
import { parseRepoDb } from "../../site/js/repodb.js";
import { parseDesc } from "../../site/js/desc.js";

// --- the shard function -------------------------------------------------

test("shardOf agrees with the generator", () => {
  // Ground truth from the same FNV-1a in tools/build-index.py.
  const VECTORS = {
    "": "c5",
    jq: "e4",
    glibc: "02",
    bash: "1f",
    "python-setuptools": "62",
    "libsigc++": "e4",
    ncurses: "7e",
    "gcc-libs": "23",
    zlib: "c4",
  };
  for (const [name, want] of Object.entries(VECTORS)) {
    assert.equal(shardOf(name), want, name);
  }
  // Always two hex digits, or the URL is wrong.
  for (const name of ["a", "aa", "zzz", "linux-firmware"]) {
    assert.match(shardOf(name), /^[0-9a-f]{2}$/);
  }
});

// --- the PKGBUILD link --------------------------------------------------

test("a PKGBUILD link spells + as plus and : as -", () => {
  assert.equal(
    pkgbuildUrl("jq", "1.7.1-2"),
    "https://gitlab.archlinux.org/archlinux/packaging/packages/jq/-/blob/1.7.1-2/PKGBUILD",
  );
  assert.equal(
    pkgbuildUrl("libsigc++", "2.12.1-1"),
    "https://gitlab.archlinux.org/archlinux/packaging/packages/libsigcplusplus/-/blob/2.12.1-1/PKGBUILD",
  );
  assert.equal(
    pkgbuildUrl("emacs", "1:26.2.2-1"),
    "https://gitlab.archlinux.org/archlinux/packaging/packages/emacs/-/blob/1-26.2.2-1/PKGBUILD",
  );
  // Nothing to link to is a null, not a broken URL.
  assert.equal(pkgbuildUrl(null, "1.0-1"), null);
  assert.equal(pkgbuildUrl("jq", null), null);
});

// --- a database entry becomes a build -----------------------------------

test("buildFromMeta carries the digest and the recipe", async () => {
  const meta = parseDesc(
    await readFile(new URL("../fixtures/jq.desc", import.meta.url), "utf8"),
  );
  const build = buildFromMeta(meta, {
    repo: "extra",
    urls: ["https://example.invalid/jq-1.8.2-1-x86_64.pkg.tar.zst"],
  });
  assert.equal(build.name, "jq");
  assert.equal(build.base, "jq");
  assert.equal(build.version, "1.8.2-1");
  assert.equal(build.repo, "extra");
  assert.equal(build.size, 213086);
  assert.equal(build.isize, 492406);
  assert.deepEqual(build.digest, {
    algorithm: "SHA-256",
    hex: "35f197700d1e8a1692fd67c644c1e57a72f4969707772ac1f477b02351248e1b",
  });
  assert.deepEqual(build.depends, ["glibc", "oniguruma"]);
  assert.ok(build.pkgbuild.endsWith("/blob/1.8.2-1/PKGBUILD"));

  // An explicit digest wins: the Archive vouches with sha1.
  const archived = buildFromMeta(meta, {
    repo: "archive",
    urls: [],
    digest: { algorithm: "SHA-1", hex: "aa" },
  });
  assert.deepEqual(archived.digest, { algorithm: "SHA-1", hex: "aa" });
});

// --- the generated index ------------------------------------------------

const INDEX = {
  generated: "2026-09-05T06:00:00Z",
  count: 4,
  repos: ["core", "extra"],
  names: {
    jq: "Command-line JSON processor",
    bash: "The GNU Bourne Again shell",
    glibc: "GNU C Library",
    jansson: "C library for encoding and decoding JSON",
  },
};

const ENTRIES = {
  jq: {
    v: "1.8.2-1",
    r: "extra",
    f: "jq-1.8.2-1-x86_64.pkg.tar.zst",
    cs: 213086,
    is: 492406,
    sha: "35f197700d1e8a1692fd67c644c1e57a72f4969707772ac1f477b02351248e1b",
    b: 1781975439,
    d: ["glibc", "oniguruma"],
    p: [],
    base: "jq",
    desc: "Command-line JSON processor",
  },
  bash: {
    v: "5.3.3-1",
    r: "core",
    f: "bash-5.3.3-1-x86_64.pkg.tar.zst",
    cs: 1,
    is: 2,
    sha: "ab",
    b: 1780000000,
    d: ["glibc"],
    p: ["sh"],
    base: "bash",
    desc: "The GNU Bourne Again shell",
  },
  glibc: {
    v: "2.42-3",
    r: "core",
    f: "glibc-2.42-3-x86_64.pkg.tar.zst",
    cs: 3,
    is: 4,
    sha: "cd",
    b: 1781000000,
    d: [],
    p: [],
    base: "glibc",
    desc: "GNU C Library",
  },
  jansson: {
    v: "2.14-3",
    r: "extra",
    f: "jansson-2.14-3-x86_64.pkg.tar.zst",
    cs: 5,
    is: 6,
    sha: "ef",
    b: 1770000000,
    d: ["glibc"],
    p: [],
    base: "jansson",
    desc: "C library for encoding and decoding JSON",
  },
};

const PROVIDES = { sh: ["bash"], "libz.so": ["zlib"] };

// The index as a set of files, laid out by the same shard rule the
// generator uses.
function indexFiles() {
  const files = new Map([["index/names.json", INDEX]]);
  const bucket = (dir, key, value) => {
    const path = `index/${dir}/${shardOf(key)}.json`;
    const held = files.get(path) ?? {};
    held[key] = value;
    files.set(path, held);
  };
  for (const [name, entry] of Object.entries(ENTRIES))
    bucket("pkgs", name, entry);
  for (const [name, list] of Object.entries(PROVIDES))
    bucket("provides", name, list);
  return files;
}

const asked = [];

setFetcher(async (url, options) => {
  asked.push([url, options?.cache]);
  const json = indexFiles().get(url);
  return json === undefined
    ? new Response("not found", { status: 404 })
    : new Response(JSON.stringify(json), { status: 200 });
});

test("names and indexInfo come out of names.json", async () => {
  const map = await names();
  assert.equal(map.size, 4);
  assert.equal(map.get("jq"), "Command-line JSON processor");

  const info = await indexInfo();
  assert.equal(info.generated, "2026-09-05T06:00:00Z");
  assert.equal(info.count, 4);
  assert.deepEqual(info.repos, ["core", "extra"]);

  // The index is regenerated under its own name, so it is never read
  // from the HTTP cache without asking.
  assert.deepEqual(asked[0], ["index/names.json", "no-cache"]);
});

test("current builds a package from its shard", async () => {
  const build = await current("jq");
  assert.equal(build.version, "1.8.2-1");
  assert.equal(build.repo, "extra");
  assert.equal(build.filename, "jq-1.8.2-1-x86_64.pkg.tar.zst");
  assert.deepEqual(build.digest, {
    algorithm: "SHA-256",
    hex: "35f197700d1e8a1692fd67c644c1e57a72f4969707772ac1f477b02351248e1b",
  });
  assert.deepEqual(build.depends, ["glibc", "oniguruma"]);
  assert.ok(build.pkgbuild.endsWith("/blob/1.8.2-1/PKGBUILD"));

  // Every mirror is listed, in configured order, under the entry's own
  // repo directory: the next URL costs a 404, not a failed boot.
  assert.ok(build.urls.length >= 3);
  for (const url of build.urls) {
    assert.ok(
      url.endsWith("/extra/os/x86_64/jq-1.8.2-1-x86_64.pkg.tar.zst"),
      url,
    );
  }
});

test("a name in no shard is null", async () => {
  assert.equal(await current("nosuchpackage"), null);
});

test("a shard that does not exist is not an error", async () => {
  // 404 on a shard means nothing hashes there, which is the same answer
  // as a shard without the name.
  assert.equal(await current("qqqqqqqq"), null);
});

test("providersOf reads the provides shard", async () => {
  assert.deepEqual(await providersOf("sh"), ["bash"]);
  assert.deepEqual(await providersOf("libz.so"), ["zlib"]);
  assert.deepEqual(await providersOf("nothing-provides-this"), []);
});

test("searchNames ranks exact, prefix, substring, description", async () => {
  const hits = await searchNames("jq");
  assert.deepEqual(
    hits.map((hit) => hit.name),
    ["jq"],
  );
  assert.equal(hits[0].repo, "extra");

  // "json" is in no name, only in two descriptions.
  const json = await searchNames("json");
  assert.deepEqual(json.map((hit) => hit.name).sort(), ["jansson", "jq"]);

  const ba = await searchNames("ba");
  assert.equal(ba[0].name, "bash");
  assert.equal(ba[0].repo, "core");
});

test("a search is capped and an empty query finds nothing", async () => {
  assert.deepEqual(await searchNames(""), []);
  assert.deepEqual(await searchNames("   "), []);
  assert.equal((await searchNames("a", 1)).length, 1);
});

// --- a repo somebody pasted ---------------------------------------------

test("an extra repo overrides the index and joins the search", async () => {
  const entries = parseRepoDb(
    new Uint8Array(
      gunzipSync(
        await readFile(new URL("../fixtures/mini.db", import.meta.url)),
      ),
    ),
  );
  entries.set(
    "jq",
    parseDesc(
      "%NAME%\njq\n\n%VERSION%\n9.9-1\n\n%FILENAME%\njq-9.9-1-x86_64.pkg.tar.zst\n\n%DESC%\nMine\n",
    ),
  );

  const repo = addRepo("mine", "https://example.invalid/repo/mine.db", entries);
  assert.equal(repo.label, "mine");
  assert.deepEqual(
    extraRepos().map((one) => one.label),
    ["mine"],
  );

  // A pasted repo wins over the index for a name they share, and its
  // packages are fetched from beside its database.
  const jq = await current("jq");
  assert.equal(jq.version, "9.9-1");
  assert.equal(jq.repo, "mine");
  assert.deepEqual(jq.urls, [
    "https://example.invalid/repo/jq-9.9-1-x86_64.pkg.tar.zst",
  ]);

  const foo = await current("foo");
  assert.equal(foo.version, "1.0-1");
  assert.deepEqual(foo.depends, ["glibc", "bar>=2.0"]);

  // Its packages are searchable and carry its label as their repo.
  const hits = await searchNames("foo");
  assert.equal(hits[0].name, "foo");
  assert.equal(hits[0].repo, "mine");

  // And can satisfy a provides the official repos never mention.
  assert.deepEqual(await providersOf("libfoo.so"), ["foo"]);
});

test("re-adding a repo under one label replaces it", () => {
  addRepo("mine", "https://example.invalid/repo/mine.db", new Map());
  assert.equal(extraRepos().length, 1);
  assert.equal(extraRepos()[0].entries.size, 0);
});

// --- the freshness fallback ---------------------------------------------

test("refreshRepo re-reads a mirror's own database", async () => {
  const db = await readFile(new URL("../fixtures/mini.db", import.meta.url));
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    // The first mirror is down; the second answers.
    if (urls.length === 1) {
      return new Response("nope", { status: 503 });
    }
    return new Response(new Uint8Array(db), { status: 200 });
  };
  try {
    await refreshRepo("core");
    assert.equal(urls.length, 2);
    assert.ok(urls[0].endsWith("/core/os/x86_64/core.db"), urls[0]);

    // core is now what the mirror says it is: a package the index puts
    // in core and the fresh database does not hold is gone, not stale.
    assert.equal(await current("bash"), null);
    const foo = await current("foo");
    assert.equal(foo.repo, "core");
    assert.equal(foo.version, "1.0-1");

    // extra is untouched.
    assert.equal((await current("jansson")).version, "2.14-3");
  } finally {
    globalThis.fetch = original;
  }
});

test("refreshRepo fails loudly when no mirror answers", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    await assert.rejects(
      () => refreshRepo("extra"),
      /no mirror served extra\.db/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

// --- a lost request is not an answer -----------------------------------

test("a shard fetch that fails is retried, not remembered as empty", async () => {
  let calls = 0;
  const files = indexFiles();
  setFetcher(async (url) => {
    calls += 1;
    // The first request for anything is dropped on the floor.
    if (calls === 1) {
      throw new TypeError("Failed to fetch");
    }
    const json = files.get(url);
    return json === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(json), { status: 200 });
  });

  const build = await current("jq");
  assert.equal(build.version, "1.8.2-1");
  assert.equal(calls, 2);
});

test("a shard nothing will serve is an error, and is asked for again", async () => {
  let calls = 0;
  setFetcher(async () => {
    calls += 1;
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(current("jq"), /Failed to fetch/);
  const failed = calls;

  // Not memoised as empty: the next lookup goes to the network again.
  await assert.rejects(current("jq"), /Failed to fetch/);
  assert.ok(calls > failed);
});
