# tryarch

Boot any Arch package ever shipped, in a browser:
https://jamison.lahman.dev/tryarch/

Pick packages from core and extra, or an older version out of the Arch
Linux Archive, and they are downloaded from an Arch mirror into an
x86_64 Linux virtual machine running in the tab. A link can also name a
recipe from the AUR, or any PKGBUILD by URL, for makepkg to build inside
that machine. You get a shell with the package on PATH. Nothing runs on
a server —
there is no server, only a static site and the mirrors.

```
https://jamison.lahman.dev/tryarch/?pkg=jq&boot=1
https://jamison.lahman.dev/tryarch/?pkg=jq@1.7.1-2&boot=1
https://jamison.lahman.dev/tryarch/?pkg=git,python,ripgrep&boot=1
https://jamison.lahman.dev/tryarch/?repo=examples/repo/hello-tryarch.db&pkg=hello-tryarch&boot=1
https://jamison.lahman.dev/tryarch/?pkgbuild=https://raw.githubusercontent.com/jmelahman/tryarch/main/examples/hello-tryarch/PKGBUILD&boot=1
```

The URL is the whole state, so an environment is a link to send: `pkg`
repeats and takes `name` or `name@version`, `repo` adds a pacman
repository of your own by its database URL, `aur` names an AUR package
and `pkgbuild` a recipe by URL — both built by makepkg in the guest once
it is at its prompt — and `boot=1` starts without a click. The last two
links run the same package, which is in no Arch repository at all: the
fourth boots it out of a three-file repository committed to this site
under [site/examples/repo](site/examples/repo), built by
`tools/make-example-repo.sh` from
[examples/hello-tryarch](examples/hello-tryarch/PKGBUILD); the fifth
builds it from that PKGBUILD inside the machine.

## How the pieces fit

**At deploy time** `tools/build-index.py` downloads `core.db` and
`extra.db` from a mirror and writes a static index into `index/`: one
`names.json` of every name with its description truncated to 120
characters, 256 package shards each holding the current version,
filename, size, sha256, dependencies and `pkgbase` of the packages that
hash into it, and a second set of shards, `provides/<xx>.json`, mapping
a provided name — `sh`, `libz.so` — to the packages that provide it.
Only shards with something in them are written. The AUR gets the same
three files under `index/aur/`, out of the metadata dump
aur.archlinux.org publishes — all ~119k of its packages — which has to
be copied at deploy time because the AUR sends no CORS headers: what the
dump held when the site was built is everything the page can know about
it. The GitHub Pages workflow rebuilds the index every six hours,
because mirrors delete superseded package files within hours of a sync.

**At runtime** the page reads that index, resolves what was asked for,
and fetches the package files themselves from the Arch mirrors that
allow cross-origin reads — five of the 396 in the official list, tried
in order. Older versions come from the Internet Archive's copy of the
Arch Linux Archive, one item per package name, which is the only
historical source a browser can read at all. Each `.pkg.tar.zst` is
unpacked in the tab into the filesystem the VM mounts over 9p, and the
guest, resumed from a snapshot rather than booted, sees an Arch root.

**Every version links to its PKGBUILD** on gitlab.archlinux.org, built
from the `pkgbase` and the version: that is the recipe for exactly the
bytes you are about to run.

**A recipe is built in the guest.** An AUR package is read from GitHub's
mirror of the AUR (`.SRCINFO` and `PKGBUILD`, which aur.archlinux.org
itself will not serve to a page), and a PKGBUILD by URL is parsed in the
tab. The page gathers the sources itself, since the guest has no
network: a file on a host that allows cross-origin reads is fetched and
its checksum verified, and one that is not — most release hosts — gets a
row with a link, for you to drop the file on the page. Everything
makepkg needs is fetched with the packages: its own closure, about 118
MB, or with gcc, make, binutils and pkgconf when the recipe has a
`build()` step, about 190 MB. Once the guest is at its prompt makepkg
runs there, in RAM, and the package it makes is unpacked into the share
like any download. It takes about half a minute for a package with
nothing to compile, and the console shows the build as it goes. The
Build lane is hidden from the page for now — too little of the AUR
builds this way to lead with it, see the last of the limits below — and
a link with `aur` or `pkgbuild` is what shows it.

Everything large — the engine, the guest image, the snapshot, every
package file — is kept in the browser's cache, so booting the same
selection twice costs no download.
[docs/design.md](docs/design.md) is the long version.

## Layout

- `site/` — the static site, vanilla ES modules.
- `guest/` — the guest image, committed prebuilt: a trimmed Linux
  kernel, a busybox initramfs, the BIOS blobs and `machine.json`, the
  one description of the virtual machine, read by the page and by the
  snapshot tool.
