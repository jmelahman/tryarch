# Building the qemu engine

The browser runs [qemu-wasm] — QEMU compiled to WebAssembly with
emscripten. Three artifacts make up the engine:

```
out.js                        the ES6 module the page imports
qemu-system-x86_64.wasm       ~13 MB, stripped of its DWARF
qemu-system-x86_64.worker.js  the pthread bootstrap
```

A fourth file rides along in the same release:

```
vm.state                      the migration snapshot, 32 MB
                              (7.4 MB gzipped on the wire)
```

None of them are in this repository and none are built by CI. The
engine needs a pinned emscripten SDK and takes tens of minutes; the
snapshot needs a _native_ build of the same fork. They change only when
the qemu-wasm pin, the patches, or the guest image move, so they are
built by hand with the tools below and published as a release, which
`tools/build-site.py` fetches by hash into `qemu/` — the release, the
file names and their hashes are in `engine-pins.json` at the repository
root.

The guest image is not in the release. It is committed under `guest/`,
and its hashes ride in the same pins; see "Why the guest image is
committed" below.

`tools/build-engine.sh`, `tools/build-native-qemu.sh` and
`tools/build-guest.sh` are the three that need docker (`DOCKER=podman`
for podman). The first two also need a checkout of [qemu-wasm] at the
pinned commit (`0ef7b4e2`, a fork of QEMU 8.2.0). Everything else here
is python3 from the standard library.

## The engine

```console
$ tools/build-engine.sh ~/src/qemu-wasm ./engine
```

This is the fork's own recipe, with three deviations that
`tools/build-engine.sh` carries so nobody has to remember them: the
tree is copied somewhere writable first (meson runs `git init` for the
`dtc` subproject and fails on the read-only mount the fork's README
suggests), zlib is fetched from the GitHub release mirror (zlib.net
answers curl with a bot-wall page), and `patches/` are applied.

The patches matter more than the build flags:

- `0001-9pfs-translate-emscripten-errnos-to-linux.patch` makes 9p
  report Linux errno numbers instead of emscripten's WASI ones.
  Without it no package can find a library by search (docs/design.md).
- `0002-9p-local-resolve-a-path-in-one-syscall-under-emscripten.patch`
  opens and stats a path in one syscall instead of one per component.
  Under emscripten each syscall is a round trip to the browser's main
  thread, and the share is a private in-memory directory with nothing
  for the component walk to protect.
- `0003-count-the-clock-the-resumer-will-count.patch` makes the native
  build count the monotonic clock the wasm build counts, instead of a
  real `rdtsc`. It applies to the snapshotting binary rather than the
  engine: the guest calibrates its TSC while booting there and runs
  here, so without it every sleep and timeout in the guest ran long by
  the ratio between the two clocks — 3.3x on the machine that took the
  snapshot (docs/performance.md).

Two more patches are not the engine's, but live in `patches/` beside
them and are applied by other tools:

- `patches/xterm-pty/0001-honour-the-poll-timeout.patch` records the
  timeout the caller of `poll(2)` actually asked for — emscripten's own
  poll passes every stream a hardcoded -1, so the tty would sleep until
  a keystroke arrived and ignore the caller's timers — and caps how long
  the tty will sleep at all. `build-engine.sh` applies it, because
  xterm-pty's js-library is linked into the engine.
- `patches/xzwasm/0001-copy-each-decoded-chunk-out-of-the-decoder-memory.patch`
  enqueues a copy of each decoded chunk instead of a view into the
  decoder's buffer, which the next chunk overwrites. `tools/vendor.py`
  applies it to the vendored `xzwasm.js`.

Otherwise the emscripten flags are upstream's verbatim (`-sASYNCIFY`,
`-pthread -sPROXY_TO_PTHREAD`, `-sTOTAL_MEMORY=2300MB`, the xterm-pty
`--js-library`, `-sEXPORT_ES6`), and the configure line keeps
`--enable-virtfs`, which is what makes the 9p share possible.

## The native QEMU

```console
$ tools/build-native-qemu.sh ~/src/qemu-wasm ./native
```

The browser resumes a VM rather than booting one, and the snapshot has
to come from a native build of the same fork: both ends of a migration
must agree on QEMU version, machine type, devices and — since
`patches/0003` — the clock, which rules out any distribution's own
QEMU. The binary is static, so it runs on any x86_64 Linux.

## The snapshot

```console
$ python3 tools/make-snapshot.py --qemu ./native/qemu-system-x86_64 \
    --guest guest --out ./engine/vm.state
```

The tool boots the guest natively, waits for init to park on its
handshake, and migrates the running VM to a file. QEMU's arguments
come from the guest image's `machine.json`, which the page starts QEMU
from as well; that file is the one description of the machine.

`--guest` is the committed `guest/` unless the image itself changed, in
which case rebuild it first:

```console
$ tools/build-guest.sh guest
```

That rebuilds `bzImage` and `initramfs.cpio.gz` from `guest/src` in a
container and prints their SRI hashes. The first run builds a builder
image with the kernel tarball inside it (about 1.6 GB in docker's
cache); later runs reuse it and take about a minute of kernel build.
The output is deterministic for a given toolchain, but not
byte-identical to the committed image, which trynix's nix build
produced with a different compiler and busybox. A rebuilt guest does
not match `engine-pins.json` until a snapshot has been retaken against
it and published, and `tools/build-site.py` refuses to assemble a site
until it does — the snapshot holds the kernel and initramfs in its RAM
image, so a mismatched pair hangs on resume rather than failing loudly.
So retake the snapshot whenever the guest image changes: a new kernel, a
new initramfs, or a new machine definition.

