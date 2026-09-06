// The report a reader can paste into an issue.
//
// Assembled only when asked for, from what the page already holds:
// nothing is measured at boot, nothing is polled, and the guest is not
// asked anything. What it carries is what it took to resolve the bugs
// reported so far — which engine and site were served (a decoder bug
// once hid behind "bad archive"), which browser (a stream race that
// only some engines lose), the boot's timeline, what was unpacked into
// the share, and the last of what the console said.

import { logLines } from "./log.js";
import { humanBytes } from "./format.js";

// How much of the console goes in. It is what the reader typed and
// saw, so the button says it is included.
const CONSOLE_LINES = 40;
const SCRIPT_DIRECTORY = /js\.[0-9a-f]+/;
// Escape sequences in the console stream: CSI and the rest, which
// mean nothing on paper.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;

// The site build serving the page: the hashed module directory the
// build renamed (tools/build-site.py).
function siteBuild() {
  const script = document.querySelector('script[type="module"]')?.src ?? "";
  return SCRIPT_DIRECTORY.exec(script)?.[0] ?? "local checkout";
}

// The engine, guest and snapshot actually served, by the content hash
// the page fetched them under (assets.json).
function assetLines(manifest) {
  return Object.entries(manifest?.files ?? {})
    .sort()
    .map(([path, version]) => `  ${path} ${version}`);
}

function browserLines() {
  const lines = [`  ${navigator.userAgent}`];
  lines.push(
    `  cores ${navigator.hardwareConcurrency ?? "?"}` +
      `, device memory ${navigator.deviceMemory ?? "?"} GiB` +
      `, touch ${matchMedia("(pointer: coarse)").matches}` +
      `, cross-origin isolated ${crossOriginIsolated}`,
  );
  lines.push(
    `  viewport ${window.innerWidth}x${window.innerHeight}` +
      `, visual ${Math.round(window.visualViewport?.width ?? 0)}x${Math.round(window.visualViewport?.height ?? 0)}` +
      `, pixel ratio ${window.devicePixelRatio}`,
  );
  // Chrome only, and synchronous: the JS heap right now.
  const memory = performance.memory;
  if (memory !== undefined) {
    lines.push(
      `  js heap ${humanBytes(memory.usedJSHeapSize)} used of ${humanBytes(memory.totalJSHeapSize)}`,
    );
  }
  return lines;
}

// What was fetched and unpacked: one line per package, with the two
// sizes that explain both a slow boot (download) and a full MEMFS
// (unpacked).
function packageLines(packages) {
  const download = packages.reduce((sum, one) => sum + one.compressed, 0);
  const unpacked = packages.reduce((sum, one) => sum + one.unpacked, 0);
  return [
    `  ${packages.length} packages, ${humanBytes(download)} download, ${humanBytes(unpacked)} unpacked`,
    ...packages.map(
      ({ build, compressed, unpacked: size, files }) =>
        `  ${build.name} ${build.version} ${build.repo} ${build.filename}` +
        ` ${humanBytes(compressed)}→${humanBytes(size)} ${files} files`,
    ),
  ];
}

function consoleLines(transcript) {
  return transcript
    .replace(ESCAPES, "")
    .replace(/\r/g, "")
    .split("\n")
    .slice(-CONSOLE_LINES)
    .map((line) => `  ${line}`);
}

// manifest: assets.json as fetched. packages: [{build, compressed,
// unpacked, files}] for what is in the share. terminal: the terminal, or
// null before a boot. transcript: what the console has said, or "".
// boot: a word for how the guest started.
export function buildReport({
  manifest,
  packages = [],
  terminal,
  transcript,
  boot,
}) {
  const sections = [
    [`tryarch report ${new Date().toISOString()}`, [`  ${location.href}`]],
    ["site", [`  ${siteBuild()}`, ...assetLines(manifest)]],
    ["browser", browserLines()],
    [
      "terminal",
      terminal === null
        ? ["  not started"]
        : [
            `  ${terminal.cols}x${terminal.rows}, ${terminal.options.fontSize}px, ${boot}`,
          ],
    ],
    [
      "packages",
      packages.length === 0 ? ["  nothing booted"] : packageLines(packages),
    ],
    [
      "log",
      logLines()
        .split("\n")
        .map((line) => `  ${line}`),
    ],
    ["console (last lines)", consoleLines(transcript)],
  ];
  return sections
    .map(([title, lines]) => [title, ...lines].join("\n"))
    .join("\n\n");
}
