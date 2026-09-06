// Tests taking a package file apart: the dot-files split away from what
// gets unpacked, the source loop that walks past a failure, and the fields
// a build only learns about itself once its .PKGINFO is read (which is
// every field, for an archived build).
//
// The vendored decompressors are browser globals, so the decode step is
// injected here; everything either side of it is the real thing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  NotFoundError,
  fetchPackage,
  splitEntries,
} from "../../site/js/pkg.js";
import { parseTar } from "../../site/js/tar.js";

// --- a tar, built here so a case can be exactly one thing ---------------

const BLOCK = 512;
const encoder = new TextEncoder();

function tar(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = encoder.encode(text);
    const header = new Uint8Array(BLOCK);
    const put = (offset, value) => header.set(encoder.encode(value), offset);
    put(0, name);
    put(100, "0000644");
    put(108, "0000000");
    put(116, "0000000");
    put(124, body.length.toString(8).padStart(11, "0"));
    put(136, "00000000000");
    put(156, "0");
    put(257, "ustar 00");
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, sum.toString(8).padStart(6, "0"));
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
    padded.set(body);
    if (padded.length > 0) {
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const bytes = new Uint8Array(
    blocks.reduce((n, block) => n + block.length, 0),
  );
  let at = 0;
  for (const block of blocks) {
    bytes.set(block, at);
    at += block.length;
  }
  return bytes;
}

const PKGINFO = await readFile(
  new URL("../fixtures/PKGINFO", import.meta.url),
  "utf8",
);

// --- splitting ----------------------------------------------------------

test("splitEntries takes the dot-files out of the file list", () => {
  const entries = parseTar(
    tar({
      ".PKGINFO": PKGINFO,
      ".INSTALL": "post_install() { :; }\n",
      ".MTREE": "binary junk",
      ".BUILDINFO": "format = 2\n",
      ".CHANGELOG": "old news\n",
      "usr/bin/jq": "#!/bin/sh\n",
    }),
  );

  const { meta, install, files } = splitEntries(entries);
  assert.equal(meta.name, "jq");
  assert.deepEqual(meta.depends, ["glibc", "oniguruma"]);
  assert.equal(install, "post_install() { :; }\n");
  assert.deepEqual(
    files.map((entry) => entry.path),
    ["usr/bin/jq"],
  );
});

test("a package with no metadata splits to nulls", () => {
  const { meta, install, files } = splitEntries(
    parseTar(tar({ "usr/bin/x": "x" })),
  );
  assert.equal(meta, null);
  assert.equal(install, null);
  assert.equal(files.length, 1);
});

// --- fetching -----------------------------------------------------------

// The persistent cache is a browser API; here it never has anything and
// never keeps anything.
globalThis.caches = {
  open: async () => ({
    match: async () => undefined,
    put: async () => {},
    delete: async () => {},
  }),
};

const CONTENT = tar({ ".PKGINFO": PKGINFO, "usr/bin/jq": "#!/bin/sh\n" });

// Serve some URLs and 404 the rest.
function serve(bodies) {
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    const body = bodies[url];
    return body === undefined
      ? new Response("gone", { status: 404 })
      : new Response(body, {
          status: 200,
          // A mirror sends a length; it is what fills the progress bar.
          headers: { "Content-Length": String(body.byteLength) },
        });
  };
  return asked;
}

const MIRROR = "https://mirror.invalid/a.pkg.tar.zst";
const ARCHIVE = "https://archive.invalid/a.pkg.tar.zst";

const archived = () => ({
  name: "jq",
  base: "jq",
  version: "1.7.1-2",
  repo: "archive",
  filename: "jq-1.7.1-2-x86_64.pkg.tar.zst",
  urls: [MIRROR, ARCHIVE],
  size: null,
  isize: null,
  digest: null,
  builddate: null,
  desc: null,
  depends: null,
  provides: [],
  pkgbuild: null,
});

const identity = async (bytes) => bytes;

test("fetchPackage fills in what the build did not know", async () => {
  serve({ [MIRROR]: CONTENT });
  const build = archived();
  const result = await fetchPackage(build, { decompress: identity });

  assert.equal(result.compressed, CONTENT.byteLength);
  assert.equal(result.unpacked, CONTENT.byteLength);
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ["usr/bin/jq"],
  );
  assert.equal(result.install, null);

  // An item listing says nothing about dependencies; the package does.
  assert.deepEqual(build.depends, ["glibc", "oniguruma"]);
  assert.equal(build.desc, "Command-line JSON processor");
  assert.equal(build.isize, 765858);
  assert.equal(build.builddate, 1717879231);
});

test("what the build already knew is not overwritten", async () => {
  serve({ [MIRROR]: CONTENT });
  const build = { ...archived(), depends: ["glibc"], isize: 1, desc: "mine" };
  await fetchPackage(build, { decompress: identity });
  assert.deepEqual(build.depends, ["glibc"]);
  assert.equal(build.isize, 1);
  assert.equal(build.desc, "mine");
});