## Publishing

```console
$ python3 tools/publish-engine.py --dir ./engine --guest guest
```

The directory holds the three engine files and `vm.state`. The tool
creates a release tagged `engine-<UTC date>-<UTC time>`, uploads the
four files, and rewrites `engine-pins.json` with the base URL, the tag,
the hash of each file, and the hashes of the guest image it was told the
snapshot was taken against. Commit the pins with the change that needed
them.

The pins currently name a release of [trynix], the project this is a
fork of, because tryarch changed the package universe and not the
machine: the engine and the snapshot are still its bytes, and there was
nothing to rebuild. The first publish from here rewrites the pins' base
URL along with the tag, so the release this repository uploads is the
one it fetches from afterwards.

A tag is never reused. The pins of every commit in the history resolve
against the release they name, so replacing an asset in place would
break the site build on all of them; a fresh tag per publish costs some
release storage and nothing else.

## Serving locally

```console
$ python3 tools/build-site.py _site --qemu-dir ./engine
$ python3 tools/serve.py --site _site --qemu ./engine
```

`build-site.py --qemu-dir` takes the engine and the `vm.state` beside it
from a directory instead of the pinned release, and skips the guest
check, since a locally built engine is exactly the case where the pins
do not apply yet. `serve.py --qemu` does the same to an already-built
tree, overlaying `qemu/` and recomputing `assets.json`, so a rebuild can
be tried without reassembling the site. `--index DIR` layers a package
index over `index/`; without one the server warns and serves anyway.

## Hosting and cross-origin isolation

The page is cross-origin isolated (COOP/COEP), which SharedArrayBuffer
needs. GitHub Pages cannot set response headers, so the site loads
`coi-serviceworker.js`, a shim that registers a service worker and
reloads the page so that worker can inject the two headers.

`site/_headers` sets the headers directly on a host that reads such a
file (Cloudflare Pages, Netlify). It is inert on GitHub Pages, and the
shim registers nothing once the page is already cross-origin isolated,
so the tag stays in `index.html` as the fallback for both.

What the move is worth, measured on localhost with the 13 MB engine
booting jq, page load to the guest prompt:

    coi shim        3.42 s cold    2.25 s warm
    real headers    2.95 s cold    2.28 s warm

So the shim costs about half a second on a first-ever visit, which is
the extra reload, and nothing afterwards. Compiling the engine is 56 ms
either way, so the browser's compiled-WebAssembly cache is not a reason
to move: an earlier note held that a service worker defeats that cache,
and these numbers do not support it. Move the site to Cloudflare Pages
(build with `tools/build-site.py`, publish the output directory with the
index beside it) for control over headers and caching, not for speed.

## What the next engine build should fix

Building a package in the guest (docs/design.md, "Building a recipe in
the guest") found three more places the 9p server and emscripten's
filesystem disagree. tryarch works around all three by never writing to
the share from the guest except into a file the page created, but each
is a small patch to the engine, and the workarounds could go once they
land:

- **ENOTSUP is not translated.** `patches/0001-9pfs-translate-emscripten-errnos-to-linux.patch`
  maps the errnos the server returns to Linux numbers, and emscripten's
  ENOTSUP (138) is not in the table, so the guest sees "Unknown error
  138" where it should see EOPNOTSUPP (95). One more row.
- **`fchmodat_nofollow` goes through `/proc/self/fd`.** QEMU's Linux
  implementation chmods a freshly created file as
  `chmod("/proc/self/fd/N")`, and emscripten's filesystem has no
  `/proc`, so every create, mkdir and chmod from the guest fails with
  EPERM. Under emscripten the call can be a plain `fchmod(fd)`: there
  are no symlinks to refuse to follow in a filesystem the page wrote.
- **`symlinkat` throws on the main thread.** The JS glue emitted for
  `__syscall_symlinkat` in the built engine calls a string helper it
  never imported, so the first symlink a guest makes on the share throws
  a TypeError outside any handler and the VM stops for good. It is an
  emscripten library-linking slip rather than a QEMU bug; the fix is in
  the build's JS library, and a guest must never make a symlink on the
  share until it is in.

## Why the guest image is committed

The engine and the snapshot are release assets, fetched by hash. The
guest image is not: `bzImage`, `initramfs.cpio.gz`, `machine.json` and
the four BIOS blobs are 3.8 MB in the tree.

Three reasons. It changes rarely — a kernel config or an init edit, not
a push. It has to stay byte-identical to whatever the snapshot was taken
against, and a file in the tree with its hash in the pins is the
shortest path between those two facts. And building it needs a
container, which puts it out of reach of CI and of anyone who only wants
to change the page; `tools/build-guest.sh` makes the rebuild
reproducible enough for the person who does need it, which is the
person who is about to retake the snapshot anyway.

The BIOS blobs are not built at all. They are copied from the fork's
`pc-bios` at the pinned commit, because QEMU's own firmware is not
something this project has any reason to differ on.

[qemu-wasm]: https://github.com/ktock/qemu-wasm
[trynix]: https://github.com/fzakaria/trynix
