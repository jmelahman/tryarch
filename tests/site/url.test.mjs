// Tests the query string, which is the whole of the page's shareable
// state: what comes out of a link has to be what went into it, and a
// link built here has to keep working under a project path.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readUrl, writeUrl } from "../../site/js/url.js";

test("readUrl reads packages, versions and repos", () => {
  const state = readUrl(
    "?pkg=jq@1.7.1-2,bash&repo=https://example.invalid/x.db&boot=1",
  );
  assert.deepEqual(state.pkgs, [
    { name: "jq", version: "1.7.1-2" },
    { name: "bash", version: null },
  ]);
  assert.deepEqual(state.repos, ["https://example.invalid/x.db"]);
  assert.equal(state.boot, true);
});

test("an empty query is an empty selection", () => {
  const empty = { pkgs: [], repos: [], aur: [], pkgbuilds: [], boot: false };
  assert.deepEqual(readUrl(""), empty);
  assert.deepEqual(readUrl("?"), empty);
});

test("boot is only on when it says 1", () => {
  assert.equal(readUrl("?boot=0").boot, false);
  assert.equal(readUrl("?boot=yes").boot, false);
  assert.equal(readUrl("?pkg=jq").boot, false);
});

test("repeated parameters accumulate", () => {
  const state = readUrl("?pkg=jq&pkg=bash,zsh&repo=a.db&repo=b.db");
  assert.deepEqual(
    state.pkgs.map((one) => one.name),
    ["jq", "bash", "zsh"],
  );
  assert.deepEqual(state.repos, ["a.db", "b.db"]);
});

test("an epoch in a version survives the split", () => {
  // The separator is "@" and the version keeps its own colons, so
  // 1:26.2.2-1 arrives whole.
  assert.deepEqual(readUrl("?pkg=emacs@1:26.2.2-1").pkgs, [
    { name: "emacs", version: "1:26.2.2-1" },
  ]);
});

test("empty and blank entries are dropped", () => {
  assert.deepEqual(readUrl("?pkg=,,jq,%20,&repo=%20").pkgs, [
    { name: "jq", version: null },
  ]);
  assert.deepEqual(readUrl("?repo=%20").repos, []);
});

test("readUrl reads the AUR names and the pasted recipes", () => {
  const state = readUrl(
    "?pkg=jq&aur=yay-bin,paru&aur=downgrade&pkgbuild=https://example.invalid/PKGBUILD",
  );
  assert.deepEqual(state.aur, ["yay-bin", "paru", "downgrade"]);
  assert.deepEqual(state.pkgbuilds, ["https://example.invalid/PKGBUILD"]);
  // The two lanes are independent: an AUR name is not a package name.
  assert.deepEqual(state.pkgs, [{ name: "jq", version: null }]);
});

test("blank AUR names and blank recipe URLs are dropped", () => {
  const state = readUrl("?aur=,,yay,%20,&pkgbuild=%20&pkgbuild=%20a.sh%20");
  assert.deepEqual(state.aur, ["yay"]);
  assert.deepEqual(state.pkgbuilds, ["a.sh"]);
});

test("a PKGBUILD URL with a comma in it stays one recipe", () => {
  // Unlike a name list, a URL is never split: GitHub's raw host puts
  // commas in a path often enough to matter.
  assert.deepEqual(
    readUrl("?pkgbuild=https://example.invalid/a,b/PKGBUILD").pkgbuilds,
    ["https://example.invalid/a,b/PKGBUILD"],
  );
});

test("a repo URL with a comma in it stays one repo", () => {
  assert.deepEqual(readUrl("?repo=https://example.invalid/a,b/x.db").repos, [
    "https://example.invalid/a,b/x.db",
  ]);
});

test("writeUrl builds a link that reads back", () => {
  const state = {
    pkgs: [
      { name: "jq", version: "1.7.1-2" },
      { name: "bash", version: null },
    ],
    repos: ["https://example.invalid/x.db"],
  };
  const url = writeUrl(state);
  assert.equal(url.startsWith("/"), true);
  assert.equal(url.includes("boot="), false);

  const round = readUrl(url.slice(url.indexOf("?")));
  assert.deepEqual(round.pkgs, state.pkgs);
  assert.deepEqual(round.repos, state.repos);
});

test("writeUrl writes the AUR lane, and the link reads back", () => {
  const state = {
    pkgs: [{ name: "jq", version: null }],
    repos: ["https://example.invalid/x.db"],
    aur: ["yay-bin", "paru"],
    pkgbuilds: ["https://example.invalid/a,b/PKGBUILD"],
  };
  const url = writeUrl(state);
  // What is being installed comes before where it comes from.
  assert.deepEqual(
    [...new URLSearchParams(url.slice(url.indexOf("?"))).keys()],
    ["pkg", "aur", "aur", "pkgbuild", "repo"],
  );

  const round = readUrl(url.slice(url.indexOf("?")));
  assert.deepEqual(round.pkgs, state.pkgs);
  assert.deepEqual(round.repos, state.repos);
  assert.deepEqual(round.aur, state.aur);
  assert.deepEqual(round.pkgbuilds, state.pkgbuilds);
  assert.equal(round.boot, false);
});

test("boot is written last", () => {
  const url = writeUrl({ aur: ["yay"] }, { boot: true });
  assert.equal(url.endsWith("?aur=yay&boot=1"), true, url);
});

test("writeUrl adds boot only when asked", () => {
  assert.equal(writeUrl({ pkgs: [] }, { boot: true }).includes("boot=1"), true);
  assert.equal(writeUrl({ pkgs: [] }).includes("boot"), false);
});

test("an empty selection is the bare path", () => {
  assert.equal(writeUrl({}), "/");
  assert.equal(writeUrl({ pkgs: [], repos: [] }), "/");
  assert.equal(writeUrl({ aur: [], pkgbuilds: [] }), "/");
});

test("writeUrl keeps the page's own path", () => {
  const original = globalThis.location;
  // The site is served from /tryarch/ on GitHub Pages; a link that
  // dropped the prefix would 404.
  Object.defineProperty(globalThis, "location", {
    value: { pathname: "/tryarch/", search: "" },
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(
      writeUrl({ pkgs: [{ name: "jq", version: null }] }),
      "/tryarch/?pkg=jq",
    );
  } finally {
    if (original === undefined) {
      delete globalThis.location;
    } else {
      Object.defineProperty(globalThis, "location", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  }
});
