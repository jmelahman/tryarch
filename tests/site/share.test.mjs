// Tests writing a package into the guest's share against a fake
// emscripten FS that records what it was asked to do. The two rules
// worth pinning are first-writer-wins across packages and the absolute
// symlink target, which is not tidiness but the fix for a 9p lookup
// failure (see share.js).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SHARE_ROOT,
  absoluteTarget,
  ensureDir,
  programsOf,
  writePackage,
} from "../../site/js/share.js";

// Just enough of emscripten's FS to record calls and answer readFile.
function fakeFS() {
  const dirs = new Set();
  const files = new Map();
  const links = new Map();
  const modes = new Map();
  const calls = [];

  return {
    dirs,
    files,
    links,
    modes,
    calls,
    mkdir(path) {
      calls.push(["mkdir", path]);
      if (dirs.has(path) || files.has(path)) {
        // What emscripten does: EEXIST.
        throw new Error(`EEXIST: ${path}`);
      }
      dirs.add(path);
    },
    writeFile(path, data, options) {
      calls.push(["writeFile", path, options]);
      files.set(path, data);
    },
    chmod(path, mode) {
      calls.push(["chmod", path, mode]);
      modes.set(path, mode);
    },
    symlink(target, path) {
      calls.push(["symlink", target, path]);
      links.set(path, target);
    },
    readFile(path) {
      const data = files.get(path);
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return data;
    },
  };
}

const bytes = (text) => new TextEncoder().encode(text);

const file = (path, text, mode = 0o644) => ({
  path,
  type: "file",
  mode,
  size: text.length,
  mtime: 0,
  data: bytes(text),
  target: null,
});

const dir = (path) => ({
  path,
  type: "dir",
  mode: 0o755,
  size: 0,
  mtime: 0,
  data: null,
  target: null,
});

const symlink = (path, target) => ({
  path,
  type: "symlink",
  mode: 0o777,
  size: 0,
  mtime: 0,
  data: null,
  target,
});

const hardlink = (path, target) => ({
  path,
  type: "hardlink",
  mode: 0o644,
  size: 0,
  mtime: 0,
  data: null,
  target,
});

test("the share root is where the guest mounts it", () => {
  assert.equal(SHARE_ROOT, "/share");
});

test("ensureDir creates every missing component", () => {
  const FS = fakeFS();
  ensureDir(FS, "/share/usr/lib");
  assert.deepEqual([...FS.dirs], ["/share", "/share/usr", "/share/usr/lib"]);
  // Again is a no-op, not an error.
  ensureDir(FS, "/share/usr/lib");
  assert.equal(FS.dirs.size, 3);
});

test("writePackage writes files, directories and modes", () => {
  const FS = fakeFS();
  const counts = writePackage(FS, SHARE_ROOT, [
    dir("usr"),
    dir("usr/bin"),
    file("usr/bin/jq", "#!/bin/sh\n", 0o755),
    file("usr/share/doc/jq/README", "hi"),
  ]);

  // Every directory made counts, including the parents the archive
  // never listed: /share, usr, usr/bin, usr/share, usr/share/doc and
  // usr/share/doc/jq.
  assert.deepEqual(counts, { files: 2, dirs: 6, links: 0, skipped: 0 });
  assert.equal(
    new TextDecoder().decode(FS.files.get("/share/usr/bin/jq")),
    "#!/bin/sh\n",
  );
  assert.equal(FS.modes.get("/share/usr/bin/jq"), 0o755);
  assert.equal(FS.modes.get("/share/usr/share/doc/jq/README"), 0o644);

  // A file's parents are created even when the archive never listed
  // them as entries.
  assert.ok(FS.dirs.has("/share/usr/share/doc/jq"));
});

test("file data is handed to MEMFS to keep, not to copy", () => {
  const FS = fakeFS();
  const entry = file("usr/bin/jq", "x", 0o755);
  writePackage(FS, SHARE_ROOT, [entry]);
  const [, , options] = FS.calls.find(([call]) => call === "writeFile");
  // canOwn is what keeps a boot inside the tab's memory: the archive
  // becomes the filesystem's storage instead of being copied into it.
  assert.deepEqual(options, { canOwn: true });
  assert.equal(FS.files.get("/share/usr/bin/jq"), entry.data);
});

test("only the mode bits go to chmod", () => {
  const FS = fakeFS();
  // tar records the type in the high bits; passing those to chmod is
  // how a file becomes something else.
  writePackage(FS, SHARE_ROOT, [file("a", "x", 0o100755)]);
  assert.equal(FS.modes.get("/share/a"), 0o755);
});

