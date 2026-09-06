// Tests the AUR lane against an in-memory copy of what
// tools/build-index.py writes under index/aur/, in the shape it really
// writes it: a pkgbase equal to the name is left out, and so is every
// empty list. Reading those absences wrong is what turns "this package
// has no makedepends" into "this package's makedepends are undefined"
// halfway through a build.
//
// The recipe half never touches the network either: the fetcher is
// injected and answers with the same .SRCINFO the mirror serves, kept
// in tests/site/fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  aurEntry,
  aurFileUrl,
  aurInfo,
  aurNames,
  aurPageUrl,
  aurProvidersOf,
  fetchAurRecipe,
  searchAur,
  setRecipeFetcher,
} from "../../site/js/aur.js";
import { setFetcher, shardOf } from "../../site/js/index.js";

// --- the index the generator would have written -------------------------

const NAMES = {
  yay: "Yet another yogurt. Pacman wrapper and AUR helper written in go.",
  "yay-bin":
    "Yet another yogurt. Pacman wrapper and AUR helper written in go. Pre-compiled.",
  "yay-git": "Yet another yogurt. Pacman wrapper and AUR helper (git version)",
  "python-yay": "Python bindings for yay",
  paru: "Feature packed AUR helper, an alternative to yay",
  "ttf-ms-fonts": "Core TrueType fonts from Microsoft",
};

const ENTRIES = {
  // Neither a base (it equals the name) nor the two empty lists.
  yay: {
    v: "12.5.0-1",
    desc: NAMES.yay,
    url: "https://github.com/Jguer/yay",
    pop: 45.67,
    votes: 2345,
    ood: null,
    m: 1785324075,
    d: ["pacman>6.1", "git"],
    md: ["go"],
    p: ["yay"],
  },
  "yay-bin": {
    v: "13.0.1-1",
    desc: NAMES["yay-bin"],
    url: "https://github.com/Jguer/yay",
    pop: 12.34,
    votes: 1234,
    ood: null,
    m: 1785000000,
    d: ["pacman>6.1", "git"],
    p: ["yay"],
  },
  // Flagged out of date, and with every list the generator writes.
  "yay-git": {
    v: "13.0.1.r5.gdeadbee-1",
    desc: NAMES["yay-git"],
    url: "https://github.com/Jguer/yay",
    pop: 0.5,
    votes: 42,
    ood: 1780000000,
    m: 1784000000,
    d: ["pacman>6.1", "git"],
    md: ["go", "git"],
    cd: ["go"],
    p: ["yay"],
  },
  // A pkgbase that is not the name: the recipe lives under yay-python.
  "python-yay": {
    base: "yay-python",
    v: "0.3-2",
    desc: NAMES["python-yay"],
    url: "https://example.invalid/yay-python",
    pop: 0.0,
    votes: 3,
    ood: null,
    m: 1770000000,
    d: ["python"],
  },
  paru: {
    v: "2.0.4-1",
    desc: NAMES.paru,
    url: "https://github.com/Morganamilo/paru",
    pop: 30.1,
    votes: 999,
    ood: null,
    m: 1783000000,
    d: ["pacman>6.1"],
    md: ["cargo"],
  },
  // Nothing but the fields every entry has: no base, no list at all.
  "ttf-ms-fonts": {
    v: "2.0-13",
    desc: NAMES["ttf-ms-fonts"],
    url: "https://example.invalid/ttf",
    pop: 3.21,
    votes: 555,
    ood: null,
    m: 1760000000,
  },
};

const PROVIDES = { yay: ["yay", "yay-bin", "yay-git"] };

const INDEX = {
  generated: "2026-09-06T08:00:06Z",
  count: Object.keys(ENTRIES).length,
  names: NAMES,
};

