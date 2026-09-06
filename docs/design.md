# Design

tryarch boots Arch Linux packages inside a qemu-wasm virtual machine,
entirely client-side. A static site — no server anywhere — that resolves
a package name against an index built at deploy time, downloads the
`.pkg.tar.zst` from an Arch mirror, unpacks it in the tab, and drops the
reader into a shell with the program on PATH.

It is a fork of [trynix], which does the same thing for nixpkgs
closures out of cache.nixos.org. The virtual machine is unchanged and so
is most of the page; what changed is the package universe underneath,
and the constraint that comes with it: Arch's infrastructure was not
built for browsers, and almost none of it will talk to one.

## Where the bytes come from

Everything happens in the reader's tab, so every byte has to come from a
host that sends `Access-Control-Allow-Origin`. That single requirement
decides the whole data layer.

**The official mirror list has 396 https mirrors. Five of them allow
cross-origin reads**, on the repo databases and the package files alike,
Range requests included. They are tried in this order:

```
https://mirror.lcarilla.de/archlinux/
https://archlinux.mailtunnel.eu/
https://repo.c48.uk/arch/
https://mirror.iusearchbtw.nl/
https://yonderly.org/mirrors/archlinux/
```

A package is `${mirror}${repo}/os/x86_64/${filename}` and a repository
database is `${mirror}${repo}/os/x86_64/${repo}.db` — a gzipped tar of
`<name>-<version>/desc` sections. `any`-arch packages live in the
`x86_64` directory like everything else. Each mirror measured about
4 MB/s.

**History comes from the Internet Archive**, which mirrors the Arch
Linux Archive as one item per package name, `archlinux_pkg_<name>`. The
metadata endpoint `https://archive.org/metadata/archlinux_pkg_<name>`
sends `Access-Control-Allow-Origin: *` and returns every archived file
with its size, mtime and checksums; an item that does not exist returns
`{}`. The bytes come from `https://archive.org/cors/<item>/<file>` at
about 10 MB/s. Two things about that URL are load-bearing:

- The filename must be percent-encoded with `encodeURIComponent`. A raw
  `+` — and plenty of Arch versions have one — is read as a space there,
  and the request 302s into a 404 page.
- `https://archive.org/download/...` sends no CORS header at all. It is
  the URL every human uses and the one URL this page can never use.

**archive.archlinux.org, the real archive, sends no CORS header**, so
the page cannot read it. That is not a detail: the Internet Archive's
copy stops around **October 2024** (its newest item was added
2024-10-10; the newest jq it holds is 1.7.1-2, the newest glibc is
2.40+r16). Versions that were current after that date and have since
been superseded exist in no source a browser can reach. The site says so
on its About page (`site/about.html`), and the front page carries the
date and a link to it, because a reader who asks for last month's
version of something deserves an explanation rather than an empty list.

Two more sources were checked and are not used: gitlab.archlinux.org's
API v4 does allow cross-origin reads, which is worth knowing but nothing
at runtime needs it, and archlinux.org has no CORS JSON API at all.

**Integrity** is whatever the source publishes. A package named by a
repository database is checked against the `%SHA256SUM%` from that
database; an archived package is checked against the SHA-1 the Internet
Archive records for the file. Both are verified with `crypto.subtle`
before anything is unpacked. What is _not_ checked is the PGP signature
pacman verifies, because a browser has no keyring and no path to one:
the guarantee here is "these are the bytes that mirror and that database
agree on", not "these were signed by an Arch developer".

## The PKGBUILD link

Every version on the page links to the recipe that built it:

```
https://gitlab.archlinux.org/archlinux/packaging/packages/<project>/-/blob/<tag>/PKGBUILD
project = pkgbase with every "+" replaced by "plus"
tag     = the full version with ":" replaced by "-"
```

So `libsigc++` is the project `libsigcplusplus`, and version `1:26.2.2-1`
is the tag `1-26.2.2-1` while `1.8.2-1` is itself. The name that matters
is `pkgbase` (`%BASE%` in a database, `pkgbase` in a `.PKGINFO`), not
`pkgname`: a split package's parts share one recipe.

## The index

A repository database is a few megabytes of gzipped tar, and the page
needs one lookup out of it. So it is turned inside out at deploy time by
`tools/build-index.py`, which downloads `core.db` and `extra.db`, parses
every `desc` section, and writes a static tree the page can fetch pieces
of:

```
index/names.json         every name and a truncated description
index/pkgs/<xx>.json     the current build of each package
index/provides/<xx>.json which packages provide a virtual name
index/aur/...            the same three files, for the AUR
```

A shard `xx` is two hex digits of `FNV-1a(name) & 0xff` — 256 shards,
computed identically in Python and JavaScript (`Math.imul` for the
32-bit multiply), so the site and the indexer always agree on where a
package lives. An entry carries the version, repo, filename, compressed
and installed size, SHA-256, build date, dependencies, provides,
`pkgbase`, description and upstream URL: everything needed to fetch and
resolve a package without opening the package. Output is deterministic —
sorted keys, no whitespace — so an unchanged repository produces an
unchanged file.

The AUR tree is built the same way from a different source: the metadata
dump aur.archlinux.org publishes, ~119k packages in one gzipped JSON
array, resharded with what a source build needs — make and check
dependencies, popularity, votes, out-of-date — in place of what only a
binary repo has. It has to be copied at deploy time because the AUR
sends no CORS headers, so the page cannot query it at runtime at all:
what the dump held when the site was built is everything the page knows
about the AUR.

The index is never committed. It is a snapshot of what the mirrors hold
right now, and mirrors delete superseded files within hours of a sync,
so the pages workflow rebuilds it on every push and every six hours.

**Even six hours is not always fresh enough.** When a build named by the
index 404s on every mirror, the page fetches that repository's `.db`
itself, registers the entries as an override, and re-resolves that
package before giving up. It costs a few megabytes and only happens in
the window between a sync and the next index build.

## The pipeline

1. **Resolve.** A name, a `name@version`, a range like `jq@>=1.7`, or a
   database URL of your own, to one concrete build: a package file, its
   mirrors, its digest and its dependencies.
2. **Walk.** Breadth-first over dependencies, at most four packages in
   flight. A dependency string is parsed the way pacman parses it
   (`glibc`, `linux-api-headers>=4.10`, `libz.so=1-64`, plain `sh`), and
   satisfied by an already-selected package, by a package of that name,
   or by whatever provides it. Optional and build dependencies are
   ignored — this is a runtime, not a build.
