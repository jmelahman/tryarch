// Tests the Internet Archive lane against a real item listing (jq's,
// trimmed) and against the filenames that break a naive parser: a name
// with dashes in it, a version with a "+" in it, an i686 build, and the
// .sig sitting beside every package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  archiveItemOf,
  archivedBuilds,
  parseFilename,
} from "../../site/js/archive.js";

const jq = JSON.parse(
  await readFile(new URL("../fixtures/jq-ia.json", import.meta.url), "utf8"),
);

// Serve one item listing and record what was asked for.
function fetcher(metadata) {
  const asked = [];
  const fetchJson = async (url) => {
    asked.push(url);
    return metadata;
  };
  return { fetchJson, asked };
}

test("an item is named after the package", () => {
  assert.equal(archiveItemOf("jq"), "archlinux_pkg_jq");
  assert.equal(
    archiveItemOf("python-setuptools"),
    "archlinux_pkg_python-setuptools",
  );
});

test("archivedBuilds reads a real item listing", async () => {
  const { fetchJson, asked } = fetcher(jq);
  const builds = await archivedBuilds("jq", { fetchJson });

  assert.deepEqual(asked, ["https://archive.org/metadata/archlinux_pkg_jq"]);

  // The i686 build, the .sig and the item's own metadata are not
  // builds; everything else is, newest first.
  assert.deepEqual(
    builds.map((build) => build.version),
    ["1.7.1-2", "1.7.1-1", "1.7-1", "1.6-1", "1.5-1"],
  );

  const newest = builds[0];
  assert.equal(newest.name, "jq");
  assert.equal(newest.base, "jq");
  assert.equal(newest.repo, "archive");
  assert.equal(newest.filename, "jq-1.7.1-2-x86_64.pkg.tar.zst");
  assert.deepEqual(newest.urls, [
    "https://archive.org/cors/archlinux_pkg_jq/jq-1.7.1-2-x86_64.pkg.tar.zst",
  ]);
  assert.equal(newest.size, 294184);
  assert.equal(newest.builddate, 1717881277);
  // The Archive vouches for its copies with sha1 and nothing else.
  assert.deepEqual(newest.digest, {
    algorithm: "SHA-1",
    hex: "3cf6a2dfcc97e39b48ba27fa7e8dba39b3cdb325",
  });
  assert.equal(
    newest.pkgbuild,
    "https://gitlab.archlinux.org/archlinux/packaging/packages/jq/-/blob/1.7.1-2/PKGBUILD",
  );

  // The listing says nothing about dependencies or installed size;
  // those come out of the package's own .PKGINFO later, so they must
  // start null rather than empty.
  assert.equal(newest.depends, null);
  assert.equal(newest.isize, null);
  assert.equal(newest.desc, null);
});

test("an item the archive never held is an empty list", async () => {
  const { fetchJson } = fetcher({});
  assert.deepEqual(await archivedBuilds("nosuchpkg", { fetchJson }), []);
});

test("a failed metadata fetch is an empty list, not an error", async () => {
  const fetchJson = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await archivedBuilds("jq", { fetchJson }), []);
});

test("a name with dashes parses from the right", () => {
  assert.deepEqual(
    parseFilename("python-setuptools-69.0.3-1-any.pkg.tar.zst"),
    {
      name: "python-setuptools",
      version: "69.0.3-1",
      arch: "any",
      compression: "zst",
    },
  );
});

test("a version with a plus in it survives", () => {
  assert.deepEqual(
    parseFilename("glibc-2.40+r16+gaa533d58ff-1-x86_64.pkg.tar.zst"),
    {
      name: "glibc",
      version: "2.40+r16+gaa533d58ff-1",
      arch: "x86_64",
      compression: "zst",
    },
  );
});

test("an epoch keeps its colon", () => {
  assert.equal(
    parseFilename("emacs-1:26.2.2-1-x86_64.pkg.tar.xz").version,
    "1:26.2.2-1",
  );
});

test("what is not a package file does not parse", () => {
  assert.equal(parseFilename("jq-1.7.1-2-x86_64.pkg.tar.zst.sig"), null);
  assert.equal(parseFilename("archlinux_pkg_jq_meta.xml"), null);
  assert.equal(parseFilename("jq.pkg.tar.zst"), null);
  assert.equal(parseFilename(""), null);
});

test("the older compressions still parse", () => {
  assert.equal(parseFilename("bash-4.4-1-x86_64.pkg.tar.gz").compression, "gz");
  assert.equal(parseFilename("bash-4.4-1-x86_64.pkg.tar.xz").compression, "xz");
});

test("a plus in a filename is percent-encoded in the URL", async () => {
  const { fetchJson } = fetcher({
    files: [
      {
        name: "glibc-2.40+r16+gaa533d58ff-1-x86_64.pkg.tar.zst",
        size: "1",
        mtime: "1700000000",
      },
    ],
  });
  const [build] = await archivedBuilds("glibc", { fetchJson });
  // A raw "+" on the /cors/ path is read as a space and 404s.
  assert.equal(
    build.urls[0],
    "https://archive.org/cors/archlinux_pkg_glibc/glibc-2.40%2Br16%2Bgaa533d58ff-1-x86_64.pkg.tar.zst",
  );
});

test("a sibling package in the same item is not this package's history", async () => {
  // Items sometimes carry a split package's siblings; only files whose
  // parsed name is the item's name count.
  const { fetchJson } = fetcher({
    files: [
      { name: "gcc-13.2.1-1-x86_64.pkg.tar.zst", size: "1", mtime: "1" },
      { name: "gcc-libs-13.2.1-1-x86_64.pkg.tar.zst", size: "1", mtime: "1" },
    ],
  });
  const builds = await archivedBuilds("gcc", { fetchJson });
  assert.deepEqual(
    builds.map((build) => build.filename),
    ["gcc-13.2.1-1-x86_64.pkg.tar.zst"],
  );
});

test("an any-arch package is kept", async () => {
  const { fetchJson } = fetcher({
    files: [
      {
        name: "python-setuptools-69.0.3-1-any.pkg.tar.zst",
        size: "1",
        mtime: "1",
      },
      {
        name: "python-setuptools-69.0.3-1-i686.pkg.tar.zst",
        size: "1",
        mtime: "1",
      },
    ],
  });
  const builds = await archivedBuilds("python-setuptools", { fetchJson });
  assert.deepEqual(
    builds.map((build) => build.filename),
    ["python-setuptools-69.0.3-1-any.pkg.tar.zst"],
  );
});

test("an injected fetcher is never answered from the shared cache", async () => {
  const one = await archivedBuilds("cachetest", {
    fetchJson: async () => ({
      files: [
        { name: "cachetest-1-1-x86_64.pkg.tar.zst", size: "1", mtime: "1" },
      ],
    }),
  });
  const two = await archivedBuilds("cachetest", {
    fetchJson: async () => ({
      files: [
        { name: "cachetest-2-1-x86_64.pkg.tar.zst", size: "1", mtime: "1" },
      ],
    }),
  });
  assert.equal(one[0].version, "1-1");
  assert.equal(two[0].version, "2-1");
});