test("a relative symlink is stored as an absolute path", () => {
  const FS = fakeFS();
  writePackage(FS, SHARE_ROOT, [
    file("usr/lib/libfoo.so.1.2", "x"),
    symlink("usr/lib/libfoo.so", "libfoo.so.1.2"),
    symlink("usr/bin/vi", "../../usr/bin/vim"),
  ]);
  assert.equal(
    FS.links.get("/share/usr/lib/libfoo.so"),
    "/share/usr/lib/libfoo.so.1.2",
  );
  assert.equal(FS.links.get("/share/usr/bin/vi"), "/share/usr/bin/vim");
});

test("an absolute symlink target is left alone", () => {
  const FS = fakeFS();
  // It names a guest path, which the guest reaches through the mount.
  writePackage(FS, SHARE_ROOT, [symlink("usr/bin/awk", "/usr/bin/gawk")]);
  assert.equal(FS.links.get("/share/usr/bin/awk"), "/usr/bin/gawk");
});

test("absoluteTarget resolves . and .. against the link's directory", () => {
  assert.equal(
    absoluteTarget("/share/usr/bin/vi", "vim"),
    "/share/usr/bin/vim",
  );
  assert.equal(
    absoluteTarget("/share/usr/bin/vi", "./vim"),
    "/share/usr/bin/vim",
  );
  assert.equal(
    absoluteTarget("/share/usr/bin/vi", "../lib/vim"),
    "/share/usr/lib/vim",
  );
  assert.equal(
    absoluteTarget("/share/usr/sbin", "usr/bin"),
    "/share/usr/usr/bin",
  );
  assert.equal(absoluteTarget("/share/a/b/c", "/etc/hosts"), "/etc/hosts");
});

test("a hardlink becomes a copy of its target's bytes", () => {
  const FS = fakeFS();
  const counts = writePackage(FS, SHARE_ROOT, [
    file("usr/bin/gzip", "real", 0o755),
    hardlink("usr/bin/gunzip", "usr/bin/gzip"),
  ]);
  assert.equal(counts.files, 2);
  assert.equal(
    new TextDecoder().decode(FS.files.get("/share/usr/bin/gunzip")),
    "real",
  );
  // The copy keeps the original's permissions: a hardlink header
  // carries no useful mode of its own.
  assert.equal(FS.modes.get("/share/usr/bin/gunzip"), 0o755);
});

test("a hardlink to another package's file reads it back off the share", () => {
  const FS = fakeFS();
  const state = {};
  writePackage(FS, SHARE_ROOT, [file("usr/bin/gzip", "real", 0o755)], state);
  const counts = writePackage(
    FS,
    SHARE_ROOT,
    [hardlink("usr/bin/gunzip", "usr/bin/gzip")],
    state,
  );
  assert.equal(counts.files, 1);
  assert.equal(
    new TextDecoder().decode(FS.files.get("/share/usr/bin/gunzip")),
    "real",
  );
});

test("a hardlink to nothing is skipped, not fatal", () => {
  const FS = fakeFS();
  const counts = writePackage(FS, SHARE_ROOT, [hardlink("a", "missing")]);
  assert.deepEqual(counts, { files: 0, dirs: 1, links: 0, skipped: 1 });
});

test("the first package to write a path wins", () => {
  const FS = fakeFS();
  const state = {};
  writePackage(FS, SHARE_ROOT, [file("usr/bin/sh", "from-bash", 0o755)], state);
  const counts = writePackage(
    FS,
    SHARE_ROOT,
    [file("usr/bin/sh", "from-dash", 0o755)],
    state,
  );

  assert.deepEqual(counts, { files: 0, dirs: 0, links: 0, skipped: 1 });
  assert.equal(
    new TextDecoder().decode(FS.files.get("/share/usr/bin/sh")),
    "from-bash",
  );
});

test("shared directories are made once across packages", () => {
  const FS = fakeFS();
  const state = {};
  writePackage(
    FS,
    SHARE_ROOT,
    [dir("usr"), dir("usr/lib"), file("usr/lib/a", "a")],
    state,
  );
  const before = FS.calls.filter(([call]) => call === "mkdir").length;
  const counts = writePackage(
    FS,
    SHARE_ROOT,
    [dir("usr"), dir("usr/lib"), file("usr/lib/b", "b")],
    state,
  );
  const after = FS.calls.filter(([call]) => call === "mkdir").length;

  assert.equal(counts.dirs, 0);
  assert.equal(
    after,
    before,
    "a directory another package already made is not remade",
  );
});

test("programsOf names what a PATH lookup would run", () => {
  const entries = [
    file("usr/bin/jq", "x", 0o755),
    symlink("usr/bin/jq-old", "jq"),
    file("usr/bin/notes.txt", "x", 0o644),
    dir("usr/bin/helpers"),
    file("usr/bin/helpers/inner", "x", 0o755),
    file("usr/lib/libjq.so", "x", 0o755),
  ];
  assert.deepEqual(programsOf(entries), ["jq", "jq-old"]);
});