3. **Fetch and unpack, streaming.** Each package is downloaded from the
   first source that serves it, verified, decompressed (zstd today, xz
   for most of the archive's history, gzip for the oldest), parsed as a
   tar, and written into emscripten's in-memory filesystem the moment it
   lands, while the rest are still downloading and the engine is still
   compiling. A source that fails for any reason — a 404, a dropped CORS
   header, a network error — is left for the next: the mirrors in order,
   then archive.org for a build the archive has. Only when every source
   answers 404 is the build gone; any other last failure is reported as
   itself. Compressed files are kept in the browser's Cache API under
   `tryarch-v1`; a package file at a given version is immutable, so a
   cached one can never be stale.
4. **Resume.** qemu-wasm with a prebuilt guest kernel and initramfs,
   resumed from a migration snapshot rather than booted (below). The
   share enters the guest over virtio-9p; init mounts it, sources the
   manifest the page wrote, and execs a shell on the serial console.
5. **Terminal.** [ghostty-web] — libghostty-vt, the parser the native
   app uses, compiled to wasm. The pty is xterm-pty's line discipline,
   which the engine was linked against, bridged by hand.

### Version comparison, and the era rule

Versions compare exactly as pacman compares them: `[epoch:]ver[-rel]`,
epoch numerically, the rest by rpmvercmp's alternating numeric and
alphabetic segments. Dependency checks follow `alpm_depcmp`, including
the rule that a constraint with no `-rel` ignores the candidate's rel —
`glibc>=2.38` is satisfied by `2.38-7`.

The interesting case is asking for an old version. `jq@1.6-3` is not the
jq of today, and neither are its dependencies: resolving them against
the current repositories would hand a 2019 binary a 2026 glibc. So when
a root package comes from the archive, its dependencies are resolved
against the same moment in time — the newest version of each that
satisfies the constraint _and_ was built no later than the root. That is
the best a browser can do without a solver, and it is enough for the
common case, which is one old program and the libraries it was built
against.

## The link

The URL is the page's state, so any environment is a link someone can
send. Everything is in the query string, written back with
`replaceState` as it changes, so the address bar is always the link for
what is on screen:

| parameter             | meaning                               |
| --------------------- | ------------------------------------- |
| `pkg=jq`              | the current version from the index    |
| `pkg=jq@1.7.1-2`      | one exact version, archive included   |
| `pkg=git,python`      | comma-separated, and `pkg` may repeat |
| `repo=<url to a .db>` | an extra pacman repository            |
| `aur=<name>`          | an AUR package, built in the guest    |
| `pkgbuild=<url>`      | a PKGBUILD by URL, built in the guest |
| `boot=1`              | start without a click                 |

`repo` is what makes a package that is in no Arch repository bootable:
point it at any repository database whose host allows cross-origin
reads, and its packages join the index for that visit, ahead of core and
extra. Nothing about it is stored — the link is the only place the list
lives. `site/examples/repo` is one such repository, three files built by
`tools/make-example-repo.sh`, served from this site because GitHub Pages
allows cross-origin reads on everything it serves.

`aur` and `pkgbuild` are read again from where they live — the AUR
mirror rewrites a package's branch in place, a PKGBUILD by URL is edited
in place — so the link means the recipe as it is now, the way a bare
`pkg` means the version the repos have now. A recipe dropped on the page
as files has no URL to carry and is not in the link at all.

`boot=1` works in any link. The page never adds it to the address bar
itself, though: a link copied from there lands on the selection with the
Boot button ready, rather than starting a download on open. The one link
the page writes with it is its own "start over in a fresh VM" reload,
where starting at once is the point.

## The share

The guest sees the page's directory `/share` through 9p, mounted at the
same path. Packages are unpacked straight into it, so the share _is_ an
Arch root:

```
/share/usr/bin/jq        as the package laid it out
/share/etc/...           copied into the guest's own /etc at boot
/share/manifest          the environment, sourced by init
```

The manifest is written by the page and makes the guest look like Arch
before the shell starts. Abridged — the real one symlinks `/usr`,
`/lib`, `/lib64`, `/opt`, `/var` and `/srv` into the share and copies
`/share/etc`:

```sh
ln -s /share/usr /usr; ln -s /share/usr/lib /lib; ln -s /share/usr/lib /lib64
ln -s /share/opt /opt; ln -s /share/var /var; ln -s /share/srv /srv
mkdir -p /root /home /run /tmp
[ -d /share/etc ] && cp -a /share/etc/. /etc/
export PATH=/usr/bin:/bin HOME=/root TERM=xterm-256color LANG=C.UTF-8
stty rows R cols C
```

The initramfs has `bin proc sys dev share tmp etc` and nothing else — no
`/usr`, no `/lib` — so those symlinks are the whole filesystem layout,
and `/usr/bin/jq` resolves to the bytes the page just wrote. `/etc` is a
copy rather than a symlink because the guest writes to it and the share
is read-mostly.

TERM is `xterm-256color`, the one name every era's ncurses knows;
ghostty's own `xterm-ghostty` needs a terminfo only very recent ncurses
carries. LANG is `C.UTF-8`, which glibc has had since 2.35 — an older
package falls back to C, and perl says so. `stty` carries the browser's
window size into a serial console, which has no other way to learn it,
and the page keeps it in step as the terminal is resized.

Writing a package into the share is first-writer-wins: files and
symlinks from the package selected first survive, directories merge, and
a hardlink becomes a copy of the target's bytes. Symlink targets are
made absolute, which is not cosmetic — see "Where emscripten and the
guest disagree" below.

Two consequences worth stating plainly. **`.INSTALL` scriptlets never
run**: the page pulls the scriptlet out of the package and stops there,
because it is a shell program written for a real system with a pacman
database, and running one here would be neither safe nor meaningful.
And **a package added to a running VM does not get its `/etc` merged**:
`/etc` was copied once, at boot, so a later package's configuration
stays under `/share/etc` where the reader can find it.

## Building a recipe in the guest

An AUR package is a PKGBUILD, not a package, and a PKGBUILD needs
makepkg, which needs an Arch root. The guest is one. So a recipe is
built where the packages already are: the page fetches makepkg's own
closure beside the selection (pacman, bash, coreutils and the rest,
`BUILD_PROFILES` in `site/js/buildenv.js`; gcc, make, binutils and
pkgconf on top when the PKGBUILD has a `build()` step), boots, and once
the guest is at its prompt types the driver's name into the console.
The console stays live: makepkg's output is worth watching, and Ctrl-C
there gives up on a build the way it would anywhere.

**The page gathers the sources.** The guest has no network, so
`source=()` is the page's job (`site/js/recipe.js`), and the same rule
that picks the mirrors applies: only a host that sends CORS headers can
be read. raw.githubusercontent.com, crates.io and the npm registry do;
GitHub release assets, GitLab, PyPI, gnu.org, kernel.org and SourceForge
do not, which is most of what `-bin` packages point at. A file the page
cannot fetch is a row with the URL and a file input, and a file dropped
there wins over anything fetched. Checksums from the recipe are verified
by the page, `SKIP` included in the sense that it checks nothing. VCS
sources are refused: there is no git in the tab. An AUR recipe is read
from GitHub's mirror of the AUR (`archlinux/aur`, one branch per
pkgbase), because aur.archlinux.org sends no CORS headers either; the
`.SRCINFO` is what the page reads, since makepkg already expanded the
bash, and the PKGBUILD is what the guest runs.

