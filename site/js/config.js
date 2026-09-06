// Site-wide constants.

// The Arch mirrors the page fetches repo databases and packages from.
//
// A browser can only read a mirror that answers cross-origin, and
// almost none do: of the 396 https mirrors on archlinux.org, these five
// send `access-control-allow-origin: *` on both the .db files and the
// package files (verified 2026-09-05, Range requests included). They are
// tried in this order, so a mirror that dropped a file costs one 404 and
// not a boot.
export const MIRRORS = [
  "https://mirror.lcarilla.de/archlinux/",
  "https://archlinux.mailtunnel.eu/",
  "https://repo.c48.uk/arch/",
  "https://mirror.iusearchbtw.nl/",
  "https://yonderly.org/mirrors/archlinux/",
];

// The official binary repos the index covers, in priority order: a name
// in both core and extra resolves to the core build. multilib is left
// out — its packages are 32-bit libraries the guest has no loader for.
export const REPOS = ["core", "extra"];

// The only architecture Arch still ships. "any" packages live in the
// x86_64 directory too, so one arch names every URL the page builds.
export const ARCH = "x86_64";

// The generated index, served next to the page (tools/build-index.py
// writes it at deploy time; it is never committed).
export const INDEX_DIR = "index";

// The AUR half of that index, under INDEX_DIR: the same shard layout,
// written from the AUR's own package dump. It is kept apart because it
// is an order of magnitude bigger than the binary repos and nothing
// reads it until somebody asks for a package no repo ships.
export const AUR_INDEX_DIR = "aur";

// The Internet Archive's copy of the Arch Linux Archive: one item per
// package name, holding every version that was ever in the repos.
// /metadata answers with CORS `*`, and /cors serves the bytes with an
// echoed Origin — /download does not, so it is never used.
export const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
export const ARCHIVE_DOWNLOAD_URL = "https://archive.org/cors";
export const ARCHIVE_ITEM_PREFIX = "archlinux_pkg_";

// Where a version's recipe lives. The project is the pkgbase with "+"
// spelled "plus", the tag is the full version with ":" spelled "-".
export const PKGBUILD_URL =
  "https://gitlab.archlinux.org/archlinux/packaging/packages";

// GitHub's mirror of the AUR's git, one branch per pkgbase. This is
// the only copy of an AUR recipe a browser can read: aur.archlinux.org
// serves the same files and sends no CORS header at all. A recipe is
// `${AUR_RAW_URL}/${base}/.SRCINFO` or `${AUR_RAW_URL}/${base}/PKGBUILD`.
export const AUR_RAW_URL = "https://raw.githubusercontent.com/archlinux/aur";

// The human page for a package, `${AUR_PAGE_URL}/${name}`: votes, the
// comments, and whoever flagged it out of date.
export const AUR_PAGE_URL = "https://aur.archlinux.org/packages";

// How many name matches the search list shows at once, and how many
// completions the spec box's dropdown offers.
export const SEARCH_LIMIT = 12;
export const RANGE_COMPLETIONS = 12;

// How many index shard fetches fly at once. The bound exists for the
// browser's connection queue, not for the host.
export const FETCH_CONCURRENCY = 20;

// How many packages download and unpack at once during a boot.
export const PACKAGE_CONCURRENCY = 4;

// The guest files the page feeds into the VM's -L directory, served
// under guest/ (committed prebuilt; tools/build-guest.sh rebuilds them).
export const GUEST_FILES = [
  "bzImage",
  "initramfs.cpio.gz",
  "bios-256k.bin",
  "vgabios-stdvga.bin",
  "kvmvapic.bin",
  "linuxboot_dma.bin",
];

// The machine definition: guest RAM and QEMU's arguments, shared with
// the snapshot tool (guest/machine.json says why).
export const MACHINE_URL = "guest/machine.json";

// The qemu engine artifacts, served under qemu/. The wasm is fetched
// by hand so the biggest download gets a progress bar; out.js and the
// pthread worker are loaded by the module machinery, through the same
// versioned URLs (site/js/assets.js).
export const QEMU_WASM = "qemu/qemu-system-x86_64.wasm";
export const QEMU_MAIN = "qemu/out.js";
export const QEMU_WORKER = "qemu/qemu-system-x86_64.worker.js";

// The migration snapshot: a guest already booted to the point of
// waiting for the share, so a visit resumes rather than boots.
// Optional — the page cold-boots when it is not published.
export const SNAPSHOT_URL = "qemu/vm.state";
