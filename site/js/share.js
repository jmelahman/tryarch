// Writing unpacked packages into the emscripten filesystem the guest
// reads over 9p.
//
// The share is laid out like an Arch root — /share/usr/bin/jq, not a
// store path per package — because that is what a package expects to
// find when it looks for its own data files and libraries. Packages are
// written on top of each other, first writer wins, which is what pacman
// would call a file conflict and what a boot can simply ignore: the
// selection's own packages are written before the dependencies pulled in
// for them.

// Where the page builds the tree and where the guest mounts it. The two
// have to agree: an absolute symlink target written here is resolved
// there.
export const SHARE_ROOT = "/share";

const OWN = { canOwn: true };
const PERMISSIONS = 0o777;
const EXECUTABLE = 0o111;
const PROGRAM_DIR = "usr/bin/";

// mkdir -p against the emscripten FS: existing components are fine.
export function ensureDir(FS, path) {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      // exists
    }
  }
}

// The same walk, but counting what it created and remembering it, so a
// hundred packages sharing /share/usr/lib cost one mkdir.
function mkdirp(FS, path, written) {
  let created = 0;
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    if (written.has(current)) {
      continue;
    }
    try {
      FS.mkdir(current);
      created += 1;
    } catch {
      // exists
    }
    written.add(current);
  }
  return created;
}

// Where a symlink should point, written the way the guest can use it.
//
// A relative target is resolved here, against the link's own directory,
// into an absolute path. That is not tidying: emscripten's FS.readlink
// resolves the target itself and returns an absolute path, while the
// stat it reports keeps the *relative* target's length. The 9p client
// in the guest sees a link whose declared size is shorter than the
// string it reads back, and a lookup through it fails — the dynamic
// loader reports the library as missing even though `ls` shows it and
// `cat` reads it. Storing the absolute target makes size and content
// agree, and the guest resolves it because the share is mounted at the
// same path the page built it at.
//
// A target that is already absolute is left alone: it names a guest
// path like /usr/bin/vim, which the guest reaches through the symlinks
// the manifest makes into the share.
export function absoluteTarget(linkPath, target) {
  if (target.startsWith("/")) {
    return target;
  }

  const parts = linkPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

// Write one package's entries under `root`. `state.written` is shared
// across every package of a boot: it is what makes the first writer of
// a path win, and it saves re-creating directories every package has.
//
// File contents are views into the decompressed archive, and MEMFS is
// told to keep those views rather than copy them (canOwn). The archive
// then lives on exactly once, as the filesystem's storage for its files,
// instead of once there and once as the buffer it was parsed from — for
// a boot of any size, that is the difference between fitting in the tab
// and not.
export function writePackage(FS, root, entries, state = {}) {
  const written = (state.written ??= new Set());
  const counts = { files: 0, dirs: 0, links: 0, skipped: 0 };

  // A hardlink's bytes usually live in the same package, a few entries
  // earlier; the map is only built if one turns up.
  let byPath = null;

  for (const entry of entries) {
    const path = `${root}/${entry.path}`;

    if (entry.type === "dir") {
      counts.dirs += mkdirp(FS, path, written);
      continue;
    }

    if (written.has(path)) {
      counts.skipped += 1;
      continue;
    }
    counts.dirs += mkdirp(FS, parentOf(path), written);

    if (entry.type === "symlink") {
      FS.symlink(absoluteTarget(path, entry.target), path);
      written.add(path);
      counts.links += 1;
      continue;
    }

    if (entry.type === "hardlink") {
      byPath ??= new Map(entries.map((one) => [one.path, one]));
      // A hardlink is a second name for bytes MEMFS has no way to
      // share, so it becomes a copy: from this package's own entry when
      // the target is in it, else from what is already on the share.
      const source = byPath.get(entry.target);
      const data = source?.data ?? readOrNull(FS, `${root}/${entry.target}`);
      if (data === null) {
        counts.skipped += 1;
        continue;
      }
      FS.writeFile(path, data, OWN);
      FS.chmod(path, (source?.mode ?? entry.mode) & PERMISSIONS);
      written.add(path);
      counts.files += 1;
      continue;
    }

    FS.writeFile(path, entry.data, OWN);
    FS.chmod(path, entry.mode & PERMISSIONS);
    written.add(path);
    counts.files += 1;
  }

  return counts;
}

function readOrNull(FS, path) {
  try {
    return FS.readFile(path);
  } catch {
    return null;
  }
}

// The programs a package offers: the names directly under usr/bin that
// a PATH lookup would run — executables and symlinks, not data files
// and not nested directories. The boot lists them so a reader knows
// what to type.
export function programsOf(entries) {
  return entries
    .filter(
      (entry) =>
        entry.path.startsWith(PROGRAM_DIR) &&
        !entry.path.slice(PROGRAM_DIR.length).includes("/") &&
        (entry.type === "symlink" ||
          (entry.type === "file" && (entry.mode & EXECUTABLE) !== 0)),
    )
    .map((entry) => entry.path.slice(PROGRAM_DIR.length));
}
