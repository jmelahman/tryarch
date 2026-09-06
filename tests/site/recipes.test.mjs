// Tests the three ways a recipe reaches the page — the AUR, a URL, a
// handful of dropped files — and that each becomes the same item: the
// files beside the PKGBUILD looked for where it came from, the rows
// that say what is still missing, and the visitor's files winning.
//
// The index and the AUR mirror are injected fetchers; the files beside
// a recipe come through a fake global fetch, since that is what the
// download code uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { aurFileUrl, aurPageUrl, setRecipeFetcher } from "../../site/js/aur.js";
import { setFetcher, shardOf } from "../../site/js/index.js";
import {
  gatherSources,
  pkgbuildBytes,
  recipeFromAur,
  recipeFromFiles,
  recipeFromUrl,
  recipeWants,
  supply,
} from "../../site/js/recipes.js";
import { fakeCaches } from "./tarball.mjs";

fakeCaches();

const encoder = new TextEncoder();
const decode = (bytes) => new TextDecoder().decode(bytes);

const EXAMPLE = await readFile(
  new URL("../../examples/hello-tryarch/PKGBUILD", import.meta.url),
  "utf8",
);

// A recipe with two files beside it: a patch in source=() and an
// .install script named outside it.
const DEMO = `pkgname=demo
pkgver=1.0
pkgrel=1
pkgdesc="a recipe with files beside it"
arch=('any')
depends=('sh')
install=demo.install
source=('demo.patch')
sha256sums=('SKIP')

package() {
  :
}
`;
const PATCH = encoder.encode("--- a/hello\n+++ b/hello\n");
const INSTALL = encoder.encode("post_install() { :; }\n");

const DEMO_SRCINFO = `pkgbase = demo
\tpkgdesc = a recipe with files beside it
\tpkgver = 1.0
\tpkgrel = 1
\tinstall = demo.install
\tarch = any
\tdepends = sh
\tsource = demo.patch
\tsha256sums = SKIP

pkgname = demo-bin
`;

// What the web has: a PKGBUILD and its patch at example.org, and the
// AUR mirror's copy of the same recipe under the base "demo".
const ORIGIN = "https://example.org/demo/";
const WEB = new Map([
  [`${ORIGIN}PKGBUILD`, encoder.encode(DEMO)],
  [`${ORIGIN}demo.patch`, PATCH],
  [`${ORIGIN}broken/PKGBUILD`, null],
  [aurFileUrl("demo", ".SRCINFO"), encoder.encode(DEMO_SRCINFO)],
  [aurFileUrl("demo", "PKGBUILD"), encoder.encode(DEMO)],
  [aurFileUrl("demo", "demo.patch"), PATCH],
  [aurFileUrl("orphan", ".SRCINFO"), encoder.encode(DEMO_SRCINFO)],
]);

const serve = async (url) => {
  if (!WEB.has(url)) {
    return new Response("not found", { status: 404 });
  }
  const bytes = WEB.get(url);
  if (bytes === null) {
    return new Response("broken", { status: 500 });
  }
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Length": String(bytes.byteLength) },
  });
};
globalThis.fetch = serve;
setRecipeFetcher(serve);

// The AUR index knows demo-bin as a split of the base "demo".
setFetcher(async (url) => {
  if (url === `index/aur/pkgs/${shardOf("demo-bin")}.json`) {
    return new Response(JSON.stringify({ "demo-bin": { base: "demo" } }), {
      status: 200,
    });
  }
  return new Response("not found", { status: 404 });
});

const rowsOf = (item) =>
  Object.fromEntries(item.rows.map((row) => [row.filename, row.status]));

test("dropped files need a PKGBUILD among them", () => {
  assert.throws(
    () => recipeFromFiles(new Map([["pkgbuild", encoder.encode(DEMO)]])),
    /no file named PKGBUILD/,
  );
});

