// Building a package inside the guest.
//
// A recipe cannot be built where the packages are unpacked: the share
// is a 9p export of the page's own in-memory filesystem, and the engine
// that serves it mishandles three things makepkg does on every build —
// creating a file, chmod through /proc/self/fd, and making a symlink,
// the last of which hangs the VM (docs/design.md). So a build never
// touches the share except to read. Everything happens in guest RAM
// under /tmp: makepkg runs there, writes the package there, and the
// only thing that comes back is the finished archive, written into a
// file the page created empty beforehand — writing into an existing
// file is the one operation that works — and read back by the page
// once the guest says it is done. The page then unpacks it with the
// same code that unpacks a downloaded package, and the guest finds
// the programs on its PATH like any other.
//
// The guest runs makepkg as root, because root is the only user it
// has. makepkg refuses that outright and wants fakeroot for the
// packaging step, neither of which means anything here: nothing in the
// share keeps ownership, and there is no second user to protect. So
// the driver patches the one `EUID == 0` test out of a copy of makepkg
// and gives it a fakeroot that fakes nothing.
//
// What the page writes for one build, under /share/tryarch/<n>/:
//
//   recipe/       the PKGBUILD, its sources and its .install files
//   makepkg.conf  the configuration below, sourced after the guest's
//   fakeroot      the shim
//   build.sh      the driver
//   out.tar       empty; the guest fills it with the packages it made
//
// <n> counts builds within one page, so a marker the guest prints
// belongs to exactly one build: the console is searched for it, and a
// marker that could have come from an earlier build would match at
// once.

import { splitEntries } from "./pkg.js";
import { parseTar } from "./tar.js";

// Where a build's files go on the share, relative to its root.
export const BUILD_DIR = "tryarch";

// What makepkg itself needs to run in the guest, with nothing to
// compile: the recipe copies files into place and makepkg packs them.
// This is what a `-bin` package or an `any` one takes. The set was
// found by running one and adding what it asked for; pacman is there
// for makepkg and its libraries, not for installing anything.
const MAKEPKG = [
  "pacman",
  "util-linux",
  "bash",
  "coreutils",
  "findutils",
  "grep",
  "sed",
  "gawk",
  "file",
  "gzip",
  "xz",
  "zstd",
  "bzip2",
  "libarchive",
  "patch",
  "diffutils",
  "which",
];

// A C toolchain on top of that, for a recipe with a build() step. The
// rest of base-devel is left out: autoconf and friends are makedepends
// when a recipe wants them, and every package here is a download and
// a share of the guest's memory.
const COMPILE = [...MAKEPKG, "gcc", "make", "binutils", "pkgconf"];

export const BUILD_PROFILES = { makepkg: MAKEPKG, compile: COMPILE };

// A build() function is the sign that something gets compiled; a
// recipe without one — most -bin packages, every `any` one — only
// needs makepkg. Without the PKGBUILD's text, the architecture is the
// next best guess.
export function profileFor(recipe, pkgbuild = null) {
  if (pkgbuild !== null) {
    return /^\s*build\s*\(\s*\)/m.test(pkgbuild) ? "compile" : "makepkg";
  }
  return recipe.any ? "makepkg" : "compile";
}

// Everything a build needs in the guest before it starts, as
// dependency specs for closure.js: the recipe's depends and
// makedepends, the packages' own depends so what it makes can run, and
// the profile's tools. checkdepends are left out — the guest runs with
// --nocheck; a test suite under an emulator is not the point.
export function buildWants(recipe, profile) {
  const specs = new Set([
    ...recipe.depends,
    ...recipe.makedepends,
    ...recipe.packages.flatMap((pkg) => pkg.depends),
    ...BUILD_PROFILES[profile],
  ]);
  return [...specs];
}

// Sourced by makepkg instead of /etc/makepkg.conf. The guest's own is
// read first, so CFLAGS and the rest are Arch's, and then the choices
// that matter here: nothing is compressed, because the page unpacks
// the archive itself and zstd in an emulator is time for nothing;
// nothing is stripped or signed; one job, since the VM has one CPU.
// /etc/makepkg.conf is only there if pacman was in the share when the
// guest booted — init copies /etc once — so its copy on the share is
// the fallback.
export const MAKEPKG_CONF = `# tryarch: sourced by makepkg in place of /etc/makepkg.conf.
for _tryarch_conf in /etc/makepkg.conf /share/etc/makepkg.conf; do
  if [ -r "$_tryarch_conf" ]; then
    source "$_tryarch_conf"
    break
  fi
done
for _tryarch_conf in /etc/makepkg.conf.d/*.conf /share/etc/makepkg.conf.d/*.conf; do
  [ -r "$_tryarch_conf" ] && source "$_tryarch_conf"
done
unset _tryarch_conf
OPTIONS=(!strip docs !libtool !staticlibs emptydirs !zipman purge !debug !lto !autodeps)
BUILDENV=(!distcc !color !ccache !check !sign)
PKGEXT='.pkg.tar'
SRCEXT='.src.tar'
PACKAGER='tryarch <tryarch@localhost>'
MAKEFLAGS='-j1'
`;

// A fakeroot that fakes nothing. The guest kernel has no SysV IPC for
// the real one, and ownership does not survive into the share anyway;
// makepkg only checks that the key is set before it trusts -F.
export const FAKEROOT_SHIM = `#!/bin/sh
# tryarch: stands in for fakeroot. Runs the command as the root it
# already is.
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
FAKEROOTKEY=0 exec "$@"
`;

