#!/usr/bin/env bash
# Build examples/hello-tryarch and publish it into the site as a pacman
# repository.
#
# GitHub Pages sends `access-control-allow-origin: *` on every file, so
# a directory holding a repo database and the package files it names is
# a repository any browser may read — and tryarch reads it like it
# reads a mirror. That is what the extra-repository example on the site
# boots: a package that is in no Arch repository, served from a static
# directory beside the page.
#
#   ./tools/make-example-repo.sh             # run in place
#   tools/make-example-repo.sh "$PWD"        # or name the checkout
#
# The built files are committed, all three kilobytes of them: the pages
# workflow has no makepkg, and a repository whose database and package
# disagree is worse than a stale one.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# The checkout to write into: the first argument, else the working
# directory when that is one, else the tree this script lives in. The
# middle case is for a copy of the script run from somewhere else.
if [ $# -ge 1 ]; then
  ROOT=$1
elif [ -f "$PWD/examples/hello-tryarch/PKGBUILD" ]; then
  ROOT=$PWD
else
  ROOT=$(cd "$HERE/.." && pwd)
fi

SRC=$ROOT/examples/hello-tryarch
DEST=$ROOT/site/examples/repo
NAME=hello-tryarch
DB=$DEST/$NAME.db.tar.gz

if [ ! -f "$SRC/PKGBUILD" ]; then
  echo "no PKGBUILD under $SRC — pass the repository root as the first argument" >&2
  exit 2
fi

# makepkg litters the PKGBUILD's own directory with src/ and pkg/, so
# it gets a copy and the checkout stays clean.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$SRC/PKGBUILD" "$WORK/PKGBUILD"

# A makepkg.conf of this script's own, so the package does not come out
# shaped by whatever the builder happens to have in /etc/makepkg.conf.
# The extension decides which decoder the page reaches for, and the
# packager should not be a stranger's name.
#
# CARCH and CHOST are only here because makepkg validates them before it
# notices arch=any. The .BUILDINFO makepkg writes unconditionally
# carries the builder's own package list, as it does in every official
# Arch package; it is most of the 12 KB, and the page drops it.
cat > "$WORK/makepkg.conf" <<'EOF'
CARCH="x86_64"
CHOST="x86_64-pc-linux-gnu"
PKGEXT='.pkg.tar.zst'
SRCEXT='.src.tar.gz'
COMPRESSZST=(zstd -c -T0 -19 -)
PACKAGER='tryarch <lahmanja@gmail.com>'
EOF

mkdir -p "$DEST"
cd "$WORK"
export PKGDEST=$DEST

# --nodeps because nothing is built here and the builder need not have
# `sh` installed as an Arch package; --skipinteg because there are no
# sources to check.
makepkg --config "$WORK/makepkg.conf" --nodeps --skipinteg --noconfirm --force
PKGFILE=$(makepkg --config "$WORK/makepkg.conf" --packagelist)

# --remove deletes the package file an entry replaced, so a version bump
# does not leave the old one behind in the site.
repo-add --remove "$DB" "$PKGFILE"

# repo-add also writes a .files database (the file lists pacman -F
# uses, which nothing here reads) and keeps .old backups of both.
rm -f "$DEST/$NAME".files* "$DEST"/*.old

# repo-add points `$NAME.db` at the tarball with a symlink. Serve a real
# file instead: the page fetches that name over HTTP, and a symlink
# survives neither the `cp -rL` the pages workflow makes of the built
# site nor a checkout on a filesystem without them.
rm -f "$DEST/$NAME.db"
cp "$DB" "$DEST/$NAME.db"

echo
echo "wrote $DEST:"
ls -l "$DEST"
