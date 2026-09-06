// A PKGBUILD read without bash, into the same Recipe .SRCINFO gives.
//
// This one is best effort, and it has to be: a PKGBUILD is a bash
// script, the page has no bash, and the only thing that can say what
// `pkgver=$(git describe)` evaluates to is the guest. What the page
// needs beforehand is smaller than the truth — which packages to fetch
// from the repos, which files to download or ask the visitor for — and
// that lives in the top-level assignments, which are plain enough to
// read directly. When this parser guesses wrong the build still runs:
// makepkg in the guest re-reads the file and is the authority.
//
// So: top-level `name=value` and `name=(...)` assignments only, with
// function bodies skipped; `$var`, `${var}`, `${var[2]}`,
// `${var/a/b}`, `${var%x}` and `${var#x}` expanded from assignments
// that came earlier; and `{,.asc}` brace lists expanded, because a
// recipe that writes one means two sources with two checksums between
// them. Anything else — command substitution, conditionals, `${a[@]}`,
// a pkgver() that computes the version — is left as the text it was,
// and the caller gets a recipe with a "$(...)" in it rather than a
// recipe that quietly lost a source.
//
// Known and deliberate: a split package's per-package overrides live
// in `package_foo()` function bodies, which are bash and are skipped.
// `pkgname=(a b)` therefore yields two packages sharing the top-level
// depends/desc/..., and a `depends+=(...)` inside a package body is
// missed. The .SRCINFO is the parser to prefer whenever there is one,
// which for an AUR package there always is; this one is for the
// PKGBUILD a visitor pasted.

import { recipeFiles, sourceList, unique, versionString } from "./sources.js";

// "name() {", with or without the optional `function` keyword. This is
// convention rather than grammar — makepkg's parser is bash itself —
// but every PKGBUILD in the AUR is written this way.
const FUNCTION = /^\s*(?:function\s+)?[A-Za-z_][A-Za-z0-9_.+-]*\s*\(\s*\)/;

// A top-level assignment, at column 0. Indentation means the line is
// inside something this parser did not follow, and guessing about it
// is worse than ignoring it.
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/;

// A variable reference: a name, and the "[2]" of an array element.
// "[@]" and "[*]" are deliberately not matched — they stand for a
// whole list, and this expands one word at a time.
const NAME = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?/;

// Arrays makepkg lets a recipe give per architecture, as
// "source_x86_64". The rest of the keys are read as written.
const ARCHED = [
  "depends",
  "makedepends",
  "checkdepends",
  "optdepends",
  "provides",
  "conflicts",
  "replaces",
  "source",
  "md5sums",
  "sha1sums",
  "sha224sums",
  "sha256sums",
  "sha384sums",
  "sha512sums",
  "b2sums",
];

// A variable's value. Bash's "$arr" is the first element of an array,
// which is what a split package's PKGBUILD means when it writes
// "$pkgname" in a source, and "${arr[2]}" is the element it names;
// pkgbase defaults to pkgname the way makepkg defaults it.
function lookup(vars, name, index = 0) {
  const values =
    vars.get(name) ?? (name === "pkgbase" ? vars.get("pkgname") : undefined);
  return values === undefined ? null : (values[index] ?? "");
}