// The build tree is a tmpfs with a ceiling, so a build that outgrows
// the guest's memory fails with "no space left" rather than taking the
// guest down with it. The guest has 512 MB; this leaves room for the
// processes doing the work.
const BUILD_TMPFS_MB = 320;

// What the guest prints, and the page waits for. The failure marker is
// a prefix: the reason follows it.
export function buildMarkers(n) {
  return {
    started: `tryarch: build #${n}: `,
    done: `tryarch: build #${n} done`,
    failed: `tryarch: build #${n} failed`,
  };
}

// The driver, typed at the guest's prompt as `bash <share>/build.sh`.
export function buildScript({ n, base, version }) {
  const share = `/share/${BUILD_DIR}/${n}`;
  const { done, failed } = buildMarkers(n);
  return `#!/bin/bash
# tryarch: build ${base} ${version} (#${n}). Written by the page.
set -u
share=${share}
root=/tmp/${BUILD_DIR}
tools=$root/tools
work=$root/${n}

fail() {
  echo "${failed}: $1"
  exit 1
}
# Ctrl-C at the console is how a build is given up on; the page is
# waiting for one of the two markers either way.
trap 'fail "interrupted"' INT TERM

# bash's process substitution, which makepkg uses, needs /dev/fd; the
# initramfs never made it.
[ -e /dev/fd ] || ln -s /proc/self/fd /dev/fd
[ -e /dev/stdin ] || ln -s /proc/self/fd/0 /dev/stdin
[ -e /dev/stdout ] || ln -s /proc/self/fd/1 /dev/stdout
[ -e /dev/stderr ] || ln -s /proc/self/fd/2 /dev/stderr

mkdir -p "$root" || fail "could not make $root"
if ! grep -qs " $root " /proc/mounts; then
  mount -t tmpfs -o size=${BUILD_TMPFS_MB}m tryarch "$root" 2>/dev/null || true
fi
mkdir -p "$tools/bin" "$work/src" "$work/build" "$work/pkg" || fail "no room for the build tree"

command -v makepkg >/dev/null || fail "makepkg is not in the guest"
command -v bsdtar >/dev/null || fail "bsdtar is not in the guest"

# makepkg refuses to run as root, and root is the only user here. The
# same script, one test disabled, is what runs.
sed -E 's/^(\\s*)if \\(\\( EUID == 0 \\)\\); then$/\\1if false; then/' "$(command -v makepkg)" > "$tools/bin/makepkg" \\
  || fail "could not copy makepkg"
chmod 755 "$tools/bin/makepkg"
cp "$share/fakeroot" "$tools/bin/fakeroot" && chmod 755 "$tools/bin/fakeroot" || fail "could not copy the fakeroot shim"
cp "$share/makepkg.conf" "$tools/makepkg.conf" || fail "could not copy makepkg.conf"
cp -r "$share/recipe/." "$work/src/" || fail "could not copy the recipe"
cd "$work/src" || fail "no recipe"

echo "tryarch: build #${n}: ${base} ${version}"
# The lint pass is skipped: it forks a subshell per PKGBUILD attribute,
# several hundred of them, and a fork costs tens of milliseconds under
# the emulator. The page has already read the recipe.
MAKEPKG_LINT_PKGBUILD=0 \\
MAKEPKG_CONF="$tools/makepkg.conf" \\
BUILDDIR="$work/build" \\
PKGDEST="$work/pkg" \\
PATH="$tools/bin:$PATH" \\
  makepkg --nodeps --noconfirm --nocheck --skippgpcheck \\
  || fail "makepkg exited $?"

ls "$work/pkg"/*.pkg.tar >/dev/null 2>&1 || fail "makepkg made no package"
# Into the file the page made: an existing file is the one thing the
# share takes a write to.
bsdtar -cf "$share/out.tar" -C "$work/pkg" . || fail "could not hand the package back"
sync
rm -rf "$work"
echo "${done}"
`;
}

// The archive the guest handed back — a tar of .pkg.tar files — as
// one package per file, in the shape fetchPackage returns: { meta,
// entries, install }. Each is unpacked by the same splitEntries a
// download goes through.
export function unbundle(bytes) {
  const packages = [];
  for (const entry of parseTar(bytes)) {
    if (entry.type !== "file" || !entry.path.endsWith(".pkg.tar")) {
      continue;
    }
    const { meta, install, files } = splitEntries(parseTar(entry.data));
    if (meta === null) {
      throw new Error(`${entry.path}: no .PKGINFO in what the guest built`);
    }
    packages.push({
      filename: entry.path.replace(/^\.\//, ""),
      size: entry.data.byteLength,
      meta,
      install,
      entries: files,
    });
  }
  if (packages.length === 0) {
    throw new Error("the guest handed back no package");
  }
  return packages;
}

// A Build for a package the guest made, the record everything else —
// the selection, the closure table, the report — reads. `pkgbuild` is
// where the recipe came from, when it has a page of its own.
export function builtBuild({ meta, filename, size }, { pkgbuild = null } = {}) {
  return {
    name: meta.name,
    base: meta.base ?? meta.name,
    version: meta.version,
    repo: "built",
    filename,
    urls: [],
    size,
    isize: meta.isize ?? null,
    digest: null,
    builddate: meta.builddate ?? null,
    desc: meta.desc ?? null,
    depends: meta.depends,
    provides: meta.provides,
    pkgbuild,
  };
}
