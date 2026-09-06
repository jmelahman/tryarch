// One build, run in the guest from the page.
//
// The page stages the recipe and its sources on the share, types the
// driver's name at the prompt, and waits for one of the two markers
// the driver prints. On success it reads the archive the guest wrote
// into the file the page created for it, and hands back one package
// per .pkg.tar inside, in the shape fetchPackage returns, so the
// share writes it like any download. buildenv.js says why it is done
// this way.

import {
  BUILD_DIR,
  FAKEROOT_SHIM,
  MAKEPKG_CONF,
  buildMarkers,
  buildScript,
  builtBuild,
  unbundle,
} from "./buildenv.js";
import { pkgbuildBytes } from "./recipes.js";

const FOREVER = { timeoutMs: Infinity };

// The words after the failure marker, to the end of its line.
export function failureReason(transcript, marker) {
  const at = transcript.lastIndexOf(marker);
  if (at === -1) {
    return "the guest gave no reason";
  }
  const line = transcript.slice(at + marker.length).split(/\r?\n/)[0];
  return line.replace(/^:\s*/, "").trim() || "the guest gave no reason";
}

// What one build puts on the share, by path under its directory.
export function stagedFiles(item, n) {
  const files = new Map([["recipe/PKGBUILD", pkgbuildBytes(item)]]);
  for (const [name, bytes] of item.files) {
    files.set(`recipe/${name}`, bytes);
  }
  files.set("makepkg.conf", MAKEPKG_CONF);
  files.set("fakeroot", FAKEROOT_SHIM);
  files.set(
    "build.sh",
    buildScript({ n, base: item.base, version: item.recipe.version }),
  );
  // Empty, for the guest to fill: an existing file is the one thing
  // the share takes a write to.
  files.set("out.tar", new Uint8Array(0));
  return files;
}

// Build `item` as build number `n`. Resolves to the packages the guest
// made; rejects with the driver's reason when it did not. The share
// is left as it was found either way.
export async function buildInGuest(vm, item, n) {
  const dir = `${BUILD_DIR}/${n}`;
  const markers = buildMarkers(n);

  vm.stage(dir, stagedFiles(item, n));
  try {
    // Both waiters are armed before the command is typed: a driver that
    // fails at once must not print its marker before anyone listens.
    const outcome = Promise.race([
      vm.waitFor(markers.done, FOREVER).then(() => "done"),
      vm.waitFor(markers.failed, FOREVER).then(() => "failed"),
    ]);
    vm.type(`bash /share/${dir}/build.sh`);

    if ((await outcome) === "failed") {
      throw new Error(failureReason(vm.transcript(), markers.failed));
    }

    return unbundle(vm.readFile(`${dir}/out.tar`)).map((pkg) => ({
      build: builtBuild(pkg, { pkgbuild: item.page }),
      meta: pkg.meta,
      entries: pkg.entries,
      install: pkg.install,
      // Nothing came over the network; the package is the archive the
      // guest wrote, and that is its size.
      compressed: null,
      unpacked: pkg.size,
    }));
  } finally {
    vm.unstage(dir);
  }
}
