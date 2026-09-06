// Tests the merge of the three version sources and the era rule.
//
// The era rule is the part that matters for a boot: a 2018 package
// linked against a 2026 glibc does not run, so a dependency resolved
// while booting an old build has to prefer a build of its own time —
// but prefer, not require, because the archive does not have everything.
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickBuild, versionsOf } from "../../site/js/versions.js";
import { setFetcher } from "../../site/js/index.js";

// --- pickBuild ----------------------------------------------------------

const build = (version, builddate = null) => ({
  name: "x",
  version,
  builddate,
  repo: "extra",
});

const NEW = 1_700_000_000; // 2023
const OLD = 1_500_000_000; // 2017

test("pickBuild takes the newest that satisfies", () => {
  const builds = [build("1.0-1"), build("2.0-1"), build("1.5-1")];
  assert.equal(pickBuild(builds, null).version, "2.0-1");
  assert.equal(
    pickBuild(builds, { op: ">=", version: "1.5" }).version,
    "2.0-1",
  );
  assert.equal(pickBuild(builds, { op: "<", version: "2.0" }).version, "1.5-1");
  assert.equal(
    pickBuild(builds, { op: "=", version: "1.0-1" }).version,
    "1.0-1",
  );
});

test("nothing that satisfies is null, not a throw", () => {
  assert.equal(pickBuild([], null), null);
  assert.equal(pickBuild([build("1.0-1")], { op: ">=", version: "9" }), null);
});

test("an era prefers a build of its own time", () => {
  const builds = [build("1.0-1", OLD), build("2.0-1", NEW)];
  assert.equal(pickBuild(builds, null).version, "2.0-1");
  assert.equal(pickBuild(builds, null, { before: OLD + 1 }).version, "1.0-1");
  // The era is the boot's build date, so the build itself qualifies.
  assert.equal(pickBuild(builds, null, { before: NEW }).version, "2.0-1");
});

test("an era is a preference, not a filter", () => {
  // Nothing old enough: today's build is better than no dependency.
  const builds = [build("2.0-1", NEW), build("3.0-1", NEW + 1)];
  assert.equal(pickBuild(builds, null, { before: OLD }).version, "3.0-1");

  // Builds with no date at all (a pasted repo's) are still usable.
  const undated = [build("1.0-1"), build("2.0-1")];
  assert.equal(pickBuild(undated, null, { before: OLD }).version, "2.0-1");
});

test("the era applies within the constraint, not around it", () => {
  const builds = [
    build("1.0-1", OLD),
    build("2.0-1", OLD + 1),
    build("3.0-1", NEW),
  ];
  const hit = pickBuild(
    builds,
    { op: ">=", version: "2.0" },
    { before: OLD + 10 },
  );
  assert.equal(hit.version, "2.0-1");
});

// --- versionsOf ---------------------------------------------------------

const INDEX = {
  generated: null,
  count: 1,
  repos: ["extra"],
  names: { jq: "Command-line JSON processor" },
};

const CURRENT = {
  jq: {
    v: "1.8.2-1",
    r: "extra",
    f: "jq-1.8.2-1-x86_64.pkg.tar.zst",
    cs: 213086,
    is: 492406,
    sha: "35f1",
    b: 1781975439,
    d: ["glibc", "oniguruma"],
    p: [],
    base: "jq",
    desc: "Command-line JSON processor",
  },
};

setFetcher(async (url) => {
  if (url === "index/names.json") {
    return new Response(JSON.stringify(INDEX), { status: 200 });
  }
  if (url.startsWith("index/pkgs/")) {
    return new Response(JSON.stringify(CURRENT), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

// The archive lane goes through the page's own fetch.
const ARCHIVE = {
  files: [
    {
      name: "jq-1.6-1-x86_64.pkg.tar.xz",
      size: "206144",
      mtime: "1554203679",
      sha1: "a4de",
    },
    {
      name: "jq-1.7.1-2-x86_64.pkg.tar.zst",
      size: "294184",
      mtime: "1717881277",
      sha1: "3cf6",
    },
    // The same version the index still serves: the mirror copy wins.
    {
      name: "jq-1.8.2-1-x86_64.pkg.tar.zst",
      size: "213086",
      mtime: "1781975439",
      sha1: "35f1",
    },
  ],
};

globalThis.fetch = async (url) =>
  url.includes("/metadata/archlinux_pkg_jq")
    ? new Response(JSON.stringify(ARCHIVE), { status: 200 })
    : new Response("not found", { status: 404 });

test("versionsOf merges the repos and the archive, newest first", async () => {
  const builds = await versionsOf("jq");
  assert.deepEqual(
    builds.map((one) => one.version),
    ["1.8.2-1", "1.7.1-2", "1.6-1"],
  );

  // A version both sources have is the mirror's: fetching it from
  // archive.org when a mirror still serves it would be rude and slow.
  assert.equal(builds[0].repo, "extra");
  assert.equal(builds[1].repo, "archive");
  assert.equal(builds[2].repo, "archive");
});

test("versionsOf memoises", async () => {
  assert.equal(await versionsOf("jq"), await versionsOf("jq"));
});

test("a name nothing has is an empty list", async () => {
  assert.deepEqual(await versionsOf("nosuchpackage"), []);
});
