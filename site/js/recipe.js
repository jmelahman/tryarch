// A recipe's sources, gathered in the browser before the VM boots.
//
// makepkg in the guest has no network at all: whatever `source=()`
// names has to be sitting in $srcdir before it starts, or the build
// stops at the first download. So the page collects the files itself —
// fetching what it can, asking the visitor for the rest — and the boot
// writes them in beside the PKGBUILD.
//
// Most of what a recipe names cannot be fetched from a page. A release
// tarball usually lives on a host that sends no CORS header, and a
// browser cannot read a byte of one of those; a `local` file was never
// on the network to begin with; a VCS source wants a checkout that
// nothing here can make. None of that is exceptional, and none of it
// throws: a visitor can open the URL in another tab and drop the file
// on the page, so every failure comes back as a problem that names the
// file, the URL to go and get, and why. Whether a missing file stops
// the build is the caller's decision, not this module's.

import { verifyDigest } from "./hash.js";
import { fetchWithProgress, mapConcurrent } from "./net.js";

// How many source downloads run at once. The same bound the package
// downloads use: enough to keep a slow host from serialising the rest,
// few enough that a browser's connection limit is not the thing being
// measured.
const CONCURRENT = 3;

// Two attempts per source, not the four a package file gets. The
// common failure here is a host without a CORS header, which fails
// every attempt identically and only costs backoff — and a recipe with
// a dozen sources pays that a dozen times over. Two still turns a
// dropped connection into a slower success.
const ATTEMPTS = 2;

// The checksums WebCrypto can actually compute, strongest first.
// makepkg accepts md5, sha224 and b2 (BLAKE2b) as well, and SubtleCrypto
// has none of them, so a recipe that lists only those downloads
// unchecked here. That costs nothing: makepkg re-checks every sum it
// was given, against these same bytes, once the guest is up. This
// digest is only so the page can catch a truncated download before it
// spends a boot on it.
const HASHABLE = [
  ["sha512", "SHA-512"],
  ["sha384", "SHA-384"],
  ["sha256", "SHA-256"],
  ["sha1", "SHA-1"],
];

// The strongest digest a browser can check for one source, as
// hash.js and net.js want it, or null when the recipe gave none this
// page can use.
export function digestOf(sums) {
  for (const [name, algorithm] of HASHABLE) {
    const hex = sums?.[name];
    if (hex !== undefined && hex !== null && hex !== "") {
      return { algorithm, hex };
    }
  }
  return null;
}

// "SHA-256" back to the name the recipe wrote, so a mismatch can be
// reported in the recipe's own vocabulary rather than WebCrypto's.
const sumName = (digest) => digest.algorithm.toLowerCase().replace("-", "");

// fetchWithProgress puts the URL in front of its message. The problem
// carries the URL in a field of its own, so the reason says only what
// went wrong: "Failed to fetch", which is all a browser will say about
// a refused cross-origin read.
function why(err, url) {
  const message = err?.message ?? String(err);
  return message.startsWith(`${url}: `)
    ? message.slice(url.length + 2)
    : message;
}

// One entry per filename, in recipe order. A recipe may name the same
// file twice — a split package's arrays, or a source repeated under a
// rename — and it is fetched, shown and written once. First wins,
// which is the rule everywhere else a recipe is read.
function distinctSources(recipe) {
  const seen = new Set();
  const sources = [];
  for (const source of recipe?.sources ?? []) {
    if (!seen.has(source.filename)) {
      seen.add(source.filename);
      sources.push(source);
    }
  }
  return sources;
}

// What the visitor handed over, checked against the recipe if the
// recipe said anything checkable. verifyDigest answers null when the
// question cannot be asked (no SubtleCrypto outside a secure context),
// and null is not "no": the file is taken unverified rather than
// refused, because makepkg will check it again anyway.
async function fromSupplied(bytes, digest) {
  if (digest === null) {
    return { bytes };
  }
  const ok = await verifyDigest(bytes, digest);
  if (ok === false) {
    return { reason: `does not match the recipe's ${sumName(digest)}` };
  }
  return { bytes };
}

// Every source of a recipe, as bytes or as a reason there are none.
//
// `supplied` is filename -> Uint8Array: the files the visitor dropped
// on the page. They always win over a download — the visitor went and
// got them because the fetch could not — and they are still checked
// against the recipe, since a wrong file is worth catching before the
// build rather than after it.
export async function fetchSources(
  recipe,
  {
    supplied = new Map(),
    onBytes = () => {},
    onTotal = () => {},
    fetch = fetchWithProgress,
  } = {},
) {
  const wanted = distinctSources(recipe);

  // Everything decidable without the network is decided first, so only
  // what is left goes out over it.
  const outcomes = new Map();
  const remote = [];

  for (const source of wanted) {
    const digest = digestOf(source.sums);

    if (supplied.has(source.filename)) {
      outcomes.set(
        source.filename,
        await fromSupplied(supplied.get(source.filename), digest),
      );
      continue;
    }
    if (source.kind === "local") {
      outcomes.set(source.filename, { reason: "not supplied" });
      continue;
    }
    if (source.kind === "vcs") {
      outcomes.set(source.filename, {
        reason: `${source.protocol} sources need a checkout nothing here can make`,
      });
      continue;
    }
    remote.push({ source, digest });
  }

  const fetched = await mapConcurrent(
    remote,
    CONCURRENT,
    async ({ source, digest }) => {
      try {
        const bytes = await fetch(source.url, {
          digest,
          onBytes,
          onTotal,
          attempts: ATTEMPTS,
        });
        return { bytes };
      } catch (err) {
        // Worded for the visitor, who can do what the page cannot.
        return {
          reason: `could not fetch it (${why(err, source.url)}) — download it and drop it here`,
        };
      }
    },
  );
  remote.forEach(({ source }, i) => outcomes.set(source.filename, fetched[i]));

  // Recipe order, whatever order the downloads finished in.
  const files = new Map();
  const problems = [];
  for (const source of wanted) {
    const outcome = outcomes.get(source.filename);
    if (outcome.bytes !== undefined) {
      files.set(source.filename, outcome.bytes);
      continue;
    }
    problems.push({
      filename: source.filename,
      url: source.url,
      kind: source.kind,
      reason: outcome.reason,
    });
  }

  return { files, problems };
}

// A row is "ready" only when the bytes are in hand. A vcs source is
// its own status because it is not something the visitor can fix by
// downloading a file — the page has to say so rather than ask.
const statusOf = (kind, ready) => {
  if (ready) {
    return "ready";
  }
  return kind === "vcs" ? "unsupported" : "missing";
};

// What fetchSources found, as one row per source for the page to draw.
export function sourceRows(recipe, { files = new Map(), problems = [] } = {}) {
  const reasons = new Map(
    problems.map((problem) => [problem.filename, problem.reason]),
  );

  return distinctSources(recipe).map((source) => {
    const bytes = files.get(source.filename);
    const ready = bytes !== undefined;
    return {
      filename: source.filename,
      url: source.url,
      kind: source.kind,
      status: statusOf(source.kind, ready),
      size: ready ? bytes.byteLength : null,
      reason: reasons.get(source.filename) ?? null,
    };
  });
}
