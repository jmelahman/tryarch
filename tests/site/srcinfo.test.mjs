// Tests the .SRCINFO reader against files the AUR is serving right
// now, fetched from https://raw.githubusercontent.com/archlinux/aur.
// They are the interesting shapes rather than a sample: a binary
// package whose sources are per-architecture, one with local files
// beside its download, a VCS checkout, a split package whose sections
// override the pkgbase, and an epoch. What the page does with a recipe
// — which packages to install, which files to fetch or ask for — is
// decided entirely by what these assertions say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseSrcinfo } from "../../site/js/srcinfo.js";

const read = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parseSrcinfo reads a simple binary package", async () => {
  const recipe = parseSrcinfo(await read("yay-bin.SRCINFO"));

  assert.equal(recipe.base, "yay-bin");
  assert.equal(recipe.version, "13.0.1-1");
  assert.equal(recipe.pkgver, "13.0.1");
  assert.equal(recipe.pkgrel, "1");
  assert.equal(recipe.epoch, null);
  assert.equal(
    recipe.desc,
    "Yet another yogurt. Pacman wrapper and AUR helper written in go. Pre-compiled.",
  );
  assert.equal(recipe.url, "https://github.com/Jguer/yay");
  assert.deepEqual(recipe.arch, ["x86_64", "aarch64", "armv7h"]);
  assert.equal(recipe.any, false);
  assert.equal(recipe.install, null);
  // A version constraint travels with the name; vercmp.js takes it
  // apart when the page goes looking for the package.
  assert.deepEqual(recipe.depends, ["pacman>6.1", "git"]);
  assert.deepEqual(recipe.makedepends, []);
  assert.deepEqual(recipe.packages, [
    {
      name: "yay-bin",
      desc: "Yet another yogurt. Pacman wrapper and AUR helper written in go. Pre-compiled.",
      depends: ["pacman>6.1", "git"],
      provides: ["yay"],
      conflicts: ["yay"],
      replaces: [],
      arch: ["x86_64", "aarch64", "armv7h"],
      install: null,
      optdepends: ["sudo: privilege elevation", "doas: privilege elevation"],
    },
  ]);
  // Nothing to ask the visitor for: every source is a download.
  assert.deepEqual(recipe.files, []);
});

test("parseSrcinfo keeps only the architecture it was asked for", async () => {
  const text = await read("yay-bin.SRCINFO");

  const x86 = parseSrcinfo(text);
  assert.equal(x86.sources.length, 1);
  assert.equal(x86.sources[0].filename, "yay_13.0.1_x86_64.tar.gz");
  assert.equal(
    x86.sources[0].sums.sha256,
    "1fdfcb5f7f387bc858d3a5754bdf4e4575bfbddac9560535a716d0ed7189c057",
  );

  // The checksum has to follow the source it belongs to, not its
  // position in the file.
  const arm = parseSrcinfo(text, { arch: "aarch64" });
  assert.equal(arm.sources.length, 1);
  assert.equal(arm.sources[0].filename, "yay_13.0.1_aarch64.tar.gz");
  assert.equal(
    arm.sources[0].sums.sha256,
    "75bc500c8677d6760f51117ae0a61689e9cf165bea3c4800825a5c879d030726",
  );
});

test("parseSrcinfo appends an architecture's sources to the generic ones", async () => {
  const recipe = parseSrcinfo(await read("google-chrome.SRCINFO"));

  assert.equal(recipe.install, "google-chrome.install");
  assert.deepEqual(
    recipe.sources.map((source) => [source.filename, source.kind]),
    [
      ["eula_text.html", "local"],
      ["google-chrome-stable.sh", "local"],
      ["google-chrome-stable_152.0.7977.82-1_amd64.deb", "remote"],
    ],
  );
  assert.equal(
    recipe.sources[0].sums.sha512,
    "a225555c06b7c32f9f2657004558e3f996c981481dbb0d3cd79b1d59fa3f05d591af88399422d3ab29d9446c103e98d567aeafe061d9550817ab6e7eb0498396",
  );
  assert.equal(
    recipe.sources[2].sums.sha512,
    "867c023deb01fb838aa6a53291a617a9e18b8ff147a35c8b4af77956d633418544c49fadfd8e53a767d0a23a1f75e3b11e7ee32695c3242c24c65aa2b23791d7",
  );
  assert.equal(recipe.sources[2].sums.sha256, null);
  // The two local sources and the install script are what the page has
  // to get from somewhere other than a URL.
  assert.deepEqual(recipe.files, [
    "eula_text.html",
    "google-chrome-stable.sh",
    "google-chrome.install",
  ]);
});

