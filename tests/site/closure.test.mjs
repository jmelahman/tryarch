// Tests the closure walk's `wants`: what a recipe needs in the guest
// without being a root — its dependencies, makepkg, a compiler — is
// resolved and fetched beside the roots, reported under the recipe's
// name when it cannot be, and skipped when the guest already has it.
//
// The index is a handful of shards behind an injected fetcher, and the
// packages are uncompressed tars served by a fake fetch, so the walk
// runs the real fetchPackage end to end without a decoder.
import { test } from "node:test";
import assert from "node:assert/strict";

import { walkClosure } from "../../site/js/closure.js";
import { current, setFetcher, shardOf } from "../../site/js/index.js";
import { fakeCaches, tar } from "./tarball.mjs";

fakeCaches();

const DEPENDS = {
  app: ["libfoo"],
  libfoo: [],
  bash: [],
  pacman: [],
  gcc: [],
};
const PROVIDES = { bash: ["sh"] };

const ENTRIES = Object.fromEntries(
  Object.entries(DEPENDS).map(([name, depends]) => [
    name,
    {
      v: "1-1",
      r: name === "app" ? "extra" : "core",
      f: `${name}-1-1-x86_64.pkg.tar`,
      d: depends,
      p: PROVIDES[name] ?? [],
      base: name,
      desc: name,
    },
  ]),
);

function indexFiles() {
  const files = new Map([
    [
      "index/names.json",
      {
        generated: "2026-09-05T06:00:00Z",
        count: Object.keys(ENTRIES).length,
        repos: ["core", "extra"],
        names: Object.fromEntries(
          Object.keys(ENTRIES).map((name) => [name, name]),
        ),
      },
    ],
  ]);
  const bucket = (dir, key, value) => {
    const path = `index/${dir}/${shardOf(key)}.json`;
    const held = files.get(path) ?? {};
    held[key] = value;
    files.set(path, held);
  };
  for (const [name, entry] of Object.entries(ENTRIES)) {
    bucket("pkgs", name, entry);
  }
  bucket("provides", "sh", ["bash"]);
  return files;
}

setFetcher(async (url) => {
  const json = indexFiles().get(url);
  return json === undefined
    ? new Response("not found", { status: 404 })
    : new Response(JSON.stringify(json), { status: 200 });
});

// One package per entry, as the mirrors would serve it.
const PACKAGES = new Map(
  Object.entries(DEPENDS).map(([name, depends]) => [
    `${name}-1-1-x86_64.pkg.tar`,
    tar({
      ".PKGINFO": [
        `pkgname = ${name}`,
        "pkgver = 1-1",
        ...depends.map((dep) => `depend = ${dep}`),
        ...(PROVIDES[name] ?? []).map((one) => `provides = ${one}`),
        "",
      ].join("\n"),
      "usr/": "",
      "usr/bin/": "",
      [`usr/bin/${name}`]: `#!/bin/sh\necho ${name}\n`,
    }),
  ]),
);

const fetched = [];
globalThis.fetch = async (url) => {
  const bytes = PACKAGES.get(url.split("/").pop());
  if (bytes === undefined) {
    return new Response("not found", { status: 404 });
  }
  fetched.push(url.split("/").pop());
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Length": String(bytes.byteLength) },
  });
};

async function walk(roots, options) {
  fetched.length = 0;
  const unpacked = [];
  const result = await walkClosure(roots, {
    ...options,
    onPackage: async (pkg) => {
      unpacked.push(pkg.build.name);
    },
  });
  return { ...result, unpacked };
}

const names = (builds) => new Set(builds.map((build) => build.name));

test("the wants are fetched beside the roots", async () => {
  const app = await current("app");
  const { builds, problems, unpacked } = await walk([app], {
    wants: [{ via: "hello", specs: ["sh", "pacman"] }],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(names(builds), new Set(["app", "libfoo", "bash", "pacman"]));
  assert.deepEqual(new Set(unpacked), names(builds));
  // The roots' own closure is unchanged by what the recipe wants.
  assert.ok(!fetched.includes("gcc-1-1-x86_64.pkg.tar"));
});

test("a page with only recipes selected still gets its tools", async () => {
  const { builds, problems } = await walk([], {
    wants: [{ via: "hello", specs: ["pacman", "gcc"] }],
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(names(builds), new Set(["pacman", "gcc"]));
});

test("a want nobody provides is the recipe's problem", async () => {
  const app = await current("app");
  const { builds, problems } = await walk([app], {
    wants: [{ via: "hello", specs: ["nothing-such", "sh"] }],
  });
  assert.deepEqual(problems, [
    "nothing provides nothing-such (wanted by hello)",
  ]);
  assert.deepEqual(names(builds), new Set(["app", "libfoo", "bash"]));
});

test("what the guest already has is not fetched again", async () => {
  const app = await current("app");
  const pacman = await current("pacman");
  const bash = await current("bash");
  const { builds, problems } = await walk([app], {
    known: new Map([
      ["pacman", pacman],
      ["bash", bash],
    ]),
    wants: [{ via: "hello", specs: ["pacman", "sh", "bash>=2"] }],
  });
  assert.deepEqual(names(builds), new Set(["app", "libfoo"]));
  assert.deepEqual(problems, [
    "hello wants bash>=2, bash 1-1 is in the closure",
  ]);
});
