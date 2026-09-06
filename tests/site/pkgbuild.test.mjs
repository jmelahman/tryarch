// Tests the best-effort PKGBUILD reader. Most of the fixtures are real
// AUR recipes fetched from https://raw.githubusercontent.com/archlinux/aur,
// and the last test is the one that matters: for a recipe that also
// ships a .SRCINFO, reading the bash without bash has to land on the
// same base, version, dependencies and source filenames that makepkg
// wrote down. Two fixtures are hand-written instead — the syntax
// corners (a comment inside an array, an assignment in a function
// body, the ${var/a/b} family) do not all occur in one real package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parsePkgbuild } from "../../site/js/pkgbuild.js";
import { parseSrcinfo } from "../../site/js/srcinfo.js";

const read = (name) =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parsePkgbuild reads a binary package's assignments", async () => {
  const recipe = parsePkgbuild(await read("yay-bin.PKGBUILD"));

  assert.equal(recipe.base, "yay-bin");
  assert.equal(recipe.version, "13.0.1-1");
  assert.equal(
    recipe.desc,
    "Yet another yogurt. Pacman wrapper and AUR helper written in go. Pre-compiled.",
  );
  assert.equal(recipe.url, "https://github.com/Jguer/yay");
  assert.deepEqual(recipe.arch, ["x86_64", "aarch64", "armv7h"]);
  // The array runs over three lines and the quotes come off.
  assert.deepEqual(recipe.depends, ["pacman>6.1", "git"]);
  // "${pkgname/-bin/}" is a substitution on an earlier assignment, and
  // getting it wrong means downloading nothing.
  assert.deepEqual(
    recipe.sources.map((source) => source.filename),
    ["yay_13.0.1_x86_64.tar.gz"],
  );
  assert.equal(
    recipe.sources[0].sums.sha256,
    "1fdfcb5f7f387bc858d3a5754bdf4e4575bfbddac9560535a716d0ed7189c057",
  );
  assert.deepEqual(
    recipe.packages.map((pkg) => pkg.name),
    ["yay-bin"],
  );
});

test("parsePkgbuild picks the architecture's arrays", async () => {
  const recipe = parsePkgbuild(await read("yay-bin.PKGBUILD"), {
    arch: "armv7h",
  });

  assert.deepEqual(
    recipe.sources.map((source) => source.filename),
    ["yay_13.0.1_armv7h.tar.gz"],
  );
  assert.equal(
    recipe.sources[0].sums.sha256,
    "9fe24f478ff6b80252fd6591061d478f0579e9118bc2522efe5328550870502f",
  );
});

test("parsePkgbuild reads a vcs source and skips the function bodies", async () => {
  const recipe = parsePkgbuild(await read("yay-git.PKGBUILD"));

  assert.equal(recipe.base, "yay-git");
  // pkgver() computes the version in the guest; the assignment above
  // it is all this parser can honestly report.
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
        sha256: null,
        sha384: null,
        sha512: null,
        b2: null,
      },
    },
  ]);
});

test("parsePkgbuild survives the syntax corners", async () => {
  const recipe = parsePkgbuild(await read("edge-cases.PKGBUILD"));

  assert.equal(recipe.base, "edge-cases");
  // build() sets pkgver=999 in column 0. It is inside a function body,
  // so it is not a top-level assignment and must not be read as one.
  assert.equal(recipe.pkgver, "1.2.3");
  assert.equal(recipe.version, "1:1.2.3-2");
  assert.equal(recipe.epoch, "1");
  assert.deepEqual(recipe.arch, ["any"]);
  assert.equal(recipe.any, true);
  // A "#" inside quotes is text, and so are the parens.
  assert.equal(
    recipe.desc,
    "Quotes, commas (and parens) # and a hash that is not a comment",
  );
  // The array spans lines and carries both a trailing comment and a
  // comment of its own; "+=" adds to what was already there.
  assert.deepEqual(recipe.depends, ["bash", "python>=3.11", "curl"]);
  assert.equal(recipe.install, "edge-cases.install");
  assert.deepEqual(recipe.noextract, ["edge-cases-1.2.3.tar.gz"]);

  // ${pkgver%.*} -> 1.2, ${pkgver//./_} -> 1_2_3, ${pkgname#edge-} ->
  // cases, all of them through a source's name or URL, and the
  // "{,.asc}" of the last one is two sources rather than one.
  assert.deepEqual(
    recipe.sources.map((source) => [source.filename, source.url, source.kind]),
    [
      [
        "edge-cases-1.2.3.tar.gz",
        "https://example.invalid/1.2/1_2_3.tar.gz",
        "remote",
      ],
      ["fix-cases.patch", null, "local"],
      ["tool", "https://example.invalid/tool.git", "vcs"],
      ["extra.tar.gz", "https://example.invalid/1.2/extra.tar.gz", "remote"],
      [
        "extra.tar.gz.asc",
        "https://example.invalid/1.2/extra.tar.gz.asc",
        "remote",
      ],
    ],
  );
  assert.equal(recipe.sources[2].fragment, "tag=v1.2");
  // The checksums line up with the sources, SKIP and all — which is
  // the reason brace expansion cannot be left for the guest.
  assert.deepEqual(
    recipe.sources.map((source) => source.sums.sha256),
    [
      null,
      "3f786850e387550fdab836ed7e6dc881de23001b73aba05ab9d3f2f4de6b4a2f",
      null,
      "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      null,
    ],
  );
  assert.deepEqual(recipe.files, [
    "fix-cases.patch",
    "edge-cases.install",
    "ChangeLog",
  ]);
});

