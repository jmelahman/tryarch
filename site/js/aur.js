// The AUR lane: packages nobody has built, only written down.
//
// The AUR ships recipes, not binaries, so everything here answers a
// different question from index.js — not "where are the bytes" but
// "what would building this need". tools/build-index.py folds the
// AUR's package dump into `index/aur/`: the same shard layout as the
// binary index (a names file, one entry per package, one entry per
// provided name), so the two lanes share a fetcher, a retry and a memo
// and differ only in what an entry holds.
//
// The names file is where the two part company: 119k packages is ~9 MB,
// and a visitor who came for `jq` must not pay for it. So it is loaded
// lazily, on the first AUR search, and everything else — an entry, its
// providers — is one 40 KB shard.
//
// The recipe itself does not come from the index. It comes from
// GitHub's mirror of the AUR's git, because aur.archlinux.org sends no
// CORS header and a browser cannot read a byte of it.

import {
  AUR_INDEX_DIR,
  AUR_PAGE_URL,
  AUR_RAW_URL,
  SEARCH_LIMIT,
} from "./config.js";
import { indexJson, indexShard, rankOf } from "./index.js";
import { parseSrcinfo } from "./srcinfo.js";

// AUR names are restricted to lowercase letters, digits and `@._+-`,
// all of which stand for themselves in a path, so neither URL escapes
// anything: an escaped "+" would name a branch the mirror does not
// have.
export const aurPageUrl = (name) => `${AUR_PAGE_URL}/${name}`;

// One file out of a pkgbase's branch — ".SRCINFO" or "PKGBUILD".
export const aurFileUrl = (base, file) => `${AUR_RAW_URL}/${base}/${file}`;

// What the index knows about one package, or null if the AUR has no
// such name. Absent lists are absent because they were empty: the
// generator drops them, since writing `[]` 119k times over costs
// megabytes. A pkgbase equal to the name is implied the same way.
export async function aurEntry(name) {
  const entry = (await indexShard(`${AUR_INDEX_DIR}/pkgs`, name))[name];
  if (entry === undefined) {
    return null;
  }
  return {
    name,
    base: entry.base ?? name,
    version: entry.v ?? null,
    desc: entry.desc ?? "",
    url: entry.url ?? null,
    depends: entry.d ?? [],
    makedepends: entry.md ?? [],
    checkdepends: entry.cd ?? [],
    provides: entry.p ?? [],
    popularity: entry.pop ?? 0,
    votes: entry.votes ?? 0,
    // A timestamp when somebody flagged the package, null otherwise.
    outOfDate: entry.ood ?? null,
    modified: entry.m ?? null,
  };
}

// The AUR packages that provide a name nobody ships under it. A copy,
// because the shard behind it is memoised and shared with every other
// caller.
export async function aurProvidersOf(name) {
  const shard = await indexShard(`${AUR_INDEX_DIR}/provides`, name);
  return [...(shard[name] ?? [])];
}

const EMPTY_INDEX = { generated: null, count: 0, names: {} };

let indexPromise;
let namesPromise;

// Not fetched until something asks: this is the 9 MB file. A missing
// one means the deploy skipped the AUR, which is an empty AUR rather
// than an error — the page's binary lane still works.
function loadIndex() {
  indexPromise ??= indexJson(`${AUR_INDEX_DIR}/names.json`)
    .then((json) => json ?? EMPTY_INDEX)
    .catch(() => EMPTY_INDEX);
  return indexPromise;
}

// name -> one-line description, for the search box.
export function aurNames() {
  namesPromise ??= loadIndex().then(
    (index) => new Map(Object.entries(index.names ?? {})),
  );
  return namesPromise;
}

// When the AUR index was built and how many packages it covers, for
// the footer.
export async function aurInfo() {
  const index = await loadIndex();
  return {
    generated: index.generated ?? null,
    count: index.count ?? 0,
  };
}

// Names matching a query, best first, as { name, desc, repo }, ranked
// exactly as the binary lane ranks its own. Every hit is labelled
// "aur": there is one namespace here, and the label is what colours a
// hit as a thing that has to be built.
export async function searchAur(query, limit = SEARCH_LIMIT) {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [];
  }

  const hits = [];
  for (const [name, desc] of await aurNames()) {
    const rank = rankOf(name.toLowerCase(), desc ?? "", q);
    if (rank !== -1) {
      hits.push({ name, desc: desc ?? "", rank });
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  return hits.slice(0, limit).map(({ name, desc }) => ({
    name,
    desc,
    repo: "aur",
  }));
}

// Injectable so the tests read a recipe without a network. Separate
// from the index's fetcher: these are somebody else's host, with its
// own failures, and nothing here is memoised.
let recipeFetcher = (url, options) => fetch(url, options);

export function setRecipeFetcher(fn) {
  recipeFetcher = fn;
}

const NOT_FOUND = 404;

// The mirror rewrites a pkgbase's branch in place when the package is
// updated, so a cached copy is a recipe for the version before this
// one. Null means the mirror does not have the file.
async function fetchFile(url) {
  let res;
  try {
    res = await recipeFetcher(url, { cache: "no-cache" });
  } catch (err) {
    throw new Error(`${url}: ${err.message}`);
  }
  if (res.status === NOT_FOUND) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return await res.text();
}

// A pkgbase's recipe, as text and as a parsed Recipe. Both files are
// fetched: the .SRCINFO is what the page builds from — makepkg already
// expanded the bash — and the PKGBUILD is what a reader wants to see
// before running it.
export async function fetchAurRecipe(base, { arch = "x86_64" } = {}) {
  const urls = {
    srcinfo: aurFileUrl(base, ".SRCINFO"),
    pkgbuild: aurFileUrl(base, "PKGBUILD"),
    page: aurPageUrl(base),
  };

  const [srcinfo, pkgbuild] = await Promise.all([
    fetchFile(urls.srcinfo),
    // A PKGBUILD that would not load is not worth failing over, and its
    // failure must not stand in for the .SRCINFO's: nothing is built
    // from this copy.
    fetchFile(urls.pkgbuild).catch(() => null),
  ]);

  // A branch that does not exist is a package the mirror has never
  // seen — renamed, deleted, or newer than the mirror's last sync.
  if (srcinfo === null) {
    throw new Error(`${base} is not in the AUR mirror`);
  }

  return {
    base,
    srcinfo,
    pkgbuild,
    recipe: parseSrcinfo(srcinfo, { arch }),
    urls,
  };
}
