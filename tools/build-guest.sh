#!/usr/bin/env bash
# Rebuild the guest image: the kernel the page boots and the initramfs
# it boots into, from the sources in guest/src. The committed
# guest/bzImage and guest/initramfs.cpio.gz came out of this same
# recipe run by trynix's nix derivation, with that toolchain's compiler
# and busybox; this is the recipe as a command, and its output boots the
# same but is not byte-identical to theirs.
#
#   tools/build-guest.sh [output directory]
#
# Needs docker, or podman with DOCKER=podman. Nothing is built on the
# host: guest/src goes into an Arch container read-only, the output
# directory goes in writable, and the kernel, reseed and the initramfs
# are all made in there. The first run builds the builder image and
# pulls the 135 MB kernel tarball into it, which takes a couple of
# minutes; later runs reuse the image and only verify the tarball. The
# build itself is -j$(nproc) and dominated by the kernel: a minute on
# sixteen cores, proportionally longer on a laptop.
#
# Two files come out: bzImage and initramfs.cpio.gz, in the output
# directory (guest/ by default). The rest of guest/ is not built by
# anything and stays committed — machine.json is written by hand, and
# the four BIOS blobs are copied from ktock/qemu-wasm's pc-bios at
# commit 0ef7b4e2814b231705d8371dd7997f5b72e70baf.
#
# A freshly built guest will not match engine-pins.json, and it is not
# supposed to. The pins name the image the migration snapshot was taken
# against, and a snapshot only resumes into the guest it came from, so a
# rebuild means retaking the snapshot with tools/make-snapshot.py and
# publishing it with tools/publish-engine.py, which rewrites the pins.
# Until then the site keeps booting the committed image.
#
# Reproducible as far as it can be, which is not all the way. The kernel
# tarball is pinned by sha256 and verified on every run, the build stamp
# is frozen at the epoch, every file in the initramfs is owned by root
# with mtime 1, and the archive is written in sorted order with gzip
# --no-name — so the same container produces the same bytes twice. What
# is not pinned is the toolchain: the packages Arch installs on the day
# the image is built, and the compiler version, which the kernel bakes
# into its own CONFIG_CC_VERSION_TEXT. Pinning the base image by digest
# (archlinux@sha256:...) rather than by tag would be stricter again.
set -euo pipefail

