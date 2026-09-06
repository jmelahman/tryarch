// Tests one build's round trip through a stand-in guest: what lands on
// the share, that the page is listening before it types, and how the
// guest's answer — the archive, or the reason — comes back.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildInGuest,
  failureReason,
  stagedFiles,
} from "../../site/js/build.js";
import { buildMarkers } from "../../site/js/buildenv.js";
import { tar } from "./tarball.mjs";

const decode = (bytes) => new TextDecoder().decode(bytes);

const INNER = tar({
  ".PKGINFO": "pkgname = hello\npkgver = 1.0.0-1\ndepend = sh\n",
  "usr/": "",
  "usr/bin/": "",
  "usr/bin/hello": "#!/bin/sh\necho hello\n",
});
const OUT = tar({ "./": "", "./hello-1.0.0-1-any.pkg.tar": INNER });

const item = () => ({
  base: "hello",
  recipe: { version: "1.0.0-1" },
  pkgbuild: "pkgname=hello\n",
  page: "https://example.org/hello/PKGBUILD",
  files: new Map([["hello.patch", new TextEncoder().encode("--- a\n")]]),
});

// A guest that answers the driver the way the real one does: prints
// the marker `outcome` says once the command is typed, with `reason`
// after a failure.
function fakeVM({ outcome, reason = "", out = OUT }) {
  const calls = [];
  const waiters = new Map();
  let transcript = "$ ";
  return {
    calls,
    stage(dir, files) {
      calls.push(["stage", dir, files]);
    },
    waitFor(marker) {
      return new Promise((resolve) => waiters.set(marker, resolve));
    },
    type(line) {
      calls.push(["type", line, [...waiters.keys()]]);
      const n = Number(line.match(/tryarch\/(\d+)\//)[1]);
      const markers = buildMarkers(n);
      const printed =
        outcome === "done" ? markers.done : `${markers.failed}: ${reason}`;
      transcript += `${line}\r\n${printed}\r\n$ `;
      waiters.get(outcome === "done" ? markers.done : markers.failed)(true);
    },
    readFile(path) {
      calls.push(["readFile", path]);
      return out;
    },
    unstage(dir) {
      calls.push(["unstage", dir]);
    },
    transcript: () => transcript,
  };
}

test("failureReason is what follows the last marker", () => {
  const { failed } = buildMarkers(2);
  assert.equal(
    failureReason(`x\r\n${failed}: makepkg exited 2\r\n$ `, failed),
    "makepkg exited 2",
  );
  assert.equal(
    failureReason(`${failed}: first\n${failed}: second\n`, failed),
    "second",
  );
  assert.equal(
    failureReason("nothing here", failed),
    "the guest gave no reason",
  );
  assert.equal(
    failureReason(`${failed}\n`, failed),
    "the guest gave no reason",
  );
});

test("stagedFiles is the recipe, its files, and the tools", () => {
  const files = stagedFiles(item(), 4);
  assert.deepEqual(
    [...files.keys()],
    [
      "recipe/PKGBUILD",
      "recipe/hello.patch",
      "makepkg.conf",
      "fakeroot",
      "build.sh",
      "out.tar",
    ],
  );
  assert.equal(decode(files.get("recipe/PKGBUILD")), "pkgname=hello\n");
  assert.ok(files.get("build.sh").includes("/share/tryarch/4"));
  assert.equal(files.get("out.tar").byteLength, 0);
});

test("a build that succeeds comes back as packages", async () => {
  const vm = fakeVM({ outcome: "done" });
  const packages = await buildInGuest(vm, item(), 7);

  assert.equal(packages.length, 1);
  const [pkg] = packages;
  assert.equal(pkg.build.name, "hello");
  assert.equal(pkg.build.repo, "built");
  assert.equal(pkg.build.pkgbuild, "https://example.org/hello/PKGBUILD");
  assert.equal(pkg.compressed, null);
  assert.equal(pkg.unpacked, INNER.byteLength);
  assert.deepEqual(pkg.meta.depends, ["sh"]);
  assert.equal(pkg.install, null);
  assert.equal(pkg.entries.at(-1).path, "usr/bin/hello");

  const names = vm.calls.map((call) => call[0]);
  assert.deepEqual(names, ["stage", "type", "readFile", "unstage"]);
  assert.equal(vm.calls[0][1], "tryarch/7");
  assert.equal(vm.calls[1][1], "bash /share/tryarch/7/build.sh");
  // Both markers were being waited for before the command went in.
  const { done, failed } = buildMarkers(7);
  assert.deepEqual(vm.calls[1][2], [done, failed]);
  assert.equal(vm.calls[2][1], "tryarch/7/out.tar");
  assert.equal(vm.calls[3][1], "tryarch/7");
});

test("a build that fails rejects with the driver's reason", async () => {
  const vm = fakeVM({ outcome: "failed", reason: "makepkg exited 2" });
  await assert.rejects(
    buildInGuest(vm, item(), 8),
    /^Error: makepkg exited 2$/,
  );
  // The share is cleaned up either way.
  assert.deepEqual(vm.calls.at(-1), ["unstage", "tryarch/8"]);
  assert.ok(!vm.calls.some((call) => call[0] === "readFile"));
});

test("an archive with no package in it is a failure too", async () => {
  const vm = fakeVM({ outcome: "done", out: tar({ "./": "" }) });
  await assert.rejects(buildInGuest(vm, item(), 9), /handed back no package/);
  assert.deepEqual(vm.calls.at(-1), ["unstage", "tryarch/9"]);
});