// The index as a set of files, laid out by the shard rule index.js and
// the generator share.
function indexFiles() {
  const files = new Map([["index/aur/names.json", INDEX]]);
  const bucket = (dir, key, value) => {
    const path = `index/aur/${dir}/${shardOf(key)}.json`;
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

const files = indexFiles();
const asked = [];

setFetcher(async (url, options) => {
  asked.push([url, options?.cache]);
  const json = files.get(url);
  return json === undefined
    ? new Response("not found", { status: 404 })
    : new Response(JSON.stringify(json), { status: 200 });
});

// --- the links ----------------------------------------------------------

test("the AUR links name a branch and a page", () => {
  assert.equal(
    aurPageUrl("yay-bin"),
    "https://aur.archlinux.org/packages/yay-bin",
  );
  assert.equal(
    aurFileUrl("yay-bin", ".SRCINFO"),
    "https://raw.githubusercontent.com/archlinux/aur/yay-bin/.SRCINFO",
  );
  // A "+" in a pkgbase is a branch name, not an escape: libc++ is the
  // branch libc++.
  assert.equal(
    aurFileUrl("libc++", "PKGBUILD"),
    "https://raw.githubusercontent.com/archlinux/aur/libc++/PKGBUILD",
  );
});

// --- one entry ----------------------------------------------------------

test("aurEntry reads an entry out of its shard", async () => {
  const entry = await aurEntry("yay-git");
  assert.deepEqual(entry, {
    name: "yay-git",
    base: "yay-git",
    version: "13.0.1.r5.gdeadbee-1",
    desc: NAMES["yay-git"],
    url: "https://github.com/Jguer/yay",
    depends: ["pacman>6.1", "git"],
    makedepends: ["go", "git"],
    checkdepends: ["go"],
    provides: ["yay"],
    popularity: 0.5,
    votes: 42,
    outOfDate: 1780000000,
    modified: 1784000000,
  });

  // The AUR index is regenerated under its own name, so it is never
  // read from the HTTP cache without asking.
  assert.equal(asked[0][1], "no-cache");
  assert.ok(asked[0][0].startsWith("index/aur/pkgs/"), asked[0][0]);
});

test("an omitted list is empty and an omitted base is the name", async () => {
  const entry = await aurEntry("ttf-ms-fonts");
  assert.equal(entry.base, "ttf-ms-fonts");
  assert.deepEqual(entry.depends, []);
  assert.deepEqual(entry.makedepends, []);
  assert.deepEqual(entry.checkdepends, []);
  assert.deepEqual(entry.provides, []);
  assert.equal(entry.outOfDate, null);
  assert.equal(entry.votes, 555);

  const bin = await aurEntry("yay-bin");
  assert.equal(bin.base, "yay-bin");
  assert.deepEqual(bin.makedepends, []);
  assert.deepEqual(bin.provides, ["yay"]);
});

test("a base that differs from the name is where the recipe is", async () => {
  const entry = await aurEntry("python-yay");
  assert.equal(entry.name, "python-yay");
  assert.equal(entry.base, "yay-python");
  assert.equal(
    aurFileUrl(entry.base, ".SRCINFO"),
    "https://raw.githubusercontent.com/archlinux/aur/yay-python/.SRCINFO",
  );
});

test("a name the AUR does not have is null", async () => {
  // In a shard that exists and does not hold it, and in one nothing
  // serves at all: both are "no such package", not an error.
  assert.equal(await aurEntry("nosuchaurpackage"), null);
  assert.equal(await aurEntry("qqqqqqqq"), null);
});

// --- what provides a name -----------------------------------------------

test("aurProvidersOf reads the provides shard", async () => {
  assert.deepEqual(await aurProvidersOf("yay"), ["yay", "yay-bin", "yay-git"]);
  assert.deepEqual(await aurProvidersOf("nothing-provides-this"), []);
});

test("a caller cannot edit the memoised shard", async () => {
  (await aurProvidersOf("yay")).push("mine");
  assert.deepEqual(await aurProvidersOf("yay"), ["yay", "yay-bin", "yay-git"]);
});

// --- the names file -----------------------------------------------------

test("aurNames and aurInfo come out of names.json", async () => {
  const map = await aurNames();
  assert.equal(map.size, 6);
  assert.equal(map.get("paru"), NAMES.paru);

  const info = await aurInfo();
  assert.equal(info.generated, "2026-09-06T08:00:06Z");
  assert.equal(info.count, 6);
  // The names file is the AUR's alone; nothing here reads the binary
  // index's repos.
  assert.equal(info.repos, undefined);
});

// --- search -------------------------------------------------------------

test("searchAur ranks exact, prefix, substring, description", async () => {
  const hits = await searchAur("yay");
  assert.deepEqual(
    hits.map((hit) => hit.name),
    // yay is exact; yay-bin and yay-git start with it, alphabetically;
    // python-yay only contains it; paru only mentions it.
    ["yay", "yay-bin", "yay-git", "python-yay", "paru"],
  );
  for (const hit of hits) {
    assert.equal(hit.repo, "aur");
  }
  assert.equal(hits[0].desc, NAMES.yay);
});

test("a search is capped and an empty query finds nothing", async () => {
  assert.deepEqual(await searchAur(""), []);
  assert.deepEqual(await searchAur("   "), []);
  assert.equal((await searchAur("yay", 2)).length, 2);
  assert.deepEqual(await searchAur("nosuchsubstring"), []);
});

// --- the recipe ---------------------------------------------------------

const fixture = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

// Answers for the mirror: the files this pkgbase's branch holds, and a
// 404 for everything else.
function mirror(held) {
  const urls = [];
  setRecipeFetcher(async (url, options) => {
    urls.push([url, options?.cache]);
    const text = held.get(url);
    return text === undefined
      ? new Response("404: Not Found", { status: 404 })
      : new Response(text, { status: 200 });
  });
  return urls;
}

test("fetchAurRecipe reads both files and parses the .SRCINFO", async () => {
  const srcinfo = await fixture("yay-bin.SRCINFO");
  const pkgbuild = await fixture("yay-bin.PKGBUILD");
  const base = "https://raw.githubusercontent.com/archlinux/aur/yay-bin";
  const urls = mirror(
    new Map([
      [`${base}/.SRCINFO`, srcinfo],
      [`${base}/PKGBUILD`, pkgbuild],
    ]),
  );

  const got = await fetchAurRecipe("yay-bin");
  assert.equal(got.base, "yay-bin");
  assert.equal(got.srcinfo, srcinfo);
  assert.equal(got.pkgbuild, pkgbuild);
  assert.deepEqual(got.urls, {
    srcinfo: `${base}/.SRCINFO`,
    pkgbuild: `${base}/PKGBUILD`,
    page: "https://aur.archlinux.org/packages/yay-bin",
  });

  assert.equal(got.recipe.base, "yay-bin");
  assert.equal(got.recipe.version, "13.0.1-1");
  assert.deepEqual(got.recipe.depends, ["pacman>6.1", "git"]);
  assert.equal(got.recipe.sources[0].filename, "yay_13.0.1_x86_64.tar.gz");

  // The branch is rewritten in place on every update, so a cached copy
  // would be the recipe for the version before this one.
  assert.equal(urls.length, 2);
  for (const [, cache] of urls) {
    assert.equal(cache, "no-cache");
  }
});

test("fetchAurRecipe honours the architecture it is asked for", async () => {
  const srcinfo = await fixture("yay-bin.SRCINFO");
  const base = "https://raw.githubusercontent.com/archlinux/aur/yay-bin";
  mirror(new Map([[`${base}/.SRCINFO`, srcinfo]]));

  const got = await fetchAurRecipe("yay-bin", { arch: "aarch64" });
  assert.equal(got.recipe.sources[0].filename, "yay_13.0.1_aarch64.tar.gz");
  // A PKGBUILD the mirror will not serve is not fatal: nothing is built
  // from that copy, it is only read.
  assert.equal(got.pkgbuild, null);
});

test("a pkgbase with no branch is not in the mirror", async () => {
  mirror(new Map());
  await assert.rejects(
    () => fetchAurRecipe("nosuchpkgbase"),
    /^Error: nosuchpkgbase is not in the AUR mirror$/,
  );
});

test("any other failure names the URL that failed", async () => {
  setRecipeFetcher(async () => new Response("no", { status: 503 }));
  await assert.rejects(
    () => fetchAurRecipe("yay-bin"),
    /aur\/yay-bin\/\.SRCINFO: HTTP 503/,
  );

  setRecipeFetcher(async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    () => fetchAurRecipe("yay-bin"),
    /aur\/yay-bin\/\.SRCINFO: Failed to fetch/,
  );
});