test("parsePkgbuild gives a split package's names the shared metadata", async () => {
  const recipe = parsePkgbuild(await read("split.PKGBUILD"));

  assert.equal(recipe.base, "demo");
  assert.equal(recipe.version, "2.0-1");
  // "${arch[0]}" names an element of an earlier array.
  assert.deepEqual(
    recipe.sources.map((source) => source.filename),
    ["demo-2.0-x86_64.tar.gz"],
  );
  // package_demo() adds zlib and package_demo-docs() drops everything,
  // but both are bash. Every package gets the top-level list, which
  // over-estimates rather than under-estimates what to install.
  assert.deepEqual(recipe.packages, [
    {
      name: "demo",
      desc: null,
      depends: ["glibc"],
      provides: [],
      conflicts: [],
      replaces: [],
      arch: ["x86_64"],
      install: null,
      optdepends: [],
    },
    {
      name: "demo-docs",
      desc: null,
      depends: ["glibc"],
      provides: [],
      conflicts: [],
      replaces: [],
      arch: ["x86_64"],
      install: null,
      optdepends: [],
    },
  ]);
});

test("parsePkgbuild expands a recipe's own variables", async () => {
  // google-chrome names its channel once and uses it in the install
  // file, the local script and the download.
  const recipe = parsePkgbuild(await read("google-chrome.PKGBUILD"));

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
    recipe.sources[2].sums.sha512,
    "867c023deb01fb838aa6a53291a617a9e18b8ff147a35c8b4af77956d633418544c49fadfd8e53a767d0a23a1f75e3b11e7ee32695c3242c24c65aa2b23791d7",
  );
  assert.deepEqual(recipe.files, [
    "eula_text.html",
    "google-chrome-stable.sh",
    "google-chrome.install",
  ]);
});

test("parsePkgbuild reads an unquoted rename and an epoch", async () => {
  const recipe = parsePkgbuild(await read("otf-san-francisco.PKGBUILD"));

  assert.equal(recipe.version, "1:2-2");
  assert.equal(recipe.any, true);
  assert.equal(recipe.sources[0].filename, "SFPro-1.0.zip");
  assert.equal(
    recipe.sources[0].url,
    "https://developer.apple.com/fonts/downloads/SFPro.zip",
  );
});

test("parsePkgbuild expands a tarball and its signature", async () => {
  // "…{,.asc}" is how a recipe lists a detached signature beside its
  // download. It is one word in the file and two sources with two
  // checksums, so the page has to expand it to keep them paired.
  const recipe = parsePkgbuild(await read("libxcrypt-compat.PKGBUILD"));

  assert.deepEqual(
    recipe.sources.map((source) => [source.filename, source.sums.sha256]),
    [
      [
        "libxcrypt-4.4.28.tar.xz",
        "9e936811f9fad11dbca33ca19bd97c55c52eb3ca15901f27ade046cc79e69e87",
      ],
      ["libxcrypt-4.4.28.tar.xz.asc", null],
    ],
  );
  // ${pkgname%-compat} took the suffix off, and ${url} came from four
  // lines up.
  assert.equal(
    recipe.sources[0].url,
    "https://github.com/besser82/libxcrypt//releases/download/v4.4.28/libxcrypt-4.4.28.tar.xz",
  );
  // The comment after the key is not part of it.
  assert.deepEqual(recipe.validpgpkeys, [
    "678CE3FEE430311596DB8C16F52E98007594C21D",
  ]);
});

test("parsePkgbuild refuses a file with no pkgname", () => {
  assert.throws(() => parsePkgbuild("pkgver=1.0\npkgrel=1\n"), {
    message: /pkgname/,
  });
});

// The recipes below ship both files, so makepkg's own answer is on
// hand to check the guess against. They were picked for being plain
// bash — a PKGBUILD that computes its version cannot agree with a
// .SRCINFO by construction — and each one exercises something: a
// substitution in a source name, a VCS fragment, an "any" package with
// local files, a global substitution in a URL, arch-suffixed arrays.
for (const name of [
  "yay-bin",
  "yay-git",
  "nvm",
  "downgrade",
  "google-chrome",
  "libxcrypt-compat",
]) {
  test(`parsePkgbuild agrees with the .SRCINFO for ${name}`, async () => {
    const guessed = parsePkgbuild(await read(`${name}.PKGBUILD`));
    const known = parseSrcinfo(await read(`${name}.SRCINFO`));

    assert.equal(guessed.base, known.base);
    assert.equal(guessed.version, known.version);
    assert.deepEqual(guessed.depends, known.depends);
    assert.deepEqual(guessed.makedepends, known.makedepends);
    assert.deepEqual(
      guessed.sources.map((source) => source.filename),
      known.sources.map((source) => source.filename),
    );
    assert.deepEqual(
      guessed.sources.map((source) => source.url),
      known.sources.map((source) => source.url),
    );
    assert.deepEqual(guessed.files, known.files);
  });
}
