// Page wiring: choose Arch packages out of the site's index — by
// search, by version spec, or from an extra repository — walk the union
// of their dependency closures live from the mirrors and archive.org,
// then boot. qemu-wasm runs an x86_64 guest in the tab, the packages
// ride in over virtio-9p, and the serial console lands in the terminal.
// docs/design.md holds the architecture.

import { walkClosure } from "./closure.js";
import { startVM } from "./boot.js";
import { fetchWithProgress, warmHttpCache } from "./net.js";
import { ProgressPanel } from "./progress.js";
import { PackagePicker, repoClass } from "./search.js";
import { parseSpecs, resolveSpecs } from "./ranges.js";
import { versionsOf } from "./versions.js";
import { addRepo, current, indexInfo } from "./index.js";
import { fetchRepoDb } from "./repodb.js";
import { RangeComplete } from "./complete.js";
import { readUrl, writeUrl } from "./url.js";
import { humanBytes } from "./format.js";
import {
  GUEST_FILES,
  MACHINE_URL,
  QEMU_MAIN,
  QEMU_WASM,
  QEMU_WORKER,
  SNAPSHOT_URL,
} from "./config.js";
import { asset, assets, manifest } from "./assets.js";
import { buildReport } from "./report.js";
import { log, onLog } from "./log.js";

const specsForm = document.getElementById("specs-form");
const specsInput = document.getElementById("specs-input");
const specsResults = document.getElementById("specs-results");
const reposInput = document.getElementById("repos-input");
const reposStatus = document.getElementById("repos-status");
const selectionElement = document.getElementById("selection");
const status = document.getElementById("status");
const result = document.getElementById("result");
const bootButton = document.getElementById("boot-button");
const bootSection = document.getElementById("boot");
const bootProgress = document.getElementById("boot-progress");
const terminalElement = document.getElementById("terminal");
const keyBarElement = document.getElementById("keybar");
const consoleVeil = document.getElementById("console-veil");
const consoleNote = document.getElementById("console-note");
const rebootLink = document.getElementById("reboot-link");
const debugLog = document.getElementById("debug-log");
const addNote = document.getElementById("add-note");
const indexInfoElement = document.getElementById("index-info");

// The selection: name -> { build, pinned }. One version per name, the
// way pacman installs one; choosing another version of a selected
// package replaces it. `pinned` says whether the reader asked for this
// exact version or for "the newest", which is what the link records.
const selection = new Map();

const keyOf = (build) => `${build.name}@${build.version}`;

function select(build, { pinned }) {
  selection.set(build.name, { build, pinned });
  render();
}

function deselect(name) {
  selection.delete(name);
  render();
}

// The extra repositories in effect: what the repos lane says, and what
// the link carries. Each is a pacman db on a host that sends CORS
// headers; its packages take precedence over the index.
let extraRepos = [];

// The link for what is on screen: the selection and the repositories.
function urlState() {
  return {
    pkgs: [...selection.values()].map(({ build, pinned }) => ({
      name: build.name,
      version: pinned ? build.version : null,
    })),
    repos: extraRepos,
  };
}

