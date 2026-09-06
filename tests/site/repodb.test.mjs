// Tests the repo database reader against a database `repo-add` would
// write: gzipped tar, one directory per package, and one package with
// its dependencies in the separate `depends` file that pre-5 pacman
// wrote and old mirrors still serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { parseRepoDb, fetchRepoDb, packageUrl } from "../../site/js/repodb.js";

const DB = new URL("../fixtures/mini.db", import.meta.url);
const bytes = async () => new Uint8Array(await readFile(DB));

test("parseRepoDb reads every entry", async () => {
  const packages = parseRepoDb(new Uint8Array(gunzipSync(await readFile(DB))));

  assert.deepEqual([...packages.keys()].sort(), ["bar", "foo"]);

  const foo = packages.get("foo");
  assert.equal(foo.version, "1.0-1");
  assert.equal(foo.filename, "foo-1.0-1-x86_64.pkg.tar.zst");
  assert.equal(foo.csize, 1234);
  assert.equal(foo.isize, 5678);
  assert.equal(foo.desc, "A tiny test package");

  // The dependency fields live in the sibling `depends` file here, and
  // still have to end up on the same object.
  assert.deepEqual(foo.depends, ["glibc", "bar>=2.0"]);
  assert.deepEqual(foo.provides, ["libfoo.so=1-64"]);

  const bar = packages.get("bar");
  assert.deepEqual(bar.depends, ["glibc"]);
  assert.equal(bar.base, "bar");
});

test("fetchRepoDb decompresses gzip", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push([url, options]);
    return new Response(await bytes(), { status: 200 });
  };
  try {
    const packages = await fetchRepoDb("https://example.invalid/core.db");
    assert.equal(packages.get("foo").version, "1.0-1");
    assert.deepEqual(seen[0], [
      "https://example.invalid/core.db",
      { cache: "no-cache" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchRepoDb accepts an uncompressed database", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(new Uint8Array(gunzipSync(await readFile(DB))), {
      status: 200,
    });
  try {
    const packages = await fetchRepoDb("https://example.invalid/core.db.tar");
    assert.deepEqual([...packages.keys()].sort(), ["bar", "foo"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchRepoDb reports an HTTP failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 404 });
  try {
    await assert.rejects(
      () => fetchRepoDb("https://example.invalid/core.db"),
      /HTTP 404/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("packages sit beside the database that lists them", () => {
  assert.equal(
    packageUrl(
      "https://geo.mirror.pkgbuild.com/core/os/x86_64/core.db",
      "jq-1.8.2-1-x86_64.pkg.tar.zst",
    ),
    "https://geo.mirror.pkgbuild.com/core/os/x86_64/jq-1.8.2-1-x86_64.pkg.tar.zst",
  );
  assert.equal(packageUrl("core.db", "a.pkg.tar.zst"), "a.pkg.tar.zst");
  assert.equal(
    packageUrl("https://example.invalid/repo/my.db.tar.gz", "p.pkg.tar.zst"),
    "https://example.invalid/repo/p.pkg.tar.zst",
  );
});