- `guest/src/` — what that image is built from (init, the kernel config,
  `reseed.c`), rebuilt in a container by `tools/build-guest.sh`.
- `engine-pins.json` — the release the qemu-wasm engine and the
  migration snapshot are fetched from, by hash, plus the hashes of the
  guest image the snapshot was taken against.
- `patches/` — the changes to qemu-wasm the engine is built with, and
  the two to vendored browser libraries.
- `tools/` — plain python3 and bash: the index builder, the site
  assembly, the local server, and the engine tools.
- `examples/` — the PKGBUILD behind the example repository.
- `package.json` — the browser libraries, pinned to exact versions;
  `tools/vendor.py` copies the handful of files the page loads out of
  `node_modules`.
- `tests/` — the test suites, offline.
- `docs/` — [design.md](docs/design.md) for the architecture and what
  was measured, [engine.md](docs/engine.md) for building and publishing
  the engine and the snapshot, [performance.md](docs/performance.md) for
  where a first run's time goes and which optimisations were dead ends.

## Running

```console
$ npm ci                                    # prettier and the browser libraries
$ python3 tools/build-site.py _site         # assemble the deployable tree
$ python3 tools/build-index.py _site/index  # the package index (needs the network)
$ python3 tools/serve.py --site _site       # serve it on :8137
```

`build-site.py` copies `site/`, vendors the browser libraries out of
`node_modules`, downloads the engine and the snapshot by hash into
`qemu/`, and copies the committed `guest/` in — checking it against
`engine-pins.json` on the way, because a guest image the snapshot was
not taken against hangs on resume.

The index is the slow part and it is optional: `serve.py` warns and
serves without one, which is enough for everything but picking a
package. `--index DIR` overlays an index built earlier, so it can be
reused across runs, and `--qemu DIR` overlays a locally built engine and
snapshot over `qemu/` for trying one before publishing it.

The rest:

```console
$ npm test                                  # the site suite
$ python3 -m unittest discover -s tests/tools
$ npm run fmt                               # before committing
$ python3 tools/boot-test.py --site _site   # open the site, wait for a shell
```

The site is deployed by GitHub Actions from `tools/build-site.py` plus
the index, on every push that touches the site, the tools, the guest or
the pins, and every six hours.

## What this is not

- **Not a package manager.** Packages are unpacked, not installed:
  `.INSTALL` scriptlets never run, there is no pacman database in the
  guest, and nothing is checked for conflicts.
- **Not signature-checked.** Integrity is the SHA-256 the repo database
  carries for each file (SHA-1 for archived ones), over HTTPS from
  mirrors nobody here operates. The PGP signatures pacman verifies are
  not checked, because the trust chain a browser would need is not
  there.
- **Not the whole history.** The Internet Archive's copy of the Arch
  Linux Archive stops around October 2024; archive.archlinux.org itself
  sends no CORS header, so a page cannot read it. Versions superseded
  after that date are simply unreachable.
- **Not every repository.** core and extra, `x86_64` and `any` only. No
  multilib, no testing.
- **Not a build farm.** The AUR ships recipes, not binaries, and the
  recipes are built here at emulator speed with makepkg alone, or
  makepkg and gcc: no base-devel, no VCS sources, no test suite, no
  network while it builds (so nothing that runs `go mod download`,
  cargo, npm or pip), no toolchain the guest cannot hold, and sources
  only from a host that allows cross-origin reads or from your own
  disk. That rules out most of the AUR, which is why the lane is hidden
  for now. A `-bin` or `any` package builds in under a minute; a C
  program takes many. The lint pass makepkg runs over a PKGBUILD is
  skipped, because its several hundred subshells cost minutes under the
  emulator and the page has already read the recipe.
- **Not durable.** The list of mirrors that allow cross-origin reads was
  scanned by hand. A download that fails on one of them for any reason —
  a 404, a dropped CORS header, a network error — falls through to the
  next mirror, and then to archive.org for a build the archive has; a
  build is gone only when every source 404s.

## Credits

- [trynix] by Farid Zakaria, which this is a fork of: the page, the
  guest image, the resume-from-snapshot trick and most of the ideas are
  his. The qemu-wasm engine and the migration snapshot tryarch serves
  are still the bytes trynix published, pinned by hash from its releases
  (docs/engine.md) — the package universe changed, the virtual machine
  did not.
- [qemu-wasm] by ktock: QEMU on emscripten, the wasm TCG JIT, and the
  virtio-9p port that makes the share-into-guest path possible.
- [ghostty-web]: libghostty-vt compiled to wasm, the terminal.
- Arch Linux, its mirror operators, and the Internet Archive, which
  between them serve every byte this site boots.

## License

MIT, please see [LICENSE](LICENSE).

[trynix]: https://github.com/fzakaria/trynix
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