test("a recipe with nothing beside it is ready at once", async () => {
  const item = recipeFromFiles(
    new Map([
      ["PKGBUILD", encoder.encode(EXAMPLE)],
      ["notes.txt", encoder.encode("kept, unused\n")],
    ]),
  );
  assert.equal(item.key, "files:hello-tryarch");
  assert.equal(item.id, "hello-tryarch");
  assert.equal(item.kind, "files");
  assert.equal(item.base, "hello-tryarch");
  assert.equal(item.recipe.version, "1.0.0-1");
  assert.equal(item.page, null);
  assert.equal(item.origin, null);
  assert.equal(item.profile, "makepkg");
  assert.deepEqual([...item.supplied.keys()], ["notes.txt"]);
  assert.equal(item.ready, false);

  await gatherSources(item);
  assert.equal(item.ready, true);
  assert.deepEqual(item.rows, []);
  assert.deepEqual(item.missing, []);
  assert.equal(decode(pkgbuildBytes(item)), EXAMPLE);
});

test("files the recipe names are missing until the visitor supplies them", async () => {
  const item = recipeFromFiles(new Map([["PKGBUILD", encoder.encode(DEMO)]]));
  await gatherSources(item);
  assert.equal(item.ready, false);
  assert.deepEqual(rowsOf(item), {
    "demo.patch": "missing",
    "demo.install": "missing",
  });
  for (const row of item.missing) {
    assert.equal(row.url, null);
    assert.equal(row.reason, "not supplied");
  }

  await supply(item, new Map([["demo.patch", PATCH]]));
  assert.equal(item.ready, false);
  assert.deepEqual(rowsOf(item), {
    "demo.patch": "ready",
    "demo.install": "missing",
  });

  await supply(item, new Map([["demo.install", INSTALL]]));
  assert.equal(item.ready, true);
  assert.deepEqual([...item.files.keys()].sort(), [
    "demo.install",
    "demo.patch",
  ]);
  assert.equal(item.files.get("demo.patch"), PATCH);
});

test("a recipe by URL looks beside itself for its files", async () => {
  const url = `${ORIGIN}PKGBUILD`;
  const item = await recipeFromUrl(url);
  assert.equal(item.key, `url:${url}`);
  assert.equal(item.kind, "url");
  assert.equal(item.base, "demo");
  assert.equal(item.page, url);
  assert.equal(item.origin, ORIGIN);

  await gatherSources(item);
  assert.deepEqual(rowsOf(item), {
    "demo.patch": "ready",
    "demo.install": "missing",
  });
  const [missing] = item.missing;
  assert.equal(missing.url, `${ORIGIN}demo.install`);
  assert.deepEqual(item.files.get("demo.patch"), PATCH);

  await supply(item, new Map([["demo.install", INSTALL]]));
  assert.equal(item.ready, true);
});

test("a URL that will not load is an error with the URL in it", async () => {
  await assert.rejects(recipeFromUrl(`${ORIGIN}broken/PKGBUILD`), /HTTP 500/);
  await assert.rejects(recipeFromUrl(`${ORIGIN}absent/PKGBUILD`), /HTTP 404/);
});

test("an AUR name is read through its base", async () => {
  const item = await recipeFromAur("demo-bin");
  assert.equal(item.key, "aur:demo-bin");
  assert.equal(item.id, "demo-bin");
  assert.equal(item.kind, "aur");
  assert.equal(item.base, "demo");
  assert.equal(item.page, aurPageUrl("demo"));
  assert.equal(item.origin, aurFileUrl("demo", ""));
  assert.equal(item.pkgbuild, DEMO);
  assert.equal(item.profile, "makepkg");
  assert.deepEqual(
    item.recipe.packages.map((pkg) => pkg.name),
    ["demo-bin"],
  );

  await gatherSources(item);
  assert.deepEqual(rowsOf(item), {
    "demo.patch": "ready",
    "demo.install": "missing",
  });
  assert.equal(item.missing[0].url, aurFileUrl("demo", "demo.install"));
});

test("an AUR recipe without a PKGBUILD on the mirror is refused", async () => {
  await assert.rejects(
    recipeFromAur("orphan"),
    /has the \.SRCINFO but not the PKGBUILD/,
  );
  await assert.rejects(recipeFromAur("no-such"), /not in the AUR mirror/);
});

test("recipeWants is the recipe's needs under its own name", async () => {
  const item = await recipeFromUrl(`${ORIGIN}PKGBUILD`);
  const wants = recipeWants(item);
  assert.equal(wants.via, "demo");
  assert.ok(wants.specs.includes("sh"));
  assert.ok(wants.specs.includes("pacman"));
  assert.ok(!wants.specs.includes("gcc"));
});