// A build's date, for telling one archived version from another.
function dateOf(build) {
  if (build.builddate === null || build.builddate === undefined) {
    return "";
  }
  return new Date(build.builddate * 1000).toISOString().slice(0, 10);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

// One row of the selection: the name, a version menu, the repository
// chip, the PKGBUILD that built it, and a way to drop it. The menu
// starts with the one version known and fills in as the full list —
// current repos plus the Arch Linux Archive — arrives.
function selectionRow({ build, pinned }) {
  const versions = el("select", { className: "version" });
  versions.setAttribute("aria-label", `${build.name} version`);
  const option = (b) =>
    el(
      "option",
      { value: b.version },
      `${b.version} · ${b.repo}${b.repo === "archive" ? ` ${dateOf(b)}` : ""}`,
    );
  versions.append(option(build));
  versions.value = build.version;

  versionsOf(build.name).then(
    (all) => {
      if (selection.get(build.name)?.build !== build) {
        return;
      }
      versions.replaceChildren(...all.map(option));
      versions.value = build.version;
      versions.onchange = () => {
        const chosen = all.find((b) => b.version === versions.value);
        if (chosen !== undefined) {
          select(chosen, { pinned: true });
        }
      };
    },
    (err) => log(`versions of ${build.name}: ${err.message}`),
  );

  const row = el(
    "div",
    { className: "pick" },
    el("span", { className: "pkg" }, build.name),
    versions,
    el("span", { className: repoClass(build.repo) }, build.repo),
    el("a", {
      className: "pkgbuild",
      href: build.pkgbuild,
      target: "_blank",
      rel: "noopener",
      textContent: "PKGBUILD",
    }),
    el("button", {
      type: "button",
      className: "remove",
      textContent: "×",
      onclick: () => deselect(build.name),
    }),
  );
  row.dataset.key = keyOf(build);
  row.title = pinned
    ? `${build.name} ${build.version}`
    : `${build.name}, newest`;
  return row;
}

// The rows, the status line, and the address bar all describe the same
// selection, so they are redrawn together.
function render() {
  const entries = [...selection.values()];
  selectionElement.replaceChildren(...entries.map(selectionRow));

  bootButton.disabled = entries.length === 0;
  status.textContent = entries.length === 0 ? "nothing selected yet" : "";

  history.replaceState(null, "", writeUrl(urlState()));
}

// The debug pane mirrors the log as it is written.
onLog((lines) => {
  debugLog.textContent = lines.join("\n");
  debugLog.scrollTop = debugLog.scrollHeight;
});

// ---------- the three lanes ----------

// Picking a name takes its newest build, which is what the index has.
async function selectName(name) {
  const build = await current(name);
  if (build === null) {
    status.textContent = `${name} is not in the index`;
    return;
  }
  select(build, { pinned: false });
}

new PackagePicker({
  input: document.getElementById("search"),
  results: document.getElementById("search-results"),
  onPick: (hit) => selectName(hit.name),
});

specsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  specsResults.replaceChildren();

  let specs;
  try {
    specs = parseSpecs(specsInput.value);
  } catch (err) {
    specsResults.textContent = String(err);
    return;
  }

  specsResults.textContent = "resolving…";
  const { resolved, problems } = await resolveSpecs(specs);
  for (const build of resolved) {
    select(build, { pinned: true });
  }

  const lines = [
    ...resolved.map((b) => `${b.name} ${b.version} (${b.repo})`),
    ...problems.map((p) => `unresolved: ${p}`),
  ];
  specsResults.textContent = lines.join(" · ");
});

new RangeComplete({
  input: specsInput,
  dropdown: document.getElementById("specs-complete"),
  onAccept: () => {},
});

// The repository list: one db URL per line. Each that loads is
// registered under the db's basename and goes into the link; one that
// does not is said so and leaves the others in effect.
function labelOf(url) {
  const base = url.split("/").pop() ?? url;
  return base.replace(/\.db(\.tar(\.\w+)?)?$/, "") || url;
}

async function applyRepos(urls) {
  const loaded = [];
  const notes = [];
  for (const url of urls) {
    try {
      const entries = await fetchRepoDb(url);
      addRepo(labelOf(url), url, entries);
      loaded.push(url);
      notes.push(`${labelOf(url)}: ${entries.size} packages`);
    } catch (err) {
      notes.push(`${url}: ${err.message}`);
      log(`repository ${url}: ${err.message}`);
    }
  }
  extraRepos = loaded;
  reposStatus.textContent = notes.join(" · ");
  render();
}

reposInput.addEventListener("change", () => {
  const urls = reposInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  applyRepos(urls);
});

// The lane tabs: buttons, one panel visible at a time.
const laneNav = document.getElementById("lanes");
laneNav.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-lane]");
  if (tab === null) {
    return;
  }
  for (const button of laneNav.querySelectorAll("[data-lane]")) {
    const active = button === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const lane of ["search", "specs", "repos"]) {
    document.getElementById(`lane-${lane}`).hidden = lane !== tab.dataset.lane;
  }
});

// ---------- the boot ----------

// What the guest has, by name: the build, and what its package weighed.
// A later addition only fetches what is new, and the report and the
// table read from here.
let mounted = new Map();

