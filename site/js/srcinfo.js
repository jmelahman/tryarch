// The AUR's machine-readable recipe, read into a Recipe.
//
// Every AUR package ships a `.SRCINFO` beside its PKGBUILD: makepkg
// expanded the bash for us, so the sources, the dependencies and the
// version are plain text. That is what the page wants, because it has
// to know what to fetch before there is a VM to run bash in.
//
// The format is a `pkgbase` section followed by one section per
// `pkgname`, each line "\tkey = value". A key in a pkgname section
// *replaces* the pkgbase's value for that package rather than adding
// to it — a package that lists `depends` lists all of them — so the
// per-package fields are resolved with that rule and never merged.
//
// The build environment, though, needs the union: every dependency any
// section names has to be installed before makepkg runs, so `depends`
// and friends on the Recipe are the union across all sections while
// `packages[i].depends` stays the package's own answer.

import { recipeFiles, sourceList, unique, versionString } from "./sources.js";

// Keys that may appear more than once and accumulate into an array.
const LISTS = new Set([
  "arch",
  "depends",
  "makedepends",
  "checkdepends",
  "optdepends",
  "provides",
  "conflicts",
  "replaces",
  "source",
  "noextract",
  "validpgpkeys",
  "license",
  "groups",
  "backup",
  "options",
  "md5sums",
  "sha1sums",
  "sha224sums",
  "sha256sums",
  "sha384sums",
  "sha512sums",
  "b2sums",
]);

// Keys that hold one value; the last one written wins.
const SCALARS = new Set([
  "pkgver",
  "pkgrel",
  "epoch",
  "pkgdesc",
  "url",
  "install",
  "changelog",
]);

// Keys makepkg lets a recipe give per architecture, as "source_x86_64".
// No base key contains an underscore, so the first one splits the name.
const ARCHED = new Set([
  "depends",
  "makedepends",
  "checkdepends",
  "optdepends",
  "provides",
  "conflicts",
  "replaces",
  "source",
  "md5sums",
  "sha1sums",
  "sha224sums",
  "sha256sums",
  "sha384sums",
  "sha512sums",
  "b2sums",
]);

// One section: its own lists and scalars. The lists for the wanted
// architecture are kept apart from the generic ones so they can be
// appended after them — makepkg's order, and the order the checksum
// arrays are numbered in — however the file happened to list them.
const section = (name) => ({
  name,
  lists: new Map(),
  arched: new Map(),
  scalars: new Map(),
});

// A section's value for a list key: the generic entries, then the ones
// this architecture added.
const listOf = (sec, key) =>
  sec === null
    ? []
    : [...(sec.lists.get(key) ?? []), ...(sec.arched.get(key) ?? [])];

// Whether the section mentioned the key at all, which is what decides
// an override: a package that says `depends` replaces the pkgbase's
// list even if it went on to name nothing.
const declares = (sec, key) => sec.lists.has(key) || sec.arched.has(key);

const scalarOf = (sec, key) => {
  const value = sec === null ? undefined : sec.scalars.get(key);
  return value === undefined || value === "" ? null : value;
};

// The package's answer if it gave one, the pkgbase's otherwise.
const inheritList = (pkg, base, key) =>
  declares(pkg, key) ? listOf(pkg, key) : listOf(base, key);

const inheritScalar = (pkg, base, key) =>
  pkg.scalars.has(key) ? scalarOf(pkg, key) : scalarOf(base, key);

// Record one "key = value" line, dropping the architectures that were
// not asked for.
function record(sec, key, value, arch) {
  let name = key;
  let suffix = null;

  const underscore = key.indexOf("_");
  if (underscore !== -1 && ARCHED.has(key.slice(0, underscore))) {
    name = key.slice(0, underscore);
    suffix = key.slice(underscore + 1);
  }
  if (suffix !== null && suffix !== arch) {
    return;
  }

  if (LISTS.has(name)) {
    const map = suffix === null ? sec.lists : sec.arched;
    const list = map.get(name) ?? [];
    if (value !== "") {
      list.push(value);
    }
    map.set(name, list);
    return;
  }
  if (SCALARS.has(name)) {
    sec.scalars.set(name, value);
  }
}

// A `.SRCINFO` as the AUR serves it. `arch` picks which architecture's
// arch-suffixed keys are merged in; the others are dropped, so the
// sources and their checksums stay lined up.
export function parseSrcinfo(text, { arch = "x86_64" } = {}) {
  let base = null;
  let current = null;
  const packages = [];

  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    // Only a line that starts with "#" is a comment: a source's
    // "#tag=v1.2" is part of its value, not the start of one.
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === "pkgbase") {
      base = section(value);
      current = base;
      continue;
    }
    if (key === "pkgname") {
      current = section(value);
      packages.push(current);
      continue;
    }
    if (current === null) {
      continue;
    }
    record(current, key, value, arch);
  }

  if (base === null) {
    throw new Error(".SRCINFO has no pkgbase line");
  }

  const archList = listOf(base, "arch");
  const install = scalarOf(base, "install");
  const changelog = scalarOf(base, "changelog");

  const sources = sourceList(listOf(base, "source"), {
    md5sums: listOf(base, "md5sums"),
    sha1sums: listOf(base, "sha1sums"),
    sha224sums: listOf(base, "sha224sums"),
    sha256sums: listOf(base, "sha256sums"),
    sha384sums: listOf(base, "sha384sums"),
    sha512sums: listOf(base, "sha512sums"),
    b2sums: listOf(base, "b2sums"),
  });

  const built = packages.map((pkg) => ({
    name: pkg.name,
    desc: inheritScalar(pkg, base, "pkgdesc"),
    depends: inheritList(pkg, base, "depends"),
    provides: inheritList(pkg, base, "provides"),
    conflicts: inheritList(pkg, base, "conflicts"),
    replaces: inheritList(pkg, base, "replaces"),
    arch: inheritList(pkg, base, "arch"),
    install: inheritScalar(pkg, base, "install"),
    optdepends: inheritList(pkg, base, "optdepends"),
  }));

  // Everything the build environment needs, whichever section asked
  // for it.
  const across = (key) =>
    unique([
      ...listOf(base, key),
      ...packages.flatMap((pkg) => listOf(pkg, key)),
    ]);

  const epoch = scalarOf(base, "epoch");
  const pkgver = scalarOf(base, "pkgver");
  const pkgrel = scalarOf(base, "pkgrel");

  return {
    base: base.name,
    version: versionString({ epoch, pkgver, pkgrel }),
    pkgver,
    pkgrel,
    epoch,
    desc: scalarOf(base, "pkgdesc") ?? built[0]?.desc ?? null,
    url: scalarOf(base, "url"),
    arch: archList,
    any: archList.length === 1 && archList[0] === "any",
    install,
    depends: across("depends"),
    makedepends: across("makedepends"),
    checkdepends: across("checkdepends"),
    sources,
    noextract: listOf(base, "noextract"),
    validpgpkeys: listOf(base, "validpgpkeys"),
    packages: built,
    files: recipeFiles(sources, [
      install,
      changelog,
      ...packages.flatMap((pkg) => [
        inheritScalar(pkg, base, "install"),
        inheritScalar(pkg, base, "changelog"),
      ]),
    ]),
  };
}