// A bash pattern — the "%suffix" and "//pat/rep" kind — as a regular
// expression. "*" and "?" are the only wildcards a PKGBUILD reaches
// for; everything else stands for itself.
function pattern(text, greedy) {
  let out = "";
  for (const c of text) {
    if (c === "*") {
      out += greedy ? "[\\s\\S]*" : "[\\s\\S]*?";
    } else if (c === "?") {
      out += "[\\s\\S]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

// The inside of a "${...}". Returns null for anything this parser
// cannot answer, and the caller then leaves the text alone rather than
// dropping it — an unexpanded "${foo}" in a filename is a visible
// wrong answer, an empty one is an invisible one.
function expandBraced(body, vars) {
  const found = NAME.exec(body);
  if (found === null) {
    return null;
  }
  const value = lookup(vars, found[1], Number(found[2] ?? 0));
  if (value === null) {
    return null;
  }

  const rest = body.slice(found[0].length);
  if (rest === "") {
    return value;
  }

  // ${var/a/b} replaces once, ${var//a/b} replaces every time.
  if (rest.startsWith("/")) {
    const all = rest.startsWith("//");
    const parts = rest.slice(all ? 2 : 1);
    const slash = parts.indexOf("/");
    const from = expand(slash === -1 ? parts : parts.slice(0, slash), vars);
    const to = slash === -1 ? "" : expand(parts.slice(slash + 1), vars);
    if (from === "") {
      return value;
    }
    return value.replace(
      new RegExp(pattern(from, true), all ? "g" : ""),
      () => to,
    );
  }

  // ${var#prefix} takes the shortest match off the front, ${var##...}
  // the longest.
  if (rest.startsWith("#")) {
    const longest = rest.startsWith("##");
    const from = expand(rest.slice(longest ? 2 : 1), vars);
    const cut = new RegExp(`^(?:${pattern(from, longest)})([\\s\\S]*)$`).exec(
      value,
    );
    return cut === null ? value : cut[1];
  }

  // ${var%suffix} the same from the end. The greed is in the prefix
  // group: a greedy prefix leaves the shortest suffix to match.
  if (rest.startsWith("%")) {
    const longest = rest.startsWith("%%");
    const from = expand(rest.slice(longest ? 2 : 1), vars);
    const cut = new RegExp(
      `^([\\s\\S]*${longest ? "?" : ""})(?:${pattern(from, true)})$`,
    ).exec(value);
    return cut === null ? value : cut[1];
  }

  // ${var:-default}, ${#var}, ${var[@]}: not worth guessing at.
  return null;
}

// Every "$var" and "${var...}" in one word, from assignments already
// read. Single quotes are not honoured here — the word was unquoted
// before it got this far — which costs nothing on a real PKGBUILD,
// where a literal "$name" in a source or a dependency would be a bug.
function expand(text, vars) {
  let out = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "$") {
      out += text[i];
      i += 1;
      continue;
    }

    if (text[i + 1] === "{") {
      const close = text.indexOf("}", i + 2);
      if (close === -1) {
        out += text[i];
        i += 1;
        continue;
      }
      const value = expandBraced(text.slice(i + 2, close), vars);
      out += value === null ? text.slice(i, close + 1) : value;
      i = close + 1;
      continue;
    }

    const found = NAME.exec(text.slice(i + 1));
    if (found === null) {
      out += text[i];
      i += 1;
      continue;
    }
    // Bare "$name" takes no subscript: "$arr[0]" is the variable
    // followed by literal brackets, and bash reads it that way too.
    const value = lookup(vars, found[1]);
    out += value === null ? text.slice(i, i + 1 + found[1].length) : value;
    i += 1 + found[1].length;
  }

  return out;
}

// Bash's brace expansion, the comma form: "x.tar.gz{,.asc}" is the
// tarball and its signature, and "icon{16,32}.png" is two icons. A
// recipe that writes one of these expects two sources with two
// checksums between them, so this has to happen before anything counts
// the list. A "${...}" is a parameter, not a brace list, and is left
// for expand().
function braces(word) {
  for (
    let open = word.indexOf("{");
    open !== -1;
    open = word.indexOf("{", open + 1)
  ) {
    if (open > 0 && word[open - 1] === "$") {
      continue;
    }

    const parts = [];
    let depth = 0;
    let start = open + 1;

    for (let i = open; i < word.length; i += 1) {
      const c = word[i];
      if (c === "{") {
        depth += 1;
      } else if (c === "," && depth === 1) {
        parts.push(word.slice(start, i));
        start = i + 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth > 0) {
          continue;
        }
        // Braces with no comma at this level are not a list — a shell
        // glob, or something this parser could not expand.
        if (parts.length === 0) {
          break;
        }
        parts.push(word.slice(start, i));
        const head = word.slice(0, open);
        const tail = word.slice(i + 1);
        // Each alternative may hold braces of its own, and so may the
        // tail; every round is one brace pair shorter than the last.
        return parts.flatMap((part) => braces(head + part + tail));
      }
    }
  }

  return [word];
}

// Split text into words with just enough bash: single quotes are
// literal, double quotes hold spaces, a backslash escapes the next
// character (and swallows a newline, which is bash's line
// continuation), and "#" starts a comment only where a word starts —
// which is what keeps the "#tag=v1.2" of a VCS source out of trouble.
// With `paren` set, an unquoted ")" ends the list, so an array can run
// over as many lines as it likes.
function readWords(text, paren) {
  const words = [];
  let word = null;
  let i = 0;

  const push = () => {
    if (word !== null) {
      words.push(word);
      word = null;
    }
  };

  while (i < text.length) {
    const c = text[i];

    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      word = (word ?? "") + text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let quoted = "";
      while (j < text.length && text[j] !== '"') {
        // Inside double quotes a backslash only escapes the handful of
        // characters that would otherwise mean something.
        if (text[j] === "\\" && '$`"\\\n'.includes(text[j + 1])) {
          // A backslash-newline is bash's line continuation and leaves
          // nothing behind.
          quoted += text[j + 1] === "\n" ? "" : text[j + 1];
          j += 2;
          continue;
        }
        quoted += text[j];
        j += 1;
      }
      word = (word ?? "") + quoted;
      i = j + 1;
      continue;
    }

    if (c === "\\") {
      const next = text[i + 1] ?? "";
      word = next === "\n" ? word : (word ?? "") + next;
      i += 2;
      continue;
    }

    if (c === "#" && word === null) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }

    if (c === ")" && paren) {
      i += 1;
      break;
    }

    if (/\s/.test(c)) {
      push();
      i += 1;
      continue;
    }

    word = (word ?? "") + c;
    i += 1;
  }

  push();
  return { words, end: i };
}