**Nothing is built on the share.** makepkg creates files, chmods them
and makes symlinks, and the engine gets all three wrong on a 9p export
of emscripten's filesystem (below). So the build runs in guest RAM,
under `/tmp/tryarch` on a tmpfs capped at 320 MB — a build that
outgrows it fails with "no space left" rather than taking the guest
down — and the only thing that comes back is the finished archive.
Writing into a file that already exists is the one write the share
takes, so the page creates `out.tar` empty before it starts, the driver
`bsdtar`s the `.pkg.tar` files into it and runs `sync`, and the page
reads it out of the emscripten filesystem and unpacks each package with
the code a download goes through. Packages are written uncompressed
(`PKGEXT='.pkg.tar'`): the page unpacks them itself, and zstd under an
emulator is time for nothing.

**makepkg runs as root**, because root is the only user the guest has.
makepkg refuses that outright, and wants fakeroot for the packaging
step; neither means anything here — nothing keeps ownership on the
share, and there is no second user to protect. The driver copies makepkg
with its one `EUID == 0` test disabled and gives it a fakeroot that runs
the command as the root it already is. `--nodeps` because there is no
pacman database to ask, `--nocheck` because a test suite under an
emulator is not the point, `--skippgpcheck` because there is no keyring;
the checksum verification stays on.

**The lint pass is skipped.** makepkg lints a PKGBUILD before building
it, in a subshell per attribute — about 800 forks — and a fork costs
about 26 ms under the emulator. The example package took 4m51s that way
and 32 s without (`MAKEPKG_LINT_PKGBUILD=0`, the variable makepkg
itself consults). The page has already parsed the recipe, which is most
of what lint would say.

**The guest reports by printing.** The driver prints `tryarch: build #n
done` or `tryarch: build #n failed: <reason>` and the page watches the
console transcript for either, both waiters armed before the command is
typed. `n` counts builds within one page, so a marker belongs to
exactly one build: a marker that could have come from an earlier build
would match at once. Ctrl-C reaches the driver as SIGINT and its trap
prints the failure marker, so the page's wait ends the same way.

What comes out is a package with `repo: "built"`: it appears in the
closure table as "built here", with no download and no PKGBUILD link
unless the recipe came from somewhere linkable, and its programs are on
the guest's PATH like any other. It is not cached — the next visit
builds it again — and it can be built into a running VM as well as at
boot.

## The guest, and why it still says trynix

The virtual machine is trynix's, byte for byte. The engine and the
migration snapshot are fetched by hash from that project's releases
(`engine-pins.json`), and the guest image itself is committed under
`guest/`, because tryarch changed the package universe and not the
machine, and there was nothing to rebuild.

That has one visible consequence: the guest's init prints

```
trynix: waiting for the store
trynix: welcome to the multiverse
```

and the page still matches those strings, because they are how it knows
the guest is up and the share is mounted. The initramfs that prints them
lives inside the snapshot's RAM image, so renaming them means rebuilding
the guest, retaking the snapshot on a native build of the fork, and
republishing the engine release (docs/engine.md) — a lot of moving parts
for two strings nobody sees. Init also still runs
`ln -s /share/nix /nix`, a leftover from trynix's store layout: nothing
in tryarch writes `/share/nix`, so the link dangles and is harmless.

`engine-pins.json` records the hash of each file of the guest image the
snapshot was taken from, and `tools/build-site.py` refuses to assemble a
site whose committed `guest/` does not match. That check is the only
thing standing between a kernel config change and a site that hangs on a
resume.

## Start time

