// pacman's version comparison, transliterated from libalpm/version.c.
//
// Version ordering decides which build of a name is "current", which
// archived build a dependency era picks, and whether `jq>=1.7` is
// satisfied — so it has to be pacman's answer, not a plausible one.
// The vectors in tests/site/vercmp.test.mjs are ground truth from the
// vercmp(8) binary, not from reading this file.

const isDigit = (c) => c >= "0" && c <= "9";
const isAlpha = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c) => isDigit(c) || isAlpha(c);

// "" past the end, so the character tests read like C's on a NUL.
const at = (text, i) => (i < text.length ? text[i] : "");

// rpmvercmp: walk both strings a segment at a time, where a segment is a
// run of digits or a run of letters and anything else is a separator.
// Numeric segments compare as numbers (leading zeros dropped, more
// digits wins), alphabetic ones with strcmp, and a numeric segment beats
// an alphabetic one. The tail rules at the bottom are what make "1.0a"
// older than "1.0" but "1.0.1" newer than "1.0".
function rpmvercmp(a, b) {
  if (a === b) {
    return 0;
  }

  // `one`/`two` mark the start of the current segment, `ptr1`/`ptr2`
  // its end — the two pointer pairs C walks.
  let one = 0;
  let two = 0;
  let ptr1 = 0;
  let ptr2 = 0;

  while (one < a.length && two < b.length) {
    while (one < a.length && !isAlnum(a[one])) {
      one += 1;
    }
    while (two < b.length && !isAlnum(b[two])) {
      two += 1;
    }

    if (one >= a.length || two >= b.length) {
      break;
    }

    // Separator runs of different lengths end it: "1..0" is newer than
    // "1.0" because the run before its segment was longer.
    if (one - ptr1 !== two - ptr2) {
      return one - ptr1 < two - ptr2 ? -1 : 1;
    }

    ptr1 = one;
    ptr2 = two;

    // The type of a's segment decides how far both are read: b may run
    // out of that type immediately, which is the "different types" case
    // below.
    const isnum = isDigit(a[ptr1]);
    const test = isnum ? isDigit : isAlpha;
    while (ptr1 < a.length && test(a[ptr1])) {
      ptr1 += 1;
    }
    while (ptr2 < b.length && test(b[ptr2])) {
      ptr2 += 1;
    }

    let seg1 = a.slice(one, ptr1);
    let seg2 = b.slice(two, ptr2);

    // b had no segment of this type here: a numeric segment is newer
    // than an alphabetic one, and there is nothing else it can be.
    if (seg2 === "") {
      return isnum ? 1 : -1;
    }

    if (isnum) {
      seg1 = seg1.replace(/^0+/, "");
      seg2 = seg2.replace(/^0+/, "");
      if (seg1.length !== seg2.length) {
        return seg1.length > seg2.length ? 1 : -1;
      }
    }

    if (seg1 !== seg2) {
      return seg1 < seg2 ? -1 : 1;
    }

    one = ptr1;
    two = ptr2;
  }

  // Every segment compared equal and both ran out together.
  if (one >= a.length && two >= b.length) {
    return 0;
  }

  // The final showdown: a leftover alphabetic tail never beats nothing
  // (so 2.0rc1 < 2.0), while a leftover numeric or separator tail does
  // (so 1.0.1 > 1.0).
  const rest1 = at(a, one);
  const rest2 = at(b, two);
  if ((rest1 === "" && !isAlpha(rest2)) || isAlpha(rest1)) {
    return -1;
  }
  return 1;
}

// "[epoch:]ver[-rel]" split the way parseEVR does it: the epoch is a
// leading run of digits followed by ":", the release is whatever
// follows the last "-". A missing release is null, which is not the same
// as an empty one — it means "any release" when comparing.
export function parseVersion(text) {
  const full = String(text ?? "");

  let i = 0;
  while (i < full.length && isDigit(full[i])) {
    i += 1;
  }

  let epoch = "0";
  let rest = full;
  if (at(full, i) === ":") {
    epoch = full.slice(0, i) || "0";
    rest = full.slice(i + 1);
  }

  const dash = rest.lastIndexOf("-");
  return {
    epoch,
    ver: dash === -1 ? rest : rest.slice(0, dash),
    rel: dash === -1 ? null : rest.slice(dash + 1),
  };
}

// alpm_pkg_vercmp: epoch, then version, then release — and the release
// only when both sides name one, which is what makes "1.7.1" and
// "1.7.1-2" compare equal.
export function vercmp(a, b) {
  if (a === b) {
    return 0;
  }

  const left = parseVersion(a);
  const right = parseVersion(b);

  let order = rpmvercmp(left.epoch, right.epoch);
  if (order !== 0) {
    return order;
  }
  order = rpmvercmp(left.ver, right.ver);
  if (order !== 0 || left.rel === null || right.rel === null) {
    return order;
  }
  return rpmvercmp(left.rel, right.rel);
}

// The operators a dependency may carry, longest first so ">=" is not
// read as ">".
const OPERATORS = [">=", "<=", "=", ">", "<"];

// A dependency or provision string: "glibc", "linux-api-headers>=4.10",
// "libz.so=1-64", or an optdepend's "name: why you might want it".
// The name keeps its own punctuation — only an operator ends it.
export function parseDepend(text) {
  let spec = String(text ?? "").trim();

  // An optdepend explains itself after ": ", and no version contains
  // that pair.
  const colon = spec.indexOf(": ");
  if (colon !== -1) {
    spec = spec.slice(0, colon);
  }

  for (let i = 0; i < spec.length; i += 1) {
    const c = spec[i];
    if (c !== ">" && c !== "<" && c !== "=") {
      continue;
    }
    const op = OPERATORS.find((candidate) => spec.startsWith(candidate, i));
    return {
      name: spec.slice(0, i),
      op,
      version: spec.slice(i + op.length) || null,
    };
  }

  return { name: spec, op: null, version: null };
}

// alpm_depcmp's question: does a package at `version` satisfy this
// constraint? A constraint with no operator accepts anything, and one
// whose version names no release ignores the candidate's release —
// which vercmp already does, since it compares releases only when both
// sides have one.
export function satisfies(version, constraint) {
  const op = constraint?.op ?? null;
  const want = constraint?.version ?? null;
  if (op === null || want === null || want === "") {
    return true;
  }

  const order = vercmp(version, want);
  switch (op) {
    case "=":
      return order === 0;
    case ">=":
      return order >= 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case "<":
      return order < 0;
    default:
      return false;
  }
}

// Whether two dependency strings name the same thing: "libz.so=1-64"
// and "libz.so" are one provision asked for two ways.
export const sameName = (a, b) => parseDepend(a).name === parseDepend(b).name;
