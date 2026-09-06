// Tests the tar reader against a fixture written by bsdtar (the same
// writer makepkg uses) and a GNU-format one, because the four ways of
// encoding a long path are exactly what a hand-rolled reader gets
// wrong. The synthetic archives at the end cover the cases no sane
// writer produces but a hostile or truncated one might.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseTar, normalizePath } from "../../site/js/tar.js";

const LONG_NAME =
  "this-single-file-name-is-longer-than-one-hundred-characters-so-the-writer" +
  "-must-emit-a-pax-extended-header.txt";
const DEEP =
  "usr/share/doc/a-very-long-directory-name-for-the-prefix-field" +
  "/and-another-one-here-too/deeper/README.txt";

const load = async (name) =>
  parseTar(
    new Uint8Array(
      await readFile(new URL(`../fixtures/${name}`, import.meta.url)),
    ),
  );

const byPath = (entries) =>
  new Map(entries.map((entry) => [entry.path, entry]));
const string = (entry) => new TextDecoder().decode(entry.data);

test("parseTar reads a pax archive", async () => {
  const entries = await load("sample.tar");
  const files = byPath(entries);

  // "./" normalises to nothing and is dropped rather than emitted as an
  // entry with an empty path.
  assert.ok(!files.has(""));
  assert.ok(!entries.some((entry) => entry.path.startsWith("./")));

  const file = files.get("file.txt");
  assert.equal(file.type, "file");
  assert.equal(file.size, 14);
  assert.equal(string(file), "hello tryarch\n");
  assert.ok(file.mtime > 1_600_000_000);

  // The executable bit has to survive, or nothing in usr/bin runs.
  assert.equal(files.get("run.sh").mode & 0o777, 0o755);
  assert.equal(files.get("file.txt").mode & 0o777, 0o644);

  assert.equal(files.get("dir").type, "dir");
  assert.equal(files.get("dir").data, null);
  assert.equal(files.get("dir").size, 0);
});

test("a long path comes from the pax header", async () => {
  const files = byPath(await load("sample.tar"));
  assert.ok(LONG_NAME.length > 100);
  assert.equal(string(files.get(LONG_NAME)), "pax\n");
});

test("a long path also comes from the ustar prefix field", async () => {
  const files = byPath(await load("sample.tar"));
  assert.ok(DEEP.length > 100);
  assert.equal(string(files.get(DEEP)), "long\n");
});

test("symlinks keep their target, hardlinks name a path", async () => {
  const files = byPath(await load("sample.tar"));

  const link = files.get("dir/link");
  assert.equal(link.type, "symlink");
  assert.equal(link.target, "../file.txt");
  assert.equal(link.data, null);

  // A >100 character target needs the pax linkpath record, and stays
  // relative: it is a target, not a path in the share.
  const long = files.get("dir/longlink");
  assert.equal(long.type, "symlink");
  assert.equal(long.target, `../${DEEP}`);

  // A hardlink target is a path, so it is normalised like one.
  const hard = files.get("dir/hard.txt");
  assert.equal(hard.type, "hardlink");
  assert.equal(hard.target, "file.txt");
});

test("parseTar reads GNU long name and long link records", async () => {
  const files = byPath(await load("sample-gnu.tar"));
  assert.equal(string(files.get(LONG_NAME)), "pax\n");
  assert.equal(files.get("longlink").target, `../${DEEP}`);
});

test("normalizePath strips the shapes tar writers use", () => {
  assert.equal(normalizePath("./usr/bin/jq"), "usr/bin/jq");
  assert.equal(normalizePath("/usr/bin/jq"), "usr/bin/jq");
  assert.equal(normalizePath("usr//bin/"), "usr/bin");
  assert.equal(normalizePath("./"), "");
  assert.throws(() => normalizePath("../etc/passwd"), /escapes/);
  assert.throws(() => normalizePath("usr/../../etc"), /escapes/);
});

// --- synthetic archives -------------------------------------------------

const BLOCK = 512;
const encoder = new TextEncoder();

function header({ name = "", mode = 0o644, size = 0, type = "0", link = "" }) {
  const block = new Uint8Array(BLOCK);
  const put = (offset, value) => block.set(encoder.encode(value), offset);
  put(0, name);
  put(100, mode.toString(8).padStart(7, "0"));
  put(108, "0000000");
  put(116, "0000000");
  put(124, size.toString(8).padStart(11, "0"));
  put(136, "00000000000");
  put(156, type);
  put(157, link);
  put(257, "ustar\0" + "00");
  // The checksum is computed with the field itself read as spaces.
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, sum.toString(8).padStart(6, "0"));
  return block;
}

function archive(parts) {
  const blocks = [];
  for (const part of parts) {
    blocks.push(header(part));
    const body = part.body ?? new Uint8Array(0);
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = blocks.reduce((n, block) => n + block.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

test("an entry that escapes the archive is refused", () => {
  const bytes = archive([
    { name: "../etc/passwd", size: 1, body: encoder.encode("x") },
  ]);
  assert.throws(() => parseTar(bytes), /escapes/);
});

test("device nodes and fifos are skipped", () => {
  const bytes = archive([
    { name: "dev/null", type: "3" },
    { name: "run/fifo", type: "6" },
    { name: "keep.txt", type: "0", size: 2, body: encoder.encode("ok") },
  ]);
  assert.deepEqual(
    parseTar(bytes).map((entry) => entry.path),
    ["keep.txt"],
  );
});

test("a truncated archive keeps what parsed", () => {
  const full = archive([
    { name: "a.txt", size: 2, body: encoder.encode("aa") },
    { name: "b.txt", size: 600, body: new Uint8Array(600) },
  ]);
  // Cut inside b.txt's body.
  const entries = parseTar(full.subarray(0, BLOCK * 3));
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["a.txt"],
  );
});

test("a base-256 size field is read", () => {
  const block = header({ name: "big.txt", size: 0 });
  // GNU's escape hatch for sizes that no longer fit in octal: high bit
  // set, the rest big-endian.
  block.fill(0, 124, 136);
  block[124] = 0x80;
  block[135] = 3;
  const body = new Uint8Array(BLOCK);
  body.set(encoder.encode("abc"));
  const bytes = new Uint8Array(BLOCK * 4);
  bytes.set(block, 0);
  bytes.set(body, BLOCK);
  const [entry] = parseTar(bytes);
  assert.equal(entry.size, 3);
  assert.equal(string(entry), "abc");
});

test("a global pax header applies to later entries", () => {
  const record = (text) => {
    const length = `${text.length + 1}`.length + 1 + text.length + 1;
    return encoder.encode(`${length} ${text}\n`);
  };
  const mtime = record("mtime=1700000000");
  const bytes = archive([
    { name: "pax_global_header", type: "g", size: mtime.length, body: mtime },
    { name: "a.txt", size: 1, body: encoder.encode("a") },
    { name: "b.txt", size: 1, body: encoder.encode("b") },
  ]);
  const entries = parseTar(bytes);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.mtime),
    [1700000000, 1700000000],
  );
});

test("data is a view of the input, not a copy", async () => {
  const entries = await load("sample.tar");
  const file = entries.find((entry) => entry.path === "file.txt");
  assert.ok(file.data.buffer.byteLength > file.data.byteLength);
});