Everything is measured in headless Chromium on a warm cache. Page open
to a shell prompt is about 3 seconds:

| stage                                             | about  |
| ------------------------------------------------- | ------ |
| engine instantiated (wasm from the HTTP cache)    | 1.0 s  |
| QEMU up, migration stream loaded, guest answering | +1.5 s |
| guest mounts the share and starts the shell       | +0.5 s |

On a cold cache add the download: about 4 MB/s from a mirror, about
10 MB/s from the Internet Archive, for a package and its dependencies.
Both run while the engine is compiling, so for anything small the boot
is the cost, not the bytes.

What got it there, and what was tried and dropped:

- **The snapshot.** Booting under emulation is the slow path — BIOS,
  kernel and init on a cold JIT take a minute. The fork's
  `examples/migration/` snapshots a VM on a _native_ build of the same
  tree and the browser build resumes it with `-incoming`. The guest
  image boots to the point where init has done its one-time work and
  parks on a `read`, deliberately before mounting the share: QEMU
  refuses to migrate a VM with a virtfs export mounted, and it also
  means one snapshot serves every package selection. On resume the page
  hands the guest a newline and it mounts whatever share the page built.
- **No monitor conversation.** A restored VM whose source was running
  starts running; the migration stream carries the runstate. The page
  used to toggle to QEMU's monitor, type `cont`, and toggle back, with a
  settling delay around each keystroke — three seconds of nothing.
- **Polling the handshake.** The first newline of a resume is lost — the
  UART it lands in is overwritten by the restore — and nothing says when
  the restore is done. Retrying after four seconds was most of the
  remaining time; the page now offers a newline every 300 ms until the
  guest's console transcript carries the marker init prints once the
  share is mounted. Watching for any output at all is not enough: the
  line discipline echoes each newline straight back. The spares queue in
  the UART and reach the shell as bare prompts, which nothing drains —
  the page waits until the console has been quiet for 400 ms, clears the
  terminal, and sends Ctrl-L so the shell draws one prompt back.
- **Streaming instantiation.** The wasm is not fetched by the page.
  emscripten streams it from its URL, which compiles while downloading —
  that does not happen for a buffer the page passes in. The page only
  warms the HTTP cache, with a progress bar. Moving off GitHub Pages to
  drop the COOP/COEP service worker was tried on the theory that the
  worker costs the browser's compiled-wasm cache; it is a dead end,
  measured in docs/performance.md, because compiling the engine is 56 ms
  either way.
- **Guest RAM.** A 256M guest resumes about 0.3 s faster than 512M (the
  migration load touches every page) and its snapshot is 5 MB smaller.
  Not worth halving the guest for; 512M stays.

Migration demands that snapshotter and restorer agree exactly — QEMU
version, machine type, device config, RAM size. `guest/machine.json` is
the one description of the machine; the page and the snapshot tool both
start QEMU from it, and its hash rides in the pins.

## Memory

The unpacked packages live once, in emscripten's in-memory filesystem,
as the decompressed tar buffers themselves: MEMFS is told to keep the
views it is handed (`canOwn`) rather than copy them. The page never
holds more than the few packages in flight, and once the guest is at its
prompt the kernel, initramfs and snapshot copies in `/pack` are unlinked
(QEMU has read them; the snapshot alone is 32 MB).

The ceiling that remains is the **unpacked** size of the selection, in
the tab: about 1.2 GB, beside a 512 MiB guest. docs/performance.md has
where that budget comes from and what could move it. Exceeding it
surfaces as a bare "TypeError: Failed to fetch", which is the tab
running out of room rather than a network failure.

The way past it is a share that decompresses a package on the guest's
first touch of it rather than up front, keeping the compressed bytes
until then. Unlike cache.nixos.org, the mirrors do serve Range requests,
so even fetching lazily is on the table; both need an emscripten
filesystem node whose contents are produced on first read.

## Speed

The guest runs on the fork's wasm TCG backend: a translation block is
interpreted until its 1500th execution, then compiled to a small wasm
module. Measured in the guest, both loops of ten:

| workload                         | before | after |
| -------------------------------- | ------ | ----- |
| exec of a dynamic binary over 9p | 8.6 s  | 1.1 s |
| exec of busybox `true`           | —      | 0.3 s |
| `cat` of a file on the share     | —      | 0.7 s |
| 20 000 iterations of `$((i+1))`  | 7.7 s  | 7.7 s |