// Everything from a function's opening line to the "}" that closes it.
// Braces are counted, and a "}" in column 0 ends the body whatever the
// count says — a body that unbalances its braces inside a sed script
// would otherwise swallow the assignments that follow it, and those
// are the whole point.
function skipFunction(lines, start) {
  let depth = 0;
  let open = false;

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (open && line.startsWith("}")) {
      return i + 1;
    }
    for (const c of line) {
      if (c === "{") {
        depth += 1;
        open = true;
      } else if (c === "}" && depth > 0) {
        depth -= 1;
      }
    }
    if (open && depth === 0) {
      return i + 1;
    }
  }

  return lines.length;
}

// A PKGBUILD's top-level assignments, in order, each one expanded with
// the ones before it. Later assignments win, "+=" appends.
function readAssignments(text, arch) {
  // CARCH is makepkg's, and a source list that interpolates it would
  // be unreadable without it.
  const vars = new Map([["CARCH", [arch]]]);
  const lines = String(text ?? "").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FUNCTION.test(line)) {
      i = skipFunction(lines, i);
      continue;
    }

    const assign = ASSIGN.exec(line);
    if (assign === null) {
      i += 1;
      continue;
    }

    const [, name, append, tail] = assign;
    const value = tail.trimStart();
    let words;

    if (value.startsWith("(")) {
      // The array may run past this line, so hand the scanner the rest
      // of the file and count the lines it used.
      const rest = [value.slice(1), ...lines.slice(i + 1)].join("\n");
      const read = readWords(rest, true);
      words = read.words;
      i += 1 + (rest.slice(0, read.end).match(/\n/g)?.length ?? 0);
    } else {
      // A scalar is one word: "name=a b" assigns "a" and runs "b".
      words = readWords(value, false).words.slice(0, 1);
      i += 1;
    }

    const expanded = words.flatMap((word) => braces(expand(word, vars)));
    vars.set(
      name,
      append === "+" && vars.has(name)
        ? [...vars.get(name), ...expanded]
        : expanded,
    );
  }

  return vars;
}

// A PKGBUILD, as far as it can be read without running it. `arch`
// picks which "_x86_64" arrays are merged in, the same way the
// .SRCINFO parser does it, so the two agree on what a recipe needs.
export function parsePkgbuild(text, { arch = "x86_64" } = {}) {
  const vars = readAssignments(text, arch);

  const names = vars.get("pkgname") ?? [];
  if (names.length === 0 || names[0] === "") {
    throw new Error("PKGBUILD has no pkgname assignment");
  }

  const list = (key) => vars.get(key) ?? [];
  // The generic array first, then this architecture's — makepkg's
  // order, and the order the checksum arrays are numbered in.
  const merged = (key) =>
    ARCHED.includes(key)
      ? [...list(key), ...list(`${key}_${arch}`)]
      : list(key);
  const one = (key) => {
    const value = vars.get(key)?.[0];
    return value === undefined || value === "" ? null : value;
  };

  const archList = list("arch");
  const install = one("install");
  const changelog = one("changelog");
  const desc = one("pkgdesc");

  const sources = sourceList(merged("source"), {
    md5sums: merged("md5sums"),
    sha1sums: merged("sha1sums"),
    sha224sums: merged("sha224sums"),
    sha256sums: merged("sha256sums"),
    sha384sums: merged("sha384sums"),
    sha512sums: merged("sha512sums"),
    b2sums: merged("b2sums"),
  });

  const depends = unique(merged("depends"));
  const optdepends = merged("optdepends");
  const provides = merged("provides");
  const conflicts = merged("conflicts");
  const replaces = merged("replaces");

  const epoch = one("epoch");
  const pkgver = one("pkgver");
  const pkgrel = one("pkgrel");

  return {
    base: one("pkgbase") ?? names[0],
    version: versionString({ epoch, pkgver, pkgrel }),
    pkgver,
    pkgrel,
    epoch,
    desc,
    url: one("url"),
    arch: archList,
    any: archList.length === 1 && archList[0] === "any",
    install,
    depends,
    makedepends: unique(merged("makedepends")),
    checkdepends: unique(merged("checkdepends")),
    sources,
    noextract: list("noextract"),
    validpgpkeys: list("validpgpkeys"),
    // Every package gets the top-level metadata: what package_foo()
    // would have overridden is in a function body, and this parser
    // does not read those.
    packages: names.map((name) => ({
      name,
      desc,
      depends: [...depends],
      provides: [...provides],
      conflicts: [...conflicts],
      replaces: [...replaces],
      arch: [...archList],
      install,
      optdepends: [...optdepends],
    })),
    files: recipeFiles(sources, [install, changelog]),
  };
}