function recordPackage(pkg) {
  const unpacked = pkg.entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
  mounted.set(pkg.build.name, {
    build: pkg.build,
    compressed: pkg.compressed,
    unpacked,
    files: pkg.entries.length,
  });
}

// The closure as a table, largest unpacked size first, each version
// linked to the PKGBUILD that built it.
function renderClosure() {
  const rows = [...mounted.values()].sort((a, b) => b.unpacked - a.unpacked);

  const table = el("table", { className: "closure" });
  const head = table.createTHead().insertRow();
  for (const [label, cls] of [
    ["package", "pkg"],
    ["version", "version"],
    ["repo", "repo"],
    ["download", "size"],
    ["unpacked", "size"],
    ["", "pkgbuild"],
  ]) {
    head.append(el("th", { textContent: label, className: cls }));
  }

  const body = table.createTBody();
  for (const { build, compressed, unpacked } of rows) {
    const row = body.insertRow();
    row.append(
      el("td", { className: "pkg" }, build.name),
      el("td", { className: "version" }, build.version),
      el(
        "td",
        {},
        el("span", { className: repoClass(build.repo) }, build.repo),
      ),
      el("td", { className: "size" }, humanBytes(compressed ?? 0)),
      el("td", { className: "size" }, humanBytes(unpacked)),
      el(
        "td",
        {},
        el("a", {
          href: build.pkgbuild,
          target: "_blank",
          rel: "noopener",
          textContent: "PKGBUILD",
        }),
      ),
    );
  }

  result.replaceChildren(table);
}

// Say which selections put nothing on PATH, and what could not be
// resolved. Neither stops the boot: a library package has no programs
// by design, and a missing dependency is often one the program never
// touches.
function reportOutcome(vm, roots, problems) {
  const silent = roots
    .filter((build) => vm.programsOf(build.name).length === 0)
    .map((build) => build.name);
  const notes = [];
  if (silent.length > 0) {
    notes.push(`no programs in /usr/bin from ${silent.join(", ")}`);
  }
  if (problems.length > 0) {
    notes.push(...problems);
    for (const problem of problems) {
      log(`closure: ${problem}`);
    }
  }
  status.textContent = notes.join(" · ");
}

// A booted VM cannot be replaced in place: the emscripten module owns
// its worker pool and linear memory for the life of the page. So a
// second boot restarts the page instead, at a URL that describes the
// new selection and asks for it to start straight away.
let vmStarted = false;
let vm = null;
// How the guest started, for the report.
let bootMode = "not started";

function reboot() {
  location.href = writeUrl(urlState(), { boot: true });
  location.reload();
}

const selectedBuilds = () => [...selection.values()].map((e) => e.build);