test("the package is the authority on its pkgbase", async () => {
  const split = tar({
    ".PKGINFO": "pkgname = gcc-libs\npkgbase = gcc\npkgver = 14.1-1\n",
    "usr/lib/libgcc_s.so": "x",
  });
  serve({ [MIRROR]: split });

  // An archived build guesses its pkgbase from the filename, which is
  // wrong for every split package, so the recipe link is corrected once
  // the real one is known.
  const build = {
    ...archived(),
    name: "gcc-libs",
    base: "gcc-libs",
    version: "14.1-1",
    pkgbuild:
      "https://gitlab.archlinux.org/archlinux/packaging/packages/gcc-libs/-/blob/14.1-1/PKGBUILD",
  };
  await fetchPackage(build, { decompress: identity });

  assert.equal(build.base, "gcc");
  assert.equal(
    build.pkgbuild,
    "https://gitlab.archlinux.org/archlinux/packaging/packages/gcc/-/blob/14.1-1/PKGBUILD",
  );
});

test("a 404 moves on to the next source", async () => {
  const asked = serve({ [ARCHIVE]: CONTENT });
  const result = await fetchPackage(archived(), { decompress: identity });
  assert.equal(result.compressed, CONTENT.byteLength);
  // One try each: a 404 is an answer, not a hiccup to retry.
  assert.deepEqual(asked, [MIRROR, ARCHIVE]);
});

// A mirror that fails outright — down, or no longer sending the CORS
// header — is skipped like a 404, and the next one gets its turn.
test("a source that fails outright is skipped for the next", async () => {
  const asked = serve({ [ARCHIVE]: CONTENT });
  const upstream = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === MIRROR) {
      asked.push(url);
      throw new TypeError("Failed to fetch");
    }
    return upstream(url);
  };
  const result = await fetchPackage(archived(), { decompress: identity });
  assert.equal(result.compressed, CONTENT.byteLength);
  // The failing mirror was retried, the archive was asked once.
  assert.equal(asked.at(-1), ARCHIVE);
  assert.equal(asked.filter((url) => url === ARCHIVE).length, 1);
  assert.ok(asked.filter((url) => url === MIRROR).length > 1);
});

test("when nothing serves it and not all said 404, the failure is the error", async () => {
  serve({});
  globalThis.fetch = async (url) => {
    if (url === MIRROR) {
      throw new TypeError("Failed to fetch");
    }
    return new Response("gone", { status: 404 });
  };
  await assert.rejects(
    () => fetchPackage(archived(), { decompress: identity }),
    (err) => {
      assert.ok(!(err instanceof NotFoundError));
      assert.match(err.message, /mirror\.invalid.*Failed to fetch/);
      return true;
    },
  );
});

test("every source gone is a NotFoundError", async () => {
  serve({});
  await assert.rejects(
    () => fetchPackage(archived(), { decompress: identity }),
    (err) => {
      assert.ok(err instanceof NotFoundError);
      assert.match(err.message, /no source still has it/);
      return true;
    },
  );
});

test("a short body is refused even with no digest to check", async () => {
  serve({ [MIRROR]: CONTENT });
  const build = { ...archived(), size: CONTENT.byteLength + 10 };
  await assert.rejects(
    () => fetchPackage(build, { decompress: identity }),
    /bytes, expected/,
  );
});

test("decompression runs one at a time", async () => {
  serve({ [MIRROR]: CONTENT });

  // Several xz decoders at once exhaust the decoder's wasm memory, and
  // the failure arrives as an unattributable stream error, so the
  // decode queue is serialised.
  let running = 0;
  let peak = 0;
  const decompress = async (bytes) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return bytes;
  };

  await Promise.all([
    fetchPackage(archived(), { decompress }),
    fetchPackage(archived(), { decompress }),
    fetchPackage(archived(), { decompress }),
  ]);
  assert.equal(peak, 1);
});

test("a failed decode does not poison the queue", async () => {
  serve({ [MIRROR]: CONTENT });
  await assert.rejects(
    () =>
      fetchPackage(archived(), {
        decompress: async () => {
          throw new Error("out of memory");
        },
      }),
    /decode failed: out of memory/,
  );
  const result = await fetchPackage(archived(), { decompress: identity });
  assert.equal(result.compressed, CONTENT.byteLength);
});

test("progress is reported as the body arrives", async () => {
  serve({ [MIRROR]: CONTENT });
  let bytes = 0;
  let total = null;
  await fetchPackage(archived(), {
    decompress: identity,
    onBytes: (n) => {
      bytes += n;
    },
    onTotal: (n) => {
      total = n;
    },
  });
  assert.equal(bytes, CONTENT.byteLength);
  assert.equal(total, CONTENT.byteLength);
});
