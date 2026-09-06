// Tests the source splitter against the shapes a real source=() holds.
// The name a source lands under is not cosmetic: the guest's makepkg
// looks for exactly that name in $srcdir, so a filename this module
// guesses differently is a download that builds nothing. The rules
// under test are libmakepkg's get_filename/get_protocol.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSource,
  recipeFiles,
  sourceList,
  unique,
  versionString,
} from "../../site/js/sources.js";

test("parseSource reads a plain remote URL", () => {
  assert.deepEqual(parseSource("https://example.invalid/dl/jq-1.8.2.tar.gz"), {
    spec: "https://example.invalid/dl/jq-1.8.2.tar.gz",
    filename: "jq-1.8.2.tar.gz",
    url: "https://example.invalid/dl/jq-1.8.2.tar.gz",
    kind: "remote",
    protocol: "https",
    fragment: null,
  });
});

test("parseSource reads a file from the recipe's own directory", () => {
  assert.deepEqual(parseSource("google-chrome-stable.sh"), {
    spec: "google-chrome-stable.sh",
    filename: "google-chrome-stable.sh",
    url: null,
    kind: "local",
    protocol: null,
    fragment: null,
  });
  // A patch is a local file too, and so is anything else without a
  // protocol — that is the whole test for "local".
  assert.equal(parseSource("0001-fix-build.patch").kind, "local");
});

test("parseSource honours a filename::url rename", () => {
  const source = parseSource(
    "spotify-1.2.96.518-x86_64.deb::http://repository.example/pool/s/spotify_1.2.96.518_amd64.deb",
  );
  assert.equal(source.filename, "spotify-1.2.96.518-x86_64.deb");
  assert.equal(
    source.url,
    "http://repository.example/pool/s/spotify_1.2.96.518_amd64.deb",
  );
  assert.equal(source.kind, "remote");
  assert.equal(source.protocol, "http");
});

test("parseSource resolves a vcs protocol prefix", () => {
  assert.deepEqual(parseSource("git+https://github.invalid/Jguer/yay.git"), {
    spec: "git+https://github.invalid/Jguer/yay.git",
    filename: "yay",
    url: "https://github.invalid/Jguer/yay.git",
    kind: "vcs",
    protocol: "git",
    fragment: null,
  });
  // Bare, without a transport, is the same handler.
  assert.equal(parseSource("git://git.invalid/tool.git").kind, "vcs");
  assert.equal(parseSource("hg+https://hg.invalid/tool").protocol, "hg");
  assert.equal(parseSource("svn+https://svn.invalid/trunk").kind, "vcs");
  assert.equal(parseSource("bzr+https://bzr.invalid/tool").kind, "vcs");
  assert.equal(parseSource("fossil+https://f.invalid/tool").kind, "vcs");
});

test("parseSource keeps the fragment out of the url", () => {
  const tagged = parseSource("git+https://github.invalid/a/b.git#tag=v1.2");
  assert.equal(tagged.url, "https://github.invalid/a/b.git");
  assert.equal(tagged.fragment, "tag=v1.2");
  assert.equal(tagged.filename, "b");

  const pinned = parseSource(
    "tool::git+https://github.invalid/a/b.git#commit=abc123",
  );
  assert.equal(pinned.filename, "tool");
  assert.equal(pinned.fragment, "commit=abc123");
});

test("parseSource leaves a remote URL's query string alone", () => {
  // Only the fragment is makepkg's; a query is part of what to fetch.
  const source = parseSource("https://example.invalid/get?file=x.tar.gz");
  assert.equal(source.filename, "get?file=x.tar.gz");
  assert.equal(source.url, "https://example.invalid/get?file=x.tar.gz");

  // ".git" on a plain download is part of the name, not a repository.
  assert.equal(
    parseSource("https://example.invalid/a/b.git").filename,
    "b.git",
  );
});

test("versionString spells a version the way pacman does", () => {
  assert.equal(
    versionString({ epoch: null, pkgver: "13.0.1", pkgrel: "1" }),
    "13.0.1-1",
  );
  assert.equal(
    versionString({ epoch: "1", pkgver: "1.2.96.518", pkgrel: "2" }),
    "1:1.2.96.518-2",
  );
  // Epoch 0 is the default and is left unsaid, as is a missing one.
  assert.equal(versionString({ epoch: "0", pkgver: "2", pkgrel: "3" }), "2-3");
  assert.equal(versionString({ epoch: "", pkgver: "2", pkgrel: "3" }), "2-3");
  assert.equal(versionString({ pkgver: "2" }), "2");
  assert.equal(versionString({ pkgver: null, pkgrel: "1" }), null);
  assert.equal(versionString({}), null);
});

test("sourceList lines checksums up with sources", () => {
  const sources = sourceList(
    ["https://example.invalid/a.tar.gz", "b.patch", "c.desktop"],
    { sha256sums: ["aa", "SKIP"], b2sums: ["", "bb", "cc"] },
  );

  assert.equal(sources[0].sums.sha256, "aa");
  assert.equal(sources[0].sums.b2, null);
  // "SKIP" is makepkg's "do not check this one".
  assert.equal(sources[1].sums.sha256, null);
  assert.equal(sources[1].sums.b2, "bb");
  // A source past the end of an array simply has no checksum.
  assert.equal(sources[2].sums.sha256, null);
  assert.equal(sources[2].sums.b2, "cc");
  assert.deepEqual(Object.keys(sources[0].sums), [
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "b2",
  ]);
});

test("recipeFiles names what has to come from the recipe's directory", () => {
  const sources = sourceList(
    ["https://example.invalid/a.tar.gz", "b.patch", "logo.png"],
    {},
  );
  assert.deepEqual(recipeFiles(sources, ["demo.install", null, "b.patch"]), [
    "b.patch",
    "logo.png",
    "demo.install",
  ]);
});

test("unique keeps the first mention", () => {
  assert.deepEqual(unique(["git", "pacman", "git", "go"]), [
    "git",
    "pacman",
    "go",
  ]);
});