// The boot flow. The engine, the guest image, the snapshot and the
// packages download in parallel under one progress panel; the engine
// is instantiated the moment its inputs are in, and every package is
// written into the share as it lands, while the rest are still on
// their way. When the last one is in, QEMU is released and the
// terminal goes live.
async function boot() {
  bootSection.hidden = false;
  bootButton.disabled = true;
  consoleVeil.hidden = false;
  consoleNote.textContent = "fetching…";
  const panel = new ProgressPanel(bootProgress);

  const engineRow = panel.row("qemu engine");
  const guestRow = panel.row("guest image");
  const snapshotRow = panel.row("snapshot");
  const packagesRow = panel.row("packages");
  const vmRow = panel.row("virtual machine");

  try {
    const engineUrls = await assets([QEMU_MAIN, QEMU_WASM, QEMU_WORKER]);
    const engine = {
      main: engineUrls.get(QEMU_MAIN),
      // emscripten asks for files by bare name; hand back the
      // versioned URL when there is one.
      locate: (file) => engineUrls.get(`qemu/${file}`) ?? `qemu/${file}`,
    };

    // The wasm is not held by the page: the engine streams it from
    // the URL and the browser compiles it as it arrives (net.js says
    // why). This download only fills the HTTP cache, and the bar.
    const enginePromise = warmHttpCache(engineUrls.get(QEMU_WASM), {
      onTotal: (n) => engineRow.setTotal(n),
      onBytes: (n) => engineRow.add(n),
    }).then(() => engineRow.done());

    const machinePromise = fetch(await asset(MACHINE_URL)).then((res) => {
      if (!res.ok) {
        throw new Error(`${MACHINE_URL}: HTTP ${res.status}`);
      }
      return res.json();
    });

    const guestPromise = Promise.all(
      GUEST_FILES.map(async (name) => [
        name,
        await fetchWithProgress(await asset(`guest/${name}`), {
          onBytes: (n) => guestRow.add(n),
        }),
      ]),
    ).then((entries) => {
      guestRow.done();
      return new Map(entries);
    });

    // The snapshot is optional: published, a visit resumes a guest that
    // is already up; absent, the same arguments cold-boot.
    const snapshotPromise = fetchWithProgress(await asset(SNAPSHOT_URL), {
      onTotal: (n) => snapshotRow.setTotal(n),
      onBytes: (n) => snapshotRow.add(n),
    }).then(
      (bytes) => {
        snapshotRow.done();
        return bytes;
      },
      () => {
        snapshotRow.done("none published — cold boot");
        return null;
      },
    );

    // The engine starts as soon as its own inputs are in, without
    // waiting for the packages; the guest files and the snapshot are
    // handed over rather than kept.
    let resuming = false;
    const vmPromise = Promise.all([
      enginePromise,
      guestPromise,
      machinePromise,
      snapshotPromise,
    ]).then(([, guestFiles, machine, snapshot]) => {
      resuming = snapshot !== null;
      bootMode = resuming ? "resumed from the snapshot" : "cold booted";
      log(
        snapshot === null
          ? "no snapshot; the guest will cold boot"
          : "engine instantiated; the guest will resume from the snapshot",
      );
      return startVM({
        guestFiles,
        machine,
        snapshot,
        terminalElement,
        keyBarElement,
        engine,
      });
    });

    // Each package goes into the share the moment it is unpacked, and
    // is dropped from the page's hands right after. Nothing here ever
    // holds more than the few packages in flight.
    const roots = selectedBuilds();
    let discovered = 0;
    const { builds, problems } = await walkClosure(roots, {
      onDiscover: () => {
        discovered += 1;
      },
      onTotal: (n) => packagesRow.setTotal(n),
      onBytes: (n) => packagesRow.add(n),
      onPackage: async (pkg) => {
        const vm = await vmPromise;
        vm.share.write(pkg);
        recordPackage(pkg);
        renderClosure();
      },
    });
    packagesRow.done(`${builds.length} packages`);
    log(
      `closure: ${builds.length} packages from ${roots.length} roots` +
        (problems.length > 0 ? `, ${problems.length} problems` : ""),
    );

    vm = await vmPromise;

    consoleNote.textContent = resuming
      ? "resuming the guest…"
      : "booting the guest…";
    // The bar fills when the guest is at its prompt; until then the row
    // says what the guest is doing, not that it is done.
    vmRow.note(resuming ? "resuming…" : "booting…");
    vmStarted = true;

    const ready = vm.run();
    log("virtual machine running");
    reportOutcome(vm, roots, problems);
    bootButton.textContent = "Add to the running VM";
    rebootLink.hidden = false;
    addNote.hidden = false;
    bootButton.disabled = false;

    await ready;
    log("guest at its prompt");
    vmRow.done("running");
    consoleVeil.hidden = true;
  } catch (err) {
    log(`boot failed: ${err.message}`);
    vmRow.fail(String(err));
    status.textContent = `${err} — see the debug log`;
    document.getElementById("debug").open = true;
    bootButton.disabled = false;
  }
}

bootButton.addEventListener("click", () => {
  if (vmStarted) {
    addToRunningVM();
    return;
  }
  boot();
});

rebootLink.addEventListener("click", (event) => {
  event.preventDefault();
  reboot();
});

