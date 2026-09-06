// Fetching one package file and taking it apart.
//
// A .pkg.tar.zst is downloaded from the first source that serves it,
// checked against the digest the database or the archive named,
// decompressed, and read as a tar. The dot-files at the front are the
// package's own metadata: .PKGINFO is what a dependency walk reads for
// an archived build, .INSTALL is a scriptlet this site never runs (it
// is kept only so the page can say a package wanted one), and .MTREE,
// .BUILDINFO and .CHANGELOG are of no use once the bytes are here.
//
// The decompressors arrive as vendored UMD scripts, so they are globals
// here rather than imports.
/* global fzstd, xzwasm */

import { parsePkginfo } from "./desc.js";
import { pkgbuildUrl } from "./index.js";
import { log } from "./log.js";
import { fetchWithProgress } from "./net.js";
import { parseTar } from "./tar.js";

const NOT_FOUND = 404;

// Every mirror answered 404. That is an ordinary outcome, not a bug: a
// package superseded since the index was built exists nowhere on the
// mirrors, and the caller's answer is to re-read the repo database
// (index.refreshRepo) or fall back to the archive.
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
  }
}

const PKGINFO = ".PKGINFO";
const INSTALL = ".INSTALL";
// Read and dropped: a checksum tree, a build environment record and a
// changelog, none of which the guest has any use for.
const DISCARDED = new Set([".MTREE", ".BUILDINFO", ".CHANGELOG"]);

// The metadata dot-files split away from the files that get unpacked.
export function splitEntries(entries) {
  let meta = null;
  let install = null;
  const files = [];

  for (const entry of entries) {
    if (entry.path === PKGINFO) {
      meta = parsePkginfo(new TextDecoder().decode(entry.data));
      continue;
    }
    if (entry.path === INSTALL) {
      install = new TextDecoder().decode(entry.data);
      continue;
    }
    if (DISCARDED.has(entry.path)) {
      continue;
    }
    files.push(entry);
  }

  return { meta, install, files };
}

// Downloads run several at a time, but decompression does not.
//
// Each xz stream instantiates its own decoder and a package can unpack
// to hundreds of megabytes; several of those at once exhaust the
// decoder's wasm memory, and the failure arrives as a stream error,
// which reading a Response reports as the same bare "TypeError: Failed
// to fetch" a dead network gives. Serialising the decode keeps the peak
// to one archive.
let decoding = Promise.resolve();

function serialize(work) {
  const result = decoding.then(work, work);
  // A failed decode must not poison the queue for everything after it.
  decoding = result.then(
    () => {},
    () => {},
  );
  return result;
}

// The tar bytes, by what the filename says they were compressed with.
async function decode(build, compressed, override) {
  return serialize(async () => {
    try {
      if (override !== undefined) {
        return await override(compressed, build);
      }
      if (build.filename.endsWith(".zst")) {
        return fzstd.decompress(compressed);
      }
      if (build.filename.endsWith(".xz")) {
        const stream = new xzwasm.XzReadableStream(
          new Response(compressed).body,
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      if (build.filename.endsWith(".gz")) {
        const stream = new Response(compressed).body.pipeThrough(
          new DecompressionStream("gzip"),
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
      return compressed;
    } catch (err) {
      // Say which package: the underlying message names nothing.
      log(`failed to decompress ${build.filename}: ${err.message}`);
      throw new Error(`${build.filename}: decode failed: ${err.message}`);
    }
  });
}

// One package: fetch, verify, decompress, parse, and fill in what the
// build did not know about itself. `decompress(bytes, build)` is
// injectable so the tests can exercise the splitting without the
// vendored decoders.
export async function fetchPackage(build, options = {}) {
  const { onBytes, onTotal, decompress } = options;

  // Any failure moves on to the next source: a mirror that is down, or
  // one that has stopped sending the CORS header, is no reason to give
  // up on a file the next mirror serves. Only when every source said
  // 404 is the file gone; otherwise the last failure is the answer.
  let compressed = null;
  let failure = null;
  for (const url of build.urls) {
    try {
      compressed = await fetchWithProgress(url, {
        onBytes,
        onTotal,
        digest: build.digest,
      });
      break;
    } catch (err) {
      if (err.status === NOT_FOUND) {
        log(`${url} is gone (404); trying the next source`);
      } else {
        log(`${url} failed (${err.message}); trying the next source`);
        failure = err;
      }
    }
  }

  if (compressed === null) {
    if (failure !== null) {
      throw failure;
    }
    throw new NotFoundError(`${build.filename}: no source still has it`);
  }

  // The digest already covers the contents; the size catches the case
  // where there was no digest to check.
  if (build.size !== null && compressed.byteLength !== build.size) {
    throw new Error(
      `${build.filename}: ${compressed.byteLength} bytes, expected ${build.size}`,
    );
  }

  const tar = await decode(build, compressed, decompress);
  const { meta, install, files } = splitEntries(parseTar(tar));

  if (meta !== null) {
    build.depends ??= meta.depends;
    build.desc ??= meta.desc;
    build.isize ??= meta.isize;
    build.builddate ??= meta.builddate;
    if (build.provides.length === 0) {
      build.provides = meta.provides;
    }
    // .PKGINFO is the authority on pkgbase, and an archived build only
    // had the filename to guess it from — so the PKGBUILD link is
    // corrected here rather than left pointing at a project that may
    // not exist.
    if (meta.base !== null && meta.base !== build.base) {
      build.base = meta.base;
      build.pkgbuild = pkgbuildUrl(meta.base, build.version);
    }
  }

  return {
    build,
    meta,
    entries: files,
    install,
    compressed: compressed.byteLength,
    unpacked: tar.byteLength,
  };
}
