// Historical builds, from the Internet Archive's copy of the Arch Linux
// Archive.
//
// archive.archlinux.org has every package Arch ever shipped and no CORS
// header, so a browser cannot read a byte of it. The Internet Archive
// mirrors it as one item per package name — `archlinux_pkg_jq` — whose
// metadata endpoint answers `access-control-allow-origin: *` and whose
// /cors/ download path echoes the Origin back. That is the only way an
// old version reaches this page.
//
// Two things the item listing does not tell us: what a build depended
// on, and what its pkgbase was. Both come out of the package's own
// .PKGINFO once it is fetched, so they start null here rather than
// guessed.
//
// The mirror stops around October 2024 — the newest item was added
// 2024-10-10 — so a version superseded after that is in neither the
// mirrors nor here. The site documents the gap.

import {
  ARCHIVE_DOWNLOAD_URL,
  ARCHIVE_ITEM_PREFIX,
  ARCHIVE_METADATA_URL,
  ARCH,
} from "./config.js";
import { vercmp } from "./vercmp.js";
import { pkgbuildUrl } from "./index.js";

// Package files, and only package files: the item also holds .sig
// files, torrents and the item's own metadata.
const PACKAGE = /^(.+)\.pkg\.tar\.(zst|xz|gz)$/;

// The architectures this guest can run. "any" packages are arch-less
// data, which is fine to unpack.
const ARCHITECTURES = new Set([ARCH, "any"]);

export const archiveItemOf = (name) => `${ARCHIVE_ITEM_PREFIX}${name}`;

// A package filename is <name>-<ver>-<rel>-<arch>.pkg.tar.<ext>, and
// the name is the part nobody can parse from the left: "python-
// setuptools-69.0.3-1-any" splits correctly only by taking the last
// three fields from the right. Everything before them is the name,
// dashes and all.
export function parseFilename(filename) {
  const match = PACKAGE.exec(filename);
  if (match === null) {
    return null;
  }

  const parts = match[1].split("-");
  if (parts.length < 4) {
    return null;
  }
  const arch = parts.pop();
  const rel = parts.pop();
  const ver = parts.pop();
  return {
    name: parts.join("-"),
    version: `${ver}-${rel}`,
    arch,
    compression: match[2],
  };
}

const items = new Map();

// Every archived build of one name, newest first. A name the archive
// never held answers with `{}`, which is the same answer as an item
// with no package files: an empty list.
export async function archivedBuilds(name, options = {}) {
  // An injected fetcher is a test's, and must not be answered from (or
  // poison) the cache the page shares between lookups.
  if (options.fetchJson !== undefined) {
    return load(name, options).catch(() => []);
  }
  if (!items.has(name)) {
    items.set(
      name,
      load(name, options).catch(() => []),
    );
  }
  return items.get(name);
}

async function load(name, { fetchJson = defaultFetchJson } = {}) {
  const metadata = await fetchJson(
    `${ARCHIVE_METADATA_URL}/${archiveItemOf(name)}`,
  );

  const builds = [];
  for (const file of metadata?.files ?? []) {
    const parsed = parseFilename(file.name ?? "");
    // A file whose name parses to a different package is a sibling the
    // item happens to carry; it is not this package's history.
    if (parsed === null || parsed.name !== name) {
      continue;
    }
    if (!ARCHITECTURES.has(parsed.arch)) {
      continue;
    }

    builds.push({
      name,
      base: name,
      version: parsed.version,
      repo: "archive",
      filename: file.name,
      // The filename has to be percent-encoded on the /cors/ path: a
      // raw "+" is read as a space there and redirects to a 404 page.
      urls: [
        `${ARCHIVE_DOWNLOAD_URL}/${archiveItemOf(name)}/${encodeURIComponent(file.name)}`,
      ],
      size: Number(file.size) || null,
      isize: null,
      digest: file.sha1 ? { algorithm: "SHA-1", hex: file.sha1 } : null,
      builddate: Number(file.mtime) || null,
      desc: null,
      depends: null,
      provides: [],
      pkgbuild: pkgbuildUrl(name, parsed.version),
    });
  }

  return builds.sort((a, b) => vercmp(b.version, a.version));
}

// The metadata endpoint is a plain cross-origin GET of JSON. It is
// injectable so the tests can hold a real item's response in a fixture
// instead of talking to archive.org.
async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.json();
}