Where the exec time went, and what was done:

- **9p with no cache.** The share was mounted `cache=none`: every exec
  walked every path component and read libc over the wire again.
  `cache=loose` keeps dentries, inodes and page cache in the guest;
  nothing already written is ever rewritten, so nothing cached goes
  stale, and 9p drops negative dentries so a name that was missing once
  is looked up again — which is what lets packages be added later.
- **Mitigations.** Page-table isolation and friends make every syscall
  flush the emulated TLB. The guest has nothing to protect from itself
  and runs with `mitigations=off`.
- **One syscall per 9p operation.** Under emscripten every filesystem
  syscall is a synchronous round trip to the browser's main thread, and
  QEMU's local backend opened a path one component at a time to keep a
  symlink from escaping the export. The share is a private in-memory
  directory; `patches/0002` opens and stats a path in one call. Worth
  10–25% on file operations once the guest caches.
- **A lower JIT threshold** (300 instead of 1500) was built and
  measured: slower on both loops, since short-lived processes pay the
  compile and never amortise it. Not adopted. The 1500 is the fork's own
  TCG setting and neither number was re-measured for tryarch — see the
  dead ends in docs/performance.md, where the original measurement is
  marked untrustworthy.

What is left is emulation itself: a shell loop runs about 400 µs per
iteration, and a fork-plus-exec about 30 ms even with nothing on 9p.
Nothing in a browser accelerates that — there is no KVM — so the levers
are the emulator's.

## Where emscripten and the guest disagree

Six bugs, all in the seam between emscripten's filesystem and a real
Linux guest using it over 9p: three met by reading packages, three more
by building one. Each is invisible until a package does something more
than print a greeting, and each is worth knowing before changing this
code.

**Symlinks.** `FS.readlink` resolves a link against its parent and
returns an absolute path, while the stat beside it reports the
_relative_ target's length. A guest reading such a link gets a string
longer than the size it was promised. tryarch writes absolute targets
itself (`absoluteTarget` in `site/js/share.js`) so the two agree, and
mounts the share in the guest at the same path the page built it at
(`/share`) so those absolute targets resolve. The mount point is
load-bearing, not cosmetic — and Arch packages are full of symlinks,
starting with every `libfoo.so` in `/usr/lib`.

**Errnos.** 9p2000.L carries Linux errno numbers, but emscripten's libc
numbers its errnos after WASI. qemu-wasm declares emscripten to need no
translation, so ENOENT (44 in WASI, 2 in Linux) reaches the guest as
ECHRNG. A dynamic loader walking its search path expects ENOENT from
directories that lack the library and moves on; given "Error 44" it
stops. Every package that finds libraries by search rather than by RPATH
fails to start — which, on Arch, is every package.
`patches/0001-9pfs-translate-emscripten-errnos-to-linux.patch` fixes it
in the engine, and is worth sending upstream.

**stdout.** Defining `Module.print` or `printErr` takes stdout and
stderr away from the xterm-pty js-library linked into the build, and the
console stays blank for the whole run — guest output included. QEMU's
diagnostics arrive in the terminal instead.

**Writes from the guest.** Creating a file or a directory on the share
fails with EPERM: the 9p server chmods what it just created through
`chmod("/proc/self/fd/N")`, a Linux idiom (`fchmodat_nofollow`) that
emscripten's filesystem has no `/proc` for. Making a symlink is worse —
the `symlinkat` glue in the built engine calls a helper it never
imported, the TypeError lands on the main thread, and the VM stops for
good, no error anywhere the guest could see. And an operation the
filesystem does not support comes back as errno 138, ENOTSUP in
emscripten's numbering, which the translation patch does not map, so
the guest prints "Unknown error 138". Writing into a file that already
exists is the one thing that works, since it goes through the truncate
path and creates nothing; that is why a build hands its result back
through a file the page made first, and why overlayfs over the share
(tried under every option set) was abandoned. docs/engine.md says what
the next engine build should fix.

And one thing that is not a bug: busybox's `clear` sends only the
erase-screen sequence, so the terminal's scrollback survives it. The
`clear` from ncurses sends erase-scrollback too, and a guest with it on
PATH behaves as expected.

## Limits

Collected in one place, because most of them are consequences of
decisions above rather than things left undone:

- **No PGP verification.** SHA-256 from the repository database, SHA-1
  from the Internet Archive, and https to a mirror. No keyring.
