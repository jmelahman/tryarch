// A tar reader for Arch packages and repo databases.
//
// A .pkg.tar.zst is an ordinary ustar/pax archive once the compression
// is off, but "ordinary" covers four ways of writing a path longer than
// 100 characters: the ustar prefix field, a pax extended header, GNU's
// 'L' record, and the same three for a symlink target. Arch packages in
// the wild use all of them — makepkg has written pax for years, the
// 2018-era archives on the Internet Archive are GNU — so all of them
// are read here.
//
// Paths are normalised on the way out (no leading "./" or "/", no
// trailing slash, no empty components) because they become filesystem
// paths under /share, and a ".." component is refused outright: an
// archive that escapes the share would be writing over the page's own
// tree.

const BLOCK = 512;
const decoder = new TextDecoder();

// Header field offsets, from tar(5).
const NAME = 0;
const MODE = 100;
const SIZE = 124;
const MTIME = 136;
const TYPE = 156;
const LINKNAME = 157;
const PREFIX = 345;

// The type flags that carry file data, a target, or nothing.
const TYPES = {
  0: "file",
  "\0": "file",
  7: "file", // contiguous, treated as regular
  5: "dir",
  2: "symlink",
  1: "hardlink",
};

// A NUL-terminated field.
function text(bytes, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) {
    end += 1;
  }
  return decoder.decode(bytes.subarray(offset, end));
}

// A numeric field: octal digits, or GNU's base-256 form (high bit set
// in the first byte) for sizes and times that no longer fit.
function number(bytes, offset, length) {
  if ((bytes[offset] & 0x80) !== 0) {
    let value = bytes[offset] & 0x7f;
    for (let i = 1; i < length; i += 1) {
      value = value * 256 + bytes[offset + i];
    }
    return value;
  }
  const digits = text(bytes, offset, length).trim();
  const value = Number.parseInt(digits, 8);
  return Number.isFinite(value) ? value : 0;
}

// Pax records are "<length> <key>=<value>\n", the length counting
// itself. Only the keys that change what an entry is get read.
function parsePax(bytes) {
  const attributes = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(text(bytes, offset, space - offset), 10);
    if (!Number.isFinite(length) || length <= 0) {
      break;
    }
    const record = decoder.decode(bytes.subarray(space + 1, offset + length));
    const sep = record.indexOf("=");
    if (sep !== -1) {
      attributes[record.slice(0, sep)] = record
        .slice(sep + 1)
        .replace(/\n$/, "");
    }
    offset += length;
  }
  return attributes;
}

// A path as the filesystem should see it. Throws on a ".." component:
// nothing legitimate in an Arch package needs one, and the alternative
// is writing outside the share.
export function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      throw new Error(`tar entry escapes the archive: ${path}`);
    }
    parts.push(part);
  }
  return parts.join("/");
}

// Every entry in archive order. File data is a subarray of the input,
// not a copy: a package unpacks once and MEMFS keeps those views.
export function parseTar(bytes) {
  const entries = [];
  let offset = 0;

  // Attributes waiting for the entry they describe: a pax header, a GNU
  // long name or long link. Global pax records apply until replaced.
  let global = {};
  let pax = {};
  let longName = null;
  let longLink = null;

  while (offset + BLOCK <= bytes.length) {
    const header = offset;
    offset += BLOCK;

    // An all-zero block ends the archive.
    if (bytes.subarray(header, header + BLOCK).every((byte) => byte === 0)) {
      break;
    }

    const flag = String.fromCharCode(bytes[header + TYPE] || 0);
    const attributes = { ...global, ...pax };
    const size = Number(attributes.size ?? number(bytes, header + SIZE, 12));
    const data = bytes.subarray(offset, offset + size);
    const next = offset + Math.ceil(size / BLOCK) * BLOCK;

    // A body that runs past the end is a truncated download, not a
    // malformed archive: keep what parsed and stop.
    if (offset + size > bytes.length) {
      break;
    }
    offset = next;

    if (flag === "x" || flag === "X") {
      pax = parsePax(data);
      continue;
    }
    if (flag === "g") {
      global = { ...global, ...parsePax(data) };
      continue;
    }
    if (flag === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    if (flag === "K") {
      longLink = text(data, 0, data.length);
      continue;
    }

    const type = TYPES[flag];
    const raw =
      attributes.path ??
      longName ??
      joinPrefix(
        text(bytes, header + PREFIX, 155),
        text(bytes, header + NAME, 100),
      );
    const link =
      attributes.linkpath ?? longLink ?? text(bytes, header + LINKNAME, 100);

    pax = {};
    longName = null;
    longLink = null;

    // Device nodes, fifos and GNU's own bookkeeping entries have no
    // meaning in the share.
    if (type === undefined) {
      continue;
    }

    const path = normalizePath(raw);
    if (path === "") {
      continue;
    }

    entries.push({
      path,
      type,
      mode: number(bytes, header + MODE, 8),
      size: type === "file" ? size : 0,
      mtime: Number(attributes.mtime ?? number(bytes, header + MTIME, 12)),
      data: type === "file" ? data : null,
      target:
        type === "symlink"
          ? link
          : type === "hardlink"
            ? normalizePath(link)
            : null,
    });
  }

  return entries;
}

const joinPrefix = (prefix, name) =>
  prefix === "" ? name : `${prefix}/${name}`;
