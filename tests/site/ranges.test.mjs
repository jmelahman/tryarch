// Tests the spec lane: the line a reader types. Both spellings have to
// parse — the site's "jq@>=1.7" and the pacman "jq>=1.7" a reader has
// in front of them in a PKGBUILD — and a spec that cannot be answered
// has to come back as prose rather than as a thrown error.
import { test } from "node:test";
import assert from "node:assert/strict";

import { matches, parseSpecs, resolveSpecs } from "../../site/js/ranges.js";
import { setFetcher } from "../../site/js/index.js";

const build = (version) => ({ name: "jq", version, builddate: null });

test("parseSpecs reads a bare name", () => {
  assert.deepEqual(parseSpecs("jq"), [
    { raw: "jq", name: "jq", op: null, version: null },
  ]);
});

test("parseSpecs reads both spellings of a constraint", () => {
  assert.deepEqual(parseSpecs("jq@>=1.7"), [
    { raw: "jq@>=1.7", name: "jq", op: ">=", version: "1.7" },
  ]);
  assert.deepEqual(parseSpecs("jq>=1.7"), [
    { raw: "jq>=1.7", name: "jq", op: ">=", version: "1.7" },
  ]);
  assert.deepEqual(parseSpecs("jq@1.7.1-2"), [
    { raw: "jq@1.7.1-2", name: "jq", op: null, version: "1.7.1-2" },
  ]);
});

test("parseSpecs splits on whitespace and commas", () => {
  assert.deepEqual(
    parseSpecs("  jq  bash@>=5.2,\n python@3.11.* ").map((spec) => spec.name),
    ["jq", "bash", "python"],
  );
  assert.deepEqual(parseSpecs(""), []);
  assert.deepEqual(parseSpecs(null), []);
});

test("parseSpecs keeps a name with dashes and a version with an epoch", () => {
  assert.deepEqual(parseSpecs("python-setuptools"), [
    {
      raw: "python-setuptools",
      name: "python-setuptools",
      op: null,
      version: null,
    },
  ]);
  const [emacs] = parseSpecs("emacs@1:26.2.2-1");
  assert.equal(emacs.name, "emacs");
  assert.equal(emacs.version, "1:26.2.2-1");
});

test("a bare name matches anything", () => {
  const [spec] = parseSpecs("jq");
  assert.equal(matches(build("1.0-1"), spec), true);
});

test("a version with no operator is a pin", () => {
  const [spec] = parseSpecs("jq@1.7.1-2");
  assert.equal(matches(build("1.7.1-2"), spec), true);
  assert.equal(matches(build("1.7.1-1"), spec), false);
  // pacman's own rule: a constraint with no release ignores the
  // candidate's release.
  const [loose] = parseSpecs("jq@1.7.1");
  assert.equal(matches(build("1.7.1-2"), loose), true);
  assert.equal(matches(build("1.7.1-9"), loose), true);
  assert.equal(matches(build("1.7-1"), loose), false);
});

test("an operator compares like pacman", () => {
  const [ge] = parseSpecs("jq>=1.7");
  assert.equal(matches(build("1.7.1-2"), ge), true);
  assert.equal(matches(build("1.6-1"), ge), false);

  const [lt] = parseSpecs("jq<1.7");
  assert.equal(matches(build("1.6-1"), lt), true);
  assert.equal(matches(build("1.7-1"), lt), false);
});

test("a star is a prefix match on the version", () => {
  const [spec] = parseSpecs("python@3.11.*");
  assert.equal(matches({ version: "3.11.9-1" }, spec), true);
  assert.equal(matches({ version: "3.11-1" }, spec), false);
  assert.equal(matches({ version: "3.12.1-1" }, spec), false);

  const [major] = parseSpecs("python@3.*");
  assert.equal(matches({ version: "3.11.9-1" }, major), true);
  assert.equal(matches({ version: "3" }, major), true);
  assert.equal(matches({ version: "4.0-1" }, major), false);
});

// --- resolving against the index ----------------------------------------

const NAMES = {
  generated: null,
  count: 2,
  repos: ["core", "extra"],
  names: { jq: "Command-line JSON processor", bash: "Shell" },
};

const SHARDS = {
  jq: {
    v: "1.8.2-1",
    r: "extra",
    f: "jq-1.8.2-1-x86_64.pkg.tar.zst",
    b: 1781975439,
    base: "jq",
    d: [],
    p: [],
    desc: "Command-line JSON processor",
  },
  bash: {
    v: "5.3.3-1",
    r: "core",
    f: "bash-5.3.3-1-x86_64.pkg.tar.zst",
    b: 1780000000,
    base: "bash",
    d: [],
    p: [],
    desc: "Shell",
  },
};

setFetcher(async (url) => {
  if (url === "index/names.json") {
    return new Response(JSON.stringify(NAMES), { status: 200 });
  }
  if (url.startsWith("index/pkgs/")) {
    return new Response(JSON.stringify(SHARDS), { status: 200 });
  }
  return new Response("not found", { status: 404 });
});

const ARCHIVE = {
  jq: {
    files: [
      { name: "jq-1.6-1-x86_64.pkg.tar.xz", size: "1", mtime: "1554203679" },
      { name: "jq-1.7.1-2-x86_64.pkg.tar.zst", size: "1", mtime: "1717881277" },
    ],
  },
};

globalThis.fetch = async (url) => {
  const name = url.split("archlinux_pkg_")[1];
  const item = ARCHIVE[name];
  return item === undefined
    ? new Response("not found", { status: 404 })
    : new Response(JSON.stringify(item), { status: 200 });
};

test("resolveSpecs takes the newest match for each spec", async () => {
  const { resolved, problems } = await resolveSpecs(parseSpecs("jq bash"));
  assert.deepEqual(problems, []);
  assert.deepEqual(
    resolved.map((one) => `${one.name}@${one.version}`),
    ["jq@1.8.2-1", "bash@5.3.3-1"],
  );
});

test("resolveSpecs reaches into the archive for an old constraint", async () => {
  const { resolved, problems } = await resolveSpecs(parseSpecs("jq@<1.8"));
  assert.deepEqual(problems, []);
  assert.equal(resolved[0].version, "1.7.1-2");
  assert.equal(resolved[0].repo, "archive");
});

test("a name in no repo is a problem, not a throw", async () => {
  const { resolved, problems } = await resolveSpecs(parseSpecs("nosuchpkg"));
  assert.deepEqual(resolved, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nosuchpkg is in no repo/);
});

test("a constraint nothing matches is a problem naming it", async () => {
  const { resolved, problems } = await resolveSpecs(parseSpecs("jq@>=99"));
  assert.deepEqual(resolved, []);
  assert.match(problems[0], /no version of jq matches >=99/);
});

test("the good specs still resolve when one fails", async () => {
  const { resolved, problems } = await resolveSpecs(
    parseSpecs("jq nosuchpkg bash"),
  );
  assert.deepEqual(
    resolved.map((one) => one.name),
    ["jq", "bash"],
  );
  assert.equal(problems.length, 1);
});