// Add whatever is selected to the guest that is already running.
//
// Nothing is rebooted and nothing is typed at the guest: the share is
// a directory in the emscripten filesystem, 9p passes the guest's
// lookups straight through to it, and the programs land in the
// /usr/bin the guest already has on PATH. Only packages it does not
// already have are fetched.
async function addToRunningVM() {
  bootButton.disabled = true;
  const panel = new ProgressPanel(bootProgress);
  const row = panel.row("adding");

  try {
    const roots = selectedBuilds();
    const known = new Map(
      [...mounted.values()].map(({ build }) => [build.name, build]),
    );
    const { builds, problems } = await walkClosure(roots, {
      known,
      onTotal: (n) => row.setTotal(n),
      onBytes: (n) => row.add(n),
      onPackage: async (pkg) => {
        vm.add(pkg);
        recordPackage(pkg);
      },
    });
    if (builds.length === 0) {
      row.done("already there");
    } else {
      row.done(`${builds.length} packages added`);
    }
    reportOutcome(vm, roots, problems);
    renderClosure();
  } catch (err) {
    row.fail(String(err));
  } finally {
    bootButton.disabled = false;
  }
}

// ---------- the report ----------

// Built when pressed, from what the page already has (report.js). The
// clipboard needs a secure context and a user gesture; when it is
// refused, the report replaces the log so it can be selected by hand.
const reportStatus = document.getElementById("report-status");
document.getElementById("copy-report").addEventListener("click", async () => {
  const report = buildReport({
    manifest: await manifest(),
    packages: [...mounted.values()],
    terminal: vm?.terminal ?? null,
    transcript: window.tryarch?.transcript() ?? "",
    boot: bootMode,
  });
  try {
    await navigator.clipboard.writeText(report);
    reportStatus.textContent = "copied";
  } catch {
    debugLog.textContent = report;
    reportStatus.textContent = "select it below and copy";
  }
});

// ---------- restoring a shared link ----------

// A package named without a version means "whatever the repos have
// now", which is what makes ?pkg=jq a durable link; one with a version
// is looked up across the repos and the archive.
async function restore({ pkgs, repos }) {
  if (repos.length > 0) {
    reposInput.value = repos.join("\n");
    await applyRepos(repos);
  }

  for (const { name, version } of pkgs) {
    if (version === null) {
      await selectName(name);
      continue;
    }
    const hit = (await versionsOf(name)).find((b) => b.version === version);
    if (hit === undefined) {
      status.textContent = `${name} ${version} is not in the repos or the archive`;
      continue;
    }
    select(hit, { pinned: true });
  }
}

// The footer says how fresh the index is; a stale one is the first
// thing to suspect when a download 404s.
indexInfo().then(
  ({ generated, count }) => {
    const when = generated ? new Date(generated).toUTCString() : "unknown";
    indexInfoElement.textContent = `index of ${count} packages, generated ${when}`;
  },
  (err) => {
    indexInfoElement.textContent = "index unavailable";
    log(`index: ${err.message}`);
  },
);

// Warm the cache while the reader is still choosing. The engine, the
// guest image and the snapshot are the same bytes for every boot and
// none of them depend on the selection, so they can be on their way
// before anything is picked. A second visit has them already, and the
// boot's own fetches then find everything in the cache and finish
// instantly. Failures are ignored: this is an optimisation, and the
// boot does its own fetching either way.
async function prefetch() {
  const warm = async (path, fetcher) => {
    try {
      await fetcher(await asset(path));
    } catch {
      // an optimisation that failed is not an error
    }
  };
  // The wasm goes to the HTTP cache, where the engine's own fetch
  // finds it; the rest to the Cache API, where the page's do.
  warm(QEMU_WASM, warmHttpCache);
  warm(SNAPSHOT_URL, fetchWithProgress);
  for (const name of GUEST_FILES) {
    warm(`guest/${name}`, fetchWithProgress);
  }
}

const initial = readUrl();

// Not while a boot is already starting. A reboot lands on ?boot=1 and
// the boot fetches these itself; racing it only doubles ~75 MB of
// engine and snapshot in flight, which is enough to make a fetch fail
// outright on a tab that is already holding packages in memory.
//
// requestIdleCallback keeps the rest off the critical path on a slow
// device; not every browser has it.
if (!initial.boot) {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(prefetch);
  } else {
    setTimeout(prefetch, 0);
  }
}
render();
if (initial.pkgs.length > 0 || initial.repos.length > 0) {
  restore(initial).then(() => {
    if (initial.boot && selection.size > 0) {
      boot();
    }
  });
}
