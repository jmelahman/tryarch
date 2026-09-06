// The two ways Arch describes a package, read into one shape.
//
// A repo database entry (`desc`, from core.db/extra.db) is "%KEY%"
// headers with their values on the following lines and a blank line
// between sections. A package's own `.PKGINFO` is "key = value" lines,
// repeated for list fields. They carry nearly the same facts under
// different names, so both parse into the same PackageMeta and the rest
// of the site never asks which one it got.

// Every field, empty. Built fresh each time: the list fields are
// arrays, and a shared one would collect every package's dependencies.
const empty = () => ({
  filename: null,
  name: null,
  base: null,
  version: null,
  desc: null,
  url: null,
  arch: null,
  builddate: null,
  packager: null,
  csize: null,
  isize: null,
  sha256: null,
  pgpsig: null,
  license: [],
  depends: [],
  optdepends: [],
  makedepends: [],
  checkdepends: [],
  provides: [],
  conflicts: [],
  replaces: [],
  groups: [],
  backup: [],
});

// A count that may be missing or unparsable; sizes and build dates are
// numbers everywhere else in the site.
function number(text) {
  if (text === undefined || text === null || text === "") {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// %KEY% -> the field it fills. A list field collects every line of its
// section; a scalar takes the first.
const DESC_SCALARS = {
  "%FILENAME%": "filename",
  "%NAME%": "name",
  "%BASE%": "base",
  "%VERSION%": "version",
  "%DESC%": "desc",
  "%URL%": "url",
  "%ARCH%": "arch",
  "%PACKAGER%": "packager",
  "%SHA256SUM%": "sha256",
  "%PGPSIG%": "pgpsig",
};

const DESC_NUMBERS = {
  "%CSIZE%": "csize",
  "%ISIZE%": "isize",
  "%BUILDDATE%": "builddate",
};

const DESC_LISTS = {
  "%LICENSE%": "license",
  "%DEPENDS%": "depends",
  "%OPTDEPENDS%": "optdepends",
  "%MAKEDEPENDS%": "makedepends",
  "%CHECKDEPENDS%": "checkdepends",
  "%PROVIDES%": "provides",
  "%CONFLICTS%": "conflicts",
  "%REPLACES%": "replaces",
  "%GROUPS%": "groups",
  "%BACKUP%": "backup",
};

// One `desc` (or the `depends` file older databases kept beside it).
// Unknown sections are skipped rather than refused: repo-add has added
// keys before and will again.
export function parseDesc(text) {
  const meta = empty();
  let key = null;

  for (const line of String(text ?? "").split("\n")) {
    const value = line.trim();
    if (value === "") {
      key = null;
      continue;
    }
    if (value.startsWith("%") && value.endsWith("%")) {
      key = value;
      continue;
    }
    if (key === null) {
      continue;
    }

    const list = DESC_LISTS[key];
    if (list !== undefined) {
      meta[list].push(value);
      continue;
    }
    const count = DESC_NUMBERS[key];
    if (count !== undefined) {
      meta[count] ??= number(value);
      continue;
    }
    const scalar = DESC_SCALARS[key];
    if (scalar !== undefined) {
      meta[scalar] ??= value;
    }
  }

  meta.base ??= meta.name;
  return meta;
}

// .PKGINFO keys -> fields. The singular names are makepkg's, repeated
// once per value; `size` is the installed size, which the database
// calls %ISIZE%.
const PKGINFO_SCALARS = {
  pkgname: "name",
  pkgbase: "base",
  pkgver: "version",
  pkgdesc: "desc",
  url: "url",
  arch: "arch",
  packager: "packager",
};

const PKGINFO_NUMBERS = { builddate: "builddate", size: "isize" };

const PKGINFO_LISTS = {
  license: "license",
  depend: "depends",
  optdepend: "optdepends",
  makedepend: "makedepends",
  checkdepend: "checkdepends",
  provides: "provides",
  conflict: "conflicts",
  replaces: "replaces",
  group: "groups",
  backup: "backup",
};

// A package's own .PKGINFO. It is the only place a dependency list can
// be read for an archived build, whose database entry is long gone.
export function parsePkginfo(text) {
  const meta = empty();

  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("#")) {
      continue;
    }
    const sep = line.indexOf("=");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (value === "") {
      continue;
    }

    const list = PKGINFO_LISTS[key];
    if (list !== undefined) {
      meta[list].push(value);
      continue;
    }
    const count = PKGINFO_NUMBERS[key];
    if (count !== undefined) {
      meta[count] ??= number(value);
      continue;
    }
    const scalar = PKGINFO_SCALARS[key];
    if (scalar !== undefined) {
      meta[scalar] ??= value;
    }
  }

  meta.base ??= meta.name;
  return meta;
}
