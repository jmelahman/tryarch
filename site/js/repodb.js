// Reading a pacman repository database.
//
// `core.db` is a gzipped tar of one directory per package holding a
// `desc` file — the same format `repo-add` writes, so a database the
// page fetches from a mirror and one somebody built for their own
// packages parse identically. Databases from before pacman 5 split the
// dependency fields into a sibling `depends` file, which is merged in
// when it is there.
//
// The page reads a database in two situations: an extra repo somebody
// pasted a URL for, and the freshness fallback — the generated index
// can be a few hours older than the mirrors, and a mirror deletes a
// superseded package within hours of a sync, so when every mirror 404s
// the page asks the mirror itself what it has now.
/* global xzwasm, fzstd */

import { parseDesc } from "./desc.js";
import { parseTar } from "./tar.js";

// The compressions a .db may arrive in. repo-add writes gzip; the
// others are accepted because makepkg-adjacent tooling writes them and
// the page already has both decoders on hand for packages.
const GZIP = [0x1f, 0x8b];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const XZ = [0xfd, 0x37, 0x7a, 0x58, 0x5a];

const startsWith = (bytes, magic) =>
  magic.every((byte, i) => bytes[i] === byte);

async function decompress(bytes) {
  if (startsWith(bytes, GZIP)) {
    const stream = new Response(bytes).body.pipeThrough(
      new DecompressionStream("gzip"),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (startsWith(bytes, ZSTD)) {
    return fzstd.decompress(bytes);
  }
  if (startsWith(bytes, XZ)) {
    const stream = new xzwasm.XzReadableStream(new Response(bytes).body);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  // An uncompressed tar: repo-add can be told to write one.
  return bytes;
}

// name -> PackageMeta for every entry in an unpacked database tar.
export function parseRepoDb(tarBytes) {
  const packages = new Map();

  for (const entry of parseTar(tarBytes)) {
    if (entry.type !== "file") {
      continue;
    }
    const [, file] = entry.path.split("/");
    if (file !== "desc" && file !== "depends") {
      continue;
    }

    const meta = parseDesc(new TextDecoder().decode(entry.data));
    // `depends` names nothing; its package is the directory it sits in,
    // which `desc` already named.
    const name =
      meta.name ?? entry.path.split("/")[0].replace(/-[^-]+-[^-]+$/, "");
    const existing = packages.get(name);
    packages.set(name, existing === undefined ? meta : merge(existing, meta));
  }

  return packages;
}

// Two halves of one entry: scalars from whichever half had them, lists
// from whichever half was not empty.
function merge(a, b) {
  const merged = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        merged[key] = value;
      }
      continue;
    }
    merged[key] ??= value;
  }
  return merged;
}

// Fetch and parse a database. `cache: "no-cache"` because a database is
// the one thing here that is expected to change under its own name.
export async function fetchRepoDb(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseRepoDb(await decompress(bytes));
}

// Where the packages a database describes live: beside the database
// itself, which is true of a mirror's os/x86_64/ directory and of
// anything repo-add built.
export function packageUrl(dbUrl, filename) {
  return dbUrl.replace(/[^/]*$/, "") + filename;
}