if [ $# -gt 1 ]; then
  echo "usage: $0 [output directory]" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${TRYARCH_GUEST_SRC:-$HERE/../guest/src}
OUT=${1:-$HERE/../guest}
DOCKER=${DOCKER:-docker}

# The kernel, by version, URL and hash. The hash was taken from the
# tarball this script first downloaded; it is checked inside the
# container on every run, so a mirror that serves something else, or a
# tarball that rots in the builder image, stops the build rather than
# quietly changing the guest.
KERNEL_VERSION=6.1.187
KERNEL_URL=https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz
KERNEL_SHA256=1b6e798aeaa708ca670a426ad5a6c86dc2237b8e59e8822876976c383873642b

# The stamp the kernel prints and embeds. It says trynix because the
# guest image and its markers still do: this is trynix's kernel, and the
# banner init prints is trynix's too.
KBUILD_BUILD_TIMESTAMP="Thu Jan  1 00:00:00 UTC 1970"
KBUILD_BUILD_USER=trynix
KBUILD_BUILD_HOST=trynix

# The image is tagged with the kernel version because it carries that
# tarball: bumping KERNEL_VERSION asks for an image that does not exist
# yet and gets built, rather than reusing one holding the old source.
IMAGE=tryarch-buildguest:$KERNEL_VERSION
JOBS=$(nproc)

for f in init reseed.c linux_x86_config kernel-fragment.config; do
  if [ ! -f "$SRC/$f" ]; then
    echo "$0: $SRC/$f is missing" >&2
    exit 1
  fi
done
mkdir -p "$OUT"
SRC=$(cd "$SRC" && pwd)
OUT=$(cd "$OUT" && pwd)

# The builder. archlinux:base-devel already has gcc, make, bison, flex,
# perl and the rest of the kernel's build-time crowd; the extras are bc
# and elfutils (objtool, which CONFIG_UNWINDER_ORC needs), cpio and
# gzip for the archive, busybox for the initramfs, and musl for reseed.
#
# busybox comes from Arch's package rather than being built here: one
# static, stripped binary with the full upstream applet set. init needs
# sh, mount, ln, cat and setsid, but the shell a visitor lands in should
# have the rest, and Debian's busybox-static — the obvious alternative —
# ships a trimmed set. An Arch busybox for a site that boots Arch
# packages is the right default anyway.
if ! "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building the builder image $IMAGE"
  "$DOCKER" build -t "$IMAGE" \
    --build-arg "KERNEL_URL=$KERNEL_URL" \
    --build-arg "KERNEL_SHA256=$KERNEL_SHA256" - <<'DOCKERFILE'
FROM archlinux:base-devel
ARG KERNEL_URL
ARG KERNEL_SHA256
RUN pacman -Syu --noconfirm --needed \
      bc cpio gzip xz tar curl elfutils openssl perl python busybox musl \
 && pacman -Scc --noconfirm
RUN curl -fsSL -o /kernel.tar.xz "$KERNEL_URL" \
 && echo "$KERNEL_SHA256  /kernel.tar.xz" | sha256sum -c -
DOCKERFILE
fi

# reseed is a 40-line static binary that runs once at boot, so it is
# built against musl: glibc's static libc would put the better part of a
# megabyte of unreachable code into an 800 KB initramfs every visitor
# downloads. Set CC to use something else.
CC=${CC:-musl-gcc}

echo "building linux $KERNEL_VERSION and the initramfs in $IMAGE (-j$JOBS)"
"$DOCKER" run --rm -i \
  -v "$SRC:/src:ro" \
  -v "$OUT:/out" \
  -e "KERNEL_VERSION=$KERNEL_VERSION" \
  -e "KERNEL_SHA256=$KERNEL_SHA256" \
  -e "KBUILD_BUILD_TIMESTAMP=$KBUILD_BUILD_TIMESTAMP" \
  -e "KBUILD_BUILD_USER=$KBUILD_BUILD_USER" \
  -e "KBUILD_BUILD_HOST=$KBUILD_BUILD_HOST" \
  -e "JOBS=$JOBS" \
  -e "CC=$CC" \
  "$IMAGE" bash -s <<'BUILD'
set -euo pipefail
export KBUILD_BUILD_TIMESTAMP KBUILD_BUILD_USER KBUILD_BUILD_HOST

echo "verifying linux-$KERNEL_VERSION.tar.xz"
echo "$KERNEL_SHA256  /kernel.tar.xz" | sha256sum -c -

mkdir -p /work
cd /work
tar -xf /kernel.tar.xz
cd "linux-$KERNEL_VERSION"

# The config is the vendored qemu-wasm one with this repository's
# fragment appended; olddefconfig answers everything the fragment's
# subtractions opened up and everything 6.1 added since the vendored
# config was written.
cat /src/linux_x86_config /src/kernel-fragment.config > .config
make olddefconfig
make -j"$JOBS" bzImage

install -m 644 arch/x86/boot/bzImage /out/bzImage

# reseed, the only program in the image that is not busybox.
# -idirafter is for musl: its gcc wrapper drops /usr/include from the
# search path so that no glibc header can sneak in, and that takes the
# kernel's uapi headers with it — including linux/random.h, where the
# RNDRESEEDCRNG this program exists to call is defined. Added after
# musl's own headers rather than before, so nothing else changes; gcc
# has /usr/include on the path already and ignores the flag.
cd /work
"$CC" -O2 -static -idirafter /usr/include -o /work/reseed /src/reseed.c

# The initramfs, which is the guest's whole filesystem. bin holds
# busybox and its applets, the empty directories are the mount points
# init fills in (proc, sys, dev), the one it mounts the store on
# (share), and tmp and etc for whatever a visitor does next.
ROOT=/work/initramfs
rm -rf "$ROOT"
mkdir -p "$ROOT"/bin "$ROOT"/proc "$ROOT"/sys "$ROOT"/dev "$ROOT"/share "$ROOT"/tmp "$ROOT"/etc

install -m 755 /usr/bin/busybox "$ROOT/bin/busybox"
# `busybox --install -s` finds itself through /proc/self/exe, so it
# would write the container's absolute path into all four hundred
# links. Make them by hand instead: one relative link per applet beside
# the binary, which is where the previous build put them too. busybox
# dispatches on argv[0], so the name is the whole mechanism.
for applet in $("$ROOT/bin/busybox" --list); do
  if [ "$applet" != busybox ]; then
    ln -s busybox "$ROOT/bin/$applet"
  fi
done

# reseed goes in bin rather than at the root: init runs it by bare name
# with PATH=/bin, and a reseed that is not found is a warning on the
# console and every visitor sharing one frozen random pool.
install -m 755 /work/reseed "$ROOT/bin/reseed"
install -m 755 /src/init "$ROOT/init"

# Everything at mtime 1 and owned by root, listed in one C-collated
# order, and gzipped without the name or timestamp gzip would otherwise
# put in its header: the archive is a function of its contents and
# nothing else.
find "$ROOT" -mindepth 1 -exec touch -h -d @1 {} +
cd "$ROOT"
find . -mindepth 1 -print0 \
  | LC_ALL=C sort -z \
  | cpio --null --create --format=newc --quiet --reproducible --owner=+0:+0 \
  | gzip -9 --no-name > /out/initramfs.cpio.gz
chmod 644 /out/initramfs.cpio.gz

# Hand the outputs back to whoever owns the mounted directory. Under a
# rootful docker that is the invoking user; under a rootless one the
# directory already shows up as root-owned inside the container and this
# is a no-op, which is the answer in both cases.
chown "$(stat -c '%u:%g' /out)" /out/bzImage /out/initramfs.cpio.gz
BUILD

# The SRI hash is what engine-pins.json records: "sha256-" and the
# base64 of the digest, the same shape tools/publish-engine.py writes.
sri() {
  python3 - "$1" <<'PY'
import base64, hashlib, sys

digest = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        digest.update(chunk)
print("sha256-" + base64.b64encode(digest.digest()).decode())
PY
}

echo
for f in bzImage initramfs.cpio.gz; do
  printf '%s/%s  %s bytes  %s\n' "$OUT" "$f" "$(stat -c %s "$OUT/$f")" "$(sri "$OUT/$f")"
done
echo
echo "engine-pins.json still names the guest the current snapshot was taken"
echo "against, so these hashes will not match it until the snapshot is retaken"
echo "(tools/make-snapshot.py) and published (tools/publish-engine.py)."
