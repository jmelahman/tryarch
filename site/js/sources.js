// A makepkg `source=()` entry, split the way makepkg splits it.
//
// An entry is "[filename::]url[#fragment]", or a bare filename for a
// file that sits next to the PKGBUILD. The page has to tell the three
// apart before the VM boots: a remote URL it can fetch itself, a VCS
// URL the guest has to clone, and a local file that only the visitor
// can supply. The naming rules here are libmakepkg's get_filename and
// get_protocol (libmakepkg/util/source.sh), because the real makepkg
// in the guest will look for exactly the names they produce in $srcdir
// — a name invented here would download a file nothing builds with.
//
// The rest of the module is the small pieces both recipe parsers need
// — the version string, the checksums a source carries, the files a
// recipe expects beside it — kept in one place so srcinfo.js and
// pkgbuild.js agree on them by construction rather than by review.

// The protocols makepkg hands to a version control handler. They show
// up bare ("git://…") or as a prefix on the transport ("git+https://…"),
// which is why the prefix is what decides, not the whole scheme.
const VCS = new Set(["git", "hg", "svn", "bzr", "fossil"]);

// makepkg's checksum arrays and the short name each one takes in a
// source's `sums`. The i-th entry of an array belongs to the i-th
// source, which is the only thing that ties the two lists together.
const SUMS = {
  md5sums: "md5",
  sha1sums: "sha1",
  sha224sums: "sha224",
  sha256sums: "sha256",
  sha384sums: "sha384",
  sha512sums: "sha512",
  b2sums: "b2",
};

// One source entry. Nothing here validates the URL: an entry makepkg
// would reject still parses, because the page's job is to guess what
// to fetch and the guest's makepkg remains the authority.
export function parseSource(spec) {
  const text = String(spec ?? "").trim();

  // makepkg splits on the first "::" and only then looks for a
  // protocol, so the rename never has to be told apart from a scheme.
  const rename = text.indexOf("::");
  const named = rename === -1 ? null : text.slice(0, rename);
  const rest = rename === -1 ? text : text.slice(rename + 2);

  const scheme = rest.indexOf("://");
  if (scheme === -1) {
    // No protocol at all: a file from the recipe's own directory.
    return {
      spec: text,
      filename: named ?? text,
      url: null,
      kind: "local",
      protocol: null,
      fragment: null,
    };
  }

  // "git+https" is the git handler over https. makepkg dispatches on
  // the part before the "+", and the "+" is not part of the URL.
  const head = rest.slice(0, scheme);
  const plus = head.indexOf("+");
  const protocol = plus === -1 ? head : head.slice(0, plus);
  const whole = plus === -1 ? rest : rest.slice(plus + 1);

  // The fragment is makepkg's, not the server's: "#tag=v1.2" tells the
  // VCS handler what to check out and never reaches the wire.
  const hash = whole.indexOf("#");
  const url = hash === -1 ? whole : whole.slice(0, hash);
  const fragment = hash === -1 ? null : whole.slice(hash + 1) || null;

  const kind = VCS.has(protocol) ? "vcs" : "remote";

  let filename = named;
  if (filename === null) {
    const path = url.replace(/\/+$/, "");
    filename = path.slice(path.lastIndexOf("/") + 1);
    // A clone lands in a directory, and makepkg drops the ".git" that
    // the repository URL carries.
    if (kind === "vcs") {
      filename = filename.replace(/\.git$/, "");
    }
  }

  return { spec: text, filename, url, kind, protocol, fragment };
}

// "epoch:pkgver-pkgrel", the way pacman prints it. Epoch 0 is the
// default and is left out, and a recipe with no pkgrel yet (a bare
// pkgver in a half-written PKGBUILD) still gets a usable string.
export function versionString({ epoch, pkgver, pkgrel } = {}) {
  const version = pkgver == null ? "" : String(pkgver);
  if (version === "") {
    return null;
  }
  const era = epoch == null ? "" : String(epoch);
  const release = pkgrel == null ? "" : String(pkgrel);
  const prefix = era === "" || era === "0" ? "" : `${era}:`;
  const suffix = release === "" ? "" : `-${release}`;
  return `${prefix}${version}${suffix}`;
}

// The sources of a recipe, each carrying whatever checksums the recipe
// listed for it. `arrays` is keyed by makepkg's own names
// ("sha256sums"), since that is what both parsers collect. "SKIP" is
// makepkg's "do not check this one", which is the same as having no
// checksum for the page's purposes.
export function sourceList(specs, arrays = {}) {
  return specs.map((spec, i) => {
    const source = parseSource(spec);
    source.sums = {};
    for (const [key, name] of Object.entries(SUMS)) {
      const sum = arrays[key]?.[i] ?? null;
      source.sums[name] =
        sum === null || sum === "" || sum === "SKIP" ? null : sum;
    }
    return source;
  });
}

// The files a recipe expects to find beside itself: every local source,
// plus the install and changelog scripts, which are named rather than
// listed as sources. The page has to ask the visitor for these, so the
// order is the order they were mentioned in and each is named once.
export function recipeFiles(sources, extras = []) {
  const files = [];
  const add = (name) => {
    if (name && !files.includes(name)) {
      files.push(name);
    }
  };
  for (const source of sources) {
    if (source.kind === "local") {
      add(source.filename);
    }
  }
  for (const name of extras) {
    add(name);
  }
  return files;
}

// First appearance wins, which is what makes a dependency union across
// a split package's sections read like the PKGBUILD did.
export const unique = (values) => [...new Set(values)];
