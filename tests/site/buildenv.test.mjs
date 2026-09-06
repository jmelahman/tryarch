// Tests what the page hands the guest for a build and what it makes of
// the answer: which packages a recipe needs before makepkg can run, the
// driver script and its markers, and the archive of packages the guest
// writes back, taken apart with the same code a download goes through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BUILD_PROFILES,
  FAKEROOT_SHIM,
  MAKEPKG_CONF,
  buildMarkers,
  buildScript,
  buildWants,
  builtBuild,
  profileFor,
  unbundle,
} from "../../site/js/buildenv.js";
import { parsePkgbuild } from "../../site/js/pkgbuild.js";
import { tar } from "./tarball.mjs";

const EXAMPLE = await readFile(
  new URL("../../examples/hello-tryarch/PKGBUILD", import.meta.url),
  "utf8",
);
const example = parsePkgbuild(EXAMPLE);

const PKGINFO = `pkgname = hello
pkgbase = hello
pkgver = 1.0.0-1
pkgdesc = says hello
size = 4096
builddate = 1780000000
depend = sh
depend = glibc>=2.40
provides = greeter
`;

// One package as makepkg writes it: metadata dot-files first, then
// the tree.
const INNER = tar({
  ".PKGINFO": PKGINFO,
  ".MTREE": "not a real mtree",
  "usr/": "",
  "usr/bin/": "",
  "usr/bin/hello": "#!/bin/sh\necho hello\n",
});

test("a recipe with a build() step wants the compiler", () => {
  assert.equal(profileFor(example, EXAMPLE), "makepkg");
  assert.equal(
    profileFor(example, "pkgname=x\nbuild() {\n  make\n}\n"),
    "compile",
  );
  assert.equal(profileFor(example, "build () {\n:\n}\n"), "compile");
  // A mention in a comment is not a step.
  assert.equal(profileFor(example, "# no build() here\n"), "makepkg");
  // Without the text, the architecture is the guess.
  assert.equal(profileFor({ any: true }), "makepkg");
  assert.equal(profileFor({ any: false }), "compile");
});

test("buildWants is the recipe's needs plus the profile, once each", () => {
  const recipe = {
    depends: ["glibc", "sh"],
    makedepends: ["make", "bash"],
    packages: [{ depends: ["sh"] }, { depends: ["zlib"] }],
  };
  const wants = buildWants(recipe, "makepkg");
  assert.equal(new Set(wants).size, wants.length);
  for (const name of ["glibc", "sh", "make", "zlib", "pacman", "bash"]) {
    assert.ok(wants.includes(name), name);
  }
  assert.ok(!wants.includes("gcc"));
  assert.ok(buildWants(recipe, "compile").includes("gcc"));
  assert.ok(BUILD_PROFILES.compile.length > BUILD_PROFILES.makepkg.length);
});

test("the markers name the build and never match another's", () => {
  const one = buildMarkers(1);
  const ten = buildMarkers(10);
  const script = buildScript({ n: 10, base: "hello", version: "1.0.0-1" });
  assert.ok(script.includes(ten.done));
  assert.ok(!script.includes(one.done));
  assert.ok(!script.includes(one.failed));
  // The line the driver prints when it starts is not the done marker.
  assert.ok(!`${ten.started}hello 1.0.0-1`.includes(ten.done));
});

test("the driver runs makepkg the way the guest can", () => {
  const script = buildScript({ n: 3, base: "hello", version: "1.0.0-1" });
  const { done, failed } = buildMarkers(3);
  assert.ok(script.startsWith("#!/bin/bash\n"));
  assert.ok(script.includes(`echo "${done}"`));
  assert.ok(script.includes(`echo "${failed}: $1"`));
  assert.ok(script.includes(`trap 'fail "interrupted"' INT TERM`));
  assert.ok(script.includes("share=/share/tryarch/3\n"));
  assert.ok(script.includes("MAKEPKG_LINT_PKGBUILD=0"));
  assert.ok(script.includes("--nodeps --noconfirm --nocheck --skippgpcheck"));
  assert.ok(script.includes("if false; then"));
  assert.ok(script.includes('bsdtar -cf "$share/out.tar"'));
  // Every failure has a reason after the marker.
  for (const line of script.split("\n")) {
    if (line.includes("|| fail")) {
      assert.match(line, /\|\| fail "[^"]+"/, line);
    }
  }
});

test("the makepkg.conf and fakeroot the guest gets", () => {
  assert.ok(MAKEPKG_CONF.includes("PKGEXT='.pkg.tar'"));
  assert.ok(MAKEPKG_CONF.includes("MAKEFLAGS='-j1'"));
  assert.ok(MAKEPKG_CONF.includes("/share/etc/makepkg.conf"));
  assert.ok(FAKEROOT_SHIM.startsWith("#!/bin/sh\n"));
  assert.ok(FAKEROOT_SHIM.includes('FAKEROOTKEY=0 exec "$@"'));
});

test("unbundle takes each .pkg.tar apart like a download", () => {
  const outer = tar({
    "./": "",
    "./hello-1.0.0-1-any.pkg.tar": INNER,
    "./hello-1.0.0-1-any.pkg.tar.sig": "not a package",
  });
  const packages = unbundle(outer);
  assert.equal(packages.length, 1);
  const [pkg] = packages;
  assert.equal(pkg.filename, "hello-1.0.0-1-any.pkg.tar");
  assert.equal(pkg.size, INNER.byteLength);
  assert.equal(pkg.meta.name, "hello");
  assert.equal(pkg.meta.version, "1.0.0-1");
  assert.deepEqual(pkg.meta.depends, ["sh", "glibc>=2.40"]);
  assert.equal(pkg.install, null);
  // The dot-files are gone; the tree is what gets unpacked.
  assert.deepEqual(
    pkg.entries.map((entry) => entry.path),
    ["usr", "usr/bin", "usr/bin/hello"],
  );
});

test("unbundle refuses an archive with nothing in it", () => {
  assert.throws(() => unbundle(tar({ "./": "" })), /handed back no package/);
  const noInfo = tar({ "./x-1-1-any.pkg.tar": tar({ "usr/": "" }) });
  assert.throws(() => unbundle(noInfo), /no \.PKGINFO/);
});

test("builtBuild is a Build with no source to fetch from", () => {
  const [pkg] = unbundle(tar({ "hello-1.0.0-1-any.pkg.tar": INNER }));
  const build = builtBuild(pkg, { pkgbuild: "https://example.org/PKGBUILD" });
  assert.equal(build.name, "hello");
  assert.equal(build.base, "hello");
  assert.equal(build.version, "1.0.0-1");
  assert.equal(build.repo, "built");
  assert.equal(build.filename, "hello-1.0.0-1-any.pkg.tar");
  assert.deepEqual(build.urls, []);
  assert.equal(build.digest, null);
  assert.equal(build.size, INNER.byteLength);
  assert.equal(build.isize, 4096);
  assert.equal(build.builddate, 1780000000);
  assert.deepEqual(build.depends, ["sh", "glibc>=2.40"]);
  assert.deepEqual(build.provides, ["greeter"]);
  assert.equal(build.pkgbuild, "https://example.org/PKGBUILD");
  assert.equal(builtBuild(pkg).pkgbuild, null);
});