test("parseSrcinfo reads a vcs source", async () => {
  const recipe = parseSrcinfo(await read("yay-git.SRCINFO"));

  assert.equal(recipe.version, "13.0.1.r0.g02fb6ba9-1");
  assert.deepEqual(recipe.makedepends, ["go>=1.24"]);
  assert.deepEqual(recipe.sources, [
    {
      spec: "yay::git+https://github.com/Jguer/yay.git#branch=next",
      filename: "yay",
      url: "https://github.com/Jguer/yay.git",
      kind: "vcs",
      protocol: "git",
      fragment: "branch=next",
      sums: {
        md5: null,
        sha1: null,
        sha224: null,
        // SKIP is not a checksum: a clone has nothing to check.
        sha256: null,
        sha384: null,
        sha512: null,
        b2: null,
      },
    },
  ]);
  assert.deepEqual(recipe.files, []);
});

test("parseSrcinfo lets a pkgname section replace the pkgbase's list", async () => {
  const recipe = parseSrcinfo(await read("libc++.SRCINFO"));

  assert.equal(recipe.base, "libc++");
  assert.equal(recipe.version, "11.0.0-1");
  // The pkgbase has no description of its own, so the first package
  // speaks for the recipe.
  assert.equal(recipe.desc, "LLVM C++ standard library.");
  assert.deepEqual(
    recipe.packages.map((pkg) => [pkg.name, pkg.depends]),
    [
      // Listing depends replaces the pkgbase's list rather than adding
      // to it...
      ["libc++", ["libc++abi=11.0.0-1"]],
      // ...and a section that lists none inherits it.
      ["libc++abi", ["gcc-libs"]],
      ["libc++experimental", ["libc++=11.0.0-1"]],
    ],
  );
  // The build environment still needs every one of them.
  assert.deepEqual(recipe.depends, [
    "gcc-libs",
    "libc++abi=11.0.0-1",
    "libc++=11.0.0-1",
  ]);
  assert.deepEqual(recipe.makedepends, [
    "clang",
    "cmake",
    "llvm",
    "libunwind",
    "ninja",
    "python",
  ]);
  assert.deepEqual(recipe.validpgpkeys, [
    "474E22316ABF4785A88C6E8EA2C794A986419D8A",
    "B6C8F98282B944E3B0D5C2530FC3042E345AD05D",
  ]);
  assert.equal(recipe.noextract.length, 6);
  // The signatures are SKIP; the tarballs are checked.
  assert.deepEqual(
    recipe.sources.map((source) => source.sums.sha512 !== null),
    [true, false, true, false, true, false],
  );
});

test("parseSrcinfo puts an epoch in the version", async () => {
  const recipe = parseSrcinfo(await read("spotify.SRCINFO"));

  assert.equal(recipe.epoch, "1");
  assert.equal(recipe.version, "1:1.2.96.518-2");
  assert.deepEqual(
    recipe.sources.map((source) => source.filename),
    [
      "spotify-1.2.96.518-g366879e1-x86_64.deb",
      "spotify.sh",
      "spotify.protocol",
      "LICENSE",
      "spotify-1.2.96.518-2-Release",
      "spotify-1.2.96.518-2-Release.sig",
      "spotify-1.2.96.518-2-x86_64-Packages",
    ],
  );
  // A renamed download keeps the URL it came from.
  assert.equal(
    recipe.sources[0].url,
    "http://repository.spotify.com/pool/non-free/s/spotify-client/spotify-client_1.2.96.518.g366879e1_amd64.deb",
  );
  assert.deepEqual(recipe.files, ["spotify.sh", "spotify.protocol", "LICENSE"]);
});

test("parseSrcinfo marks an architecture-independent package", async () => {
  const recipe = parseSrcinfo(await read("nvm.SRCINFO"));

  assert.deepEqual(recipe.arch, ["any"]);
  assert.equal(recipe.any, true);
  assert.equal(recipe.install, "nvm.install");
  assert.deepEqual(recipe.files, [
    "init-nvm.sh",
    "install-nvm-exec",
    "nvm.install",
  ]);
});

test("parseSrcinfo ignores comments and keeps '=' inside a value", () => {
  const recipe = parseSrcinfo(
    [
      "# Generated by makepkg",
      "pkgbase = demo",
      "\tpkgver = 1.0",
      "\tpkgrel = 1",
      "\tdepends = libz.so=1-64",
      "\tsource = demo::git+https://example.invalid/demo.git#tag=v1.0",
      "",
      "pkgname = demo",
      "",
    ].join("\n"),
  );

  assert.deepEqual(recipe.depends, ["libz.so=1-64"]);
  // A "#" mid-line belongs to the value: it is how makepkg pins a tag.
  assert.equal(recipe.sources[0].fragment, "tag=v1.0");
});

test("parseSrcinfo refuses a file with no pkgbase", () => {
  assert.throws(() => parseSrcinfo("pkgname = demo\n\tpkgver = 1"), {
    message: /pkgbase/,
  });
});