- **`.INSTALL` scriptlets are never run**, and a package added after
  boot does not get its `/etc` into the guest's `/etc`.
- **core and extra, `x86_64` and `any` only.** multilib is skipped: it
  exists to run 32-bit binaries beside 64-bit ones, which is a use for a
  desktop and not for a shell in a tab.
- **A recipe builds with makepkg, or makepkg and gcc**, at emulator
  speed, from sources the page can fetch or the reader supplies, and
  never from a VCS. The rest of base-devel is a makedepends away when a
  recipe names it, and every package of it is a download and a share of
  the guest's memory; a build tree larger than 320 MB fails.
- **History stops around October 2024**, and only for packages the
  Internet Archive happened to have collected.
- **Five mirrors.** The list was scanned by hand and nothing keeps it
  correct: a mirror that stops sending the CORS header stops working,
  and if all five stop, so does the site. Re-running the scan is a
  manual job, and the page tries every mirror before it fails.
- **One vCPU, 512 MiB, no network in the guest.** Programs that want a
  network, a service manager or a real init will not find one.

## Performance

Where a first run's time actually goes, what would move it, and the
things that looked like they would and did not:
[docs/performance.md](./performance.md).

## Repository layout

- `site/` — the static site (vanilla ES modules; the tokens and chrome
  of the author's other sites, so the family reads as one).
- `guest/` — the guest image, committed prebuilt: kernel, initramfs,
  BIOS blobs and `machine.json`; `guest/src/` is what they are built
  from, and `tools/build-guest.sh` rebuilds them in a container.
- `engine-pins.json` — the release the engine and the snapshot are
  fetched from, by hash, and the hashes of the guest the snapshot was
  taken against.
- `patches/` — what the engine is built with, plus two against vendored
  browser libraries.
- `tools/` — plain python3 and bash. `build-site.py` assembles the
  deployable tree, including the js.<hash> cache-busting trick;
  `vendor.py` copies the browser libraries out of `node_modules`;
  `fetch-engine.py` resolves the pins; `build-index.py` builds the
  index; `serve.py` serves a built tree; the rest are the engine tools
  (docs/engine.md).
- `examples/` — the PKGBUILD behind the extra-repository example, built
  into `site/examples/repo` by `tools/make-example-repo.sh`, and read
  straight from GitHub by the Build lane's example link.
- `tests/` — the node and python suites, offline; run by CI along with
  `prettier --check`.
- `docs/` — this file, docs/engine.md and docs/performance.md.

## Alternatives considered

qemu-wasm's own README names the prior art; none of it can run the
x86_64 binaries the mirrors hold, which is the requirement that decides
everything:

- **JSLinux** (bellard.org/jslinux) emulates a 64-bit x86 CPU — AVX-512
  and APX included — and boots in seconds, but that engine's source is
  unreleased: the published TinyEMU (2019-12-21, MIT) carries only the
  old 32-bit x86 and the RISC-V emulators, and its vfsync filesystem and
  websocket VPN are services on bellard.org. Nothing to build on today;
  a future source release would be worth revisiting as a smaller, faster
  backend.
- **v86** is fast and maintained but 32-bit x86 by design, and Arch has
  not shipped 32-bit packages for years.
- **qemu.js** (the frozen port) predates wasm threads and asyncify;
  qemu-wasm is that idea done with them.
- **Unicorn.js** is QEMU's CPU core extracted for binary analysis — no
  devices, nothing boots.

JSLinux still contributes the design worth stealing: vfsync faults the
root filesystem in over HTTP per file as the guest touches it, which is
why it boots instantly. The equivalent here is the lazy share described
under Memory, and the mirrors' Range support makes it more plausible
than it was for trynix.

## Open questions

- An engine build that does not need docker and a pinned emscripten
  SDK, so a checkout can rebuild it (docs/engine.md).
- Rescanning the mirror list automatically, and noticing when one of the
  five stops answering, rather than finding out from a broken boot.
- A real solver for the era rule, so an old package's whole dependency
  set is chosen as one consistent world instead of newest-that-fits, one
  at a time.
- An aarch64 guest, as the one emulation experiment left — the archive
  has no aarch64 packages, so it would need a different package source
  as well as a different engine.

[trynix]: https://github.com/fzakaria/trynix
[qemu-wasm]: https://github.com/ktock/qemu-wasm
[ghostty-web]: https://github.com/coder/ghostty-web
