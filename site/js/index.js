// The package index: what the site knows about a name before it fetches
// anything.
//
// tools/build-index.py turns core.db and extra.db into static JSON next
// to the page — a names file for the search box, and shards holding one
// entry per package and one entry per provided name. The site fetches
// them with `cache: "no-cache"`, because the index is regenerated every
// six hours and a stale copy names files the mirrors have already
// deleted.
//
// Three things can override or extend it at runtime: a repo somebody
// pasted the URL of (addRepo), the freshness fallback that re-reads a
// mirror's own database when the index turns out to be stale
// (refreshRepo), and the Internet Archive for versions no repo has any
// more (archive.js, joined in by versions.js).

import {
  ARCH,
  INDEX_DIR,
  MIRRORS,
  PKGBUILD_URL,
  REPOS,
  SEARCH_LIMIT,
} from "./config.js";
import { fetchRepoDb, packageUrl } from "./repodb.js";
import { parseDepend } from "./vercmp.js";

// The shard function, byte for byte the one tools/build-index.py uses:
// FNV-1a over the UTF-8 name, low byte, two hex digits. Math.imul is
// what keeps the multiply 32-bit.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function shardOf(name) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return (hash & 0xff).toString(16).padStart(2, "0");
}

// Injectable so the tests can answer from a map instead of a server.
// Replacing it drops everything memoized: a test's index is not the
// previous test's.
let fetcher = (url, options) => fetch(url, options);

export function setFetcher(fn) {
  fetcher = fn;
  indexPromise = undefined;
  namesPromise = undefined;
  shards.clear();
}

// A fetch that fails outright (a dropped connection, a browser under
// pressure) is retried a few times: the answer to "is this package in
// the index" must not depend on one lost request, because a wrong "no"
// here becomes "nothing provides" for the rest of the boot.
const ATTEMPTS = 3;
const BACKOFF_MS = 300;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(path) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetcher(`${INDEX_DIR}/${path}`, { cache: "no-cache" });
      // A missing shard means no package hashes into it, which is the
      // same answer as a shard that loads and does not hold the name.
      if (res.status === NOT_FOUND) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt >= ATTEMPTS) {
        throw new Error(`${INDEX_DIR}/${path}: ${err.message}`);
      }
      await delay(BACKOFF_MS * attempt);
    }
  }
}

const NOT_FOUND = 404;

const EMPTY_INDEX = { generated: null, count: 0, repos: [], names: {} };

let indexPromise;
let namesPromise;

function loadIndex() {
  indexPromise ??= fetchJson("names.json")
    .then((json) => json ?? EMPTY_INDEX)
    .catch(() => EMPTY_INDEX);
  return indexPromise;
}

// name -> one-line description, for the search box and the completions.
export function names() {
  namesPromise ??= loadIndex().then(
    (index) => new Map(Object.entries(index.names ?? {})),
  );
  return namesPromise;
}

// When the index was built and what it covers, for the footer.
export async function indexInfo() {
  const index = await loadIndex();
  return {
    generated: index.generated ?? null,
    count: index.count ?? 0,
    repos: index.repos ?? [],
  };
}

const shards = new Map();

// A shard that could not be read is not remembered as empty: the
// failure is the caller's to report, and the next lookup tries again.
function shard(dir, name) {
  const key = `${dir}/${shardOf(name)}`;
  if (!shards.has(key)) {
    shards.set(
      key,
      fetchJson(`${key}.json`)
        .then((json) => json ?? {})
        .catch((err) => {
          shards.delete(key);
          throw err;
        }),
    );
  }
  return shards.get(key);
}

// A version's recipe: the project is the pkgbase with "+" spelled
// "plus" (libsigc++ is libsigcplusplus), the tag is the full version
// with ":" spelled "-" (1:26.2.2-1 is 1-26.2.2-1).
export function pkgbuildUrl(base, version) {
  if (!base || !version) {
    return null;
  }
  const project = base.replaceAll("+", "plus");
  const tag = version.replaceAll(":", "-");
  return `${PKGBUILD_URL}/${project}/-/blob/${tag}/PKGBUILD`;
}

// A Build from a database entry: what parseDesc read, plus where the
// bytes are and who vouches for them.
export function buildFromMeta(meta, { repo, urls, digest = null }) {
  const base = meta.base ?? meta.name;
  return {
    name: meta.name,
    base,
    version: meta.version,
    repo,
    filename: meta.filename,
    urls,
    size: meta.csize,
    isize: meta.isize,
    digest:
      digest ??
      (meta.sha256 ? { algorithm: "SHA-256", hex: meta.sha256 } : null),
    builddate: meta.builddate,
    desc: meta.desc,
    depends: meta.depends,
    provides: meta.provides,
    pkgbuild: pkgbuildUrl(base, meta.version),
  };
}

// A Build from an index shard entry. Every mirror is listed: mirrors
// delete superseded files within hours of a sync, and the next URL
// costs a 404 rather than a boot.
function buildFromEntry(name, entry) {
  const base = entry.base ?? name;
  return {
    name,
    base,
    version: entry.v,
    repo: entry.r,
    filename: entry.f,
    urls: MIRRORS.map((mirror) => `${mirror}${entry.r}/os/${ARCH}/${entry.f}`),
    size: entry.cs ?? null,
    isize: entry.is ?? null,
    digest: entry.sha ? { algorithm: "SHA-256", hex: entry.sha } : null,
    builddate: entry.b ?? null,
    desc: entry.desc ?? null,
    depends: entry.d ?? null,
    provides: entry.p ?? [],
    pkgbuild: pkgbuildUrl(base, entry.v),
  };
}

// Repos somebody pasted the URL of. They are part of the page's state
// and ride in its link, so nothing is remembered between visits.
const extra = [];

export function addRepo(label, dbUrl, entries) {
  const repo = { label, url: dbUrl, entries };
  const existing = extra.findIndex((one) => one.label === label);
  if (existing === -1) {
    extra.push(repo);
  } else {
    extra[existing] = repo;
  }
  return repo;
}

export const extraRepos = () => [...extra];

const fromExtra = (repo, meta) =>
  buildFromMeta(meta, {
    repo: repo.label,
    urls: [packageUrl(repo.url, meta.filename)],
  });

// An official repo's database as the mirrors have it right now,
// overriding the generated index for that repo. This is the freshness
// fallback: the index is rebuilt every six hours, a mirror drops a
// superseded package within hours of a sync, and in between the index
// names a file that 404s everywhere.
const overrides = new Map();

export async function refreshRepo(repo) {
  let last = null;
  for (const mirror of MIRRORS) {
    try {
      const entries = await fetchRepoDb(
        `${mirror}${repo}/os/${ARCH}/${repo}.db`,
      );
      overrides.set(repo, entries);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`no mirror served ${repo}.db: ${last?.message}`);
}

const fromOfficial = (meta, repo) =>
  buildFromMeta(meta, {
    repo,
    urls: MIRRORS.map(
      (mirror) => `${mirror}${repo}/os/${ARCH}/${meta.filename}`,
    ),
  });

// The build a bare name means today: an extra repo's, then a refreshed
// official repo's, then the index's.
export async function current(name) {
  for (const repo of extra) {
    const meta = repo.entries.get(name);
    if (meta !== undefined) {
      return fromExtra(repo, meta);
    }
  }

  for (const repo of REPOS) {
    const meta = overrides.get(repo)?.get(name);
    if (meta !== undefined) {
      return fromOfficial(meta, repo);
    }
  }

  const entry = (await shard("pkgs", name))[name];
  if (entry === undefined) {
    return null;
  }
  // A repo that was re-read is the truth about itself: a name the index
  // puts there and the fresh database does not hold is simply gone.
  if (overrides.has(entry.r)) {
    return null;
  }
  return buildFromEntry(name, entry);
}

// The packages that provide a name nobody ships under that name — `sh`
// comes from bash, `libz.so=1-64` from zlib. Extra repos are asked
// first, so a pasted repo can satisfy a dependency the official ones
// would have.
export async function providersOf(name) {
  const found = [];

  for (const repo of extra) {
    for (const [pkg, meta] of repo.entries) {
      if (meta.provides?.some((one) => parseDepend(one).name === name)) {
        found.push(pkg);
      }
    }
  }

  for (const pkg of (await shard("provides", name))[name] ?? []) {
    if (!found.includes(pkg)) {
      found.push(pkg);
    }
  }

  return found;
}

// How a search hit is ranked: exact name, then a name that starts with
// the query, then one that contains it, then a description that does.
function rankOf(name, desc, query) {
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  return desc.toLowerCase().includes(query) ? 3 : -1;
}

// Names matching a query, best first, as { name, desc, repo }. The repo
// is read from the package shard for each hit — a dozen small fetches
// that memoise immediately, which is what it costs to colour a hit by
// the repo it comes from, since names.json holds no repo.
export async function searchNames(query, limit = SEARCH_LIMIT) {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [];
  }

  const pool = new Map();
  for (const repo of extra) {
    for (const [name, meta] of repo.entries) {
      pool.set(name, { desc: meta.desc ?? "", repo: repo.label });
    }
  }
  for (const [name, desc] of await names()) {
    if (!pool.has(name)) {
      pool.set(name, { desc: desc ?? "", repo: null });
    }
  }

  const hits = [];
  for (const [name, { desc, repo }] of pool) {
    const rank = rankOf(name.toLowerCase(), desc, q);
    if (rank !== -1) {
      hits.push({ name, desc, repo, rank });
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

  return Promise.all(
    hits.slice(0, limit).map(async ({ name, desc, repo }) => ({
      name,
      desc,
      repo: repo ?? (await shard("pkgs", name))[name]?.r ?? "",
    })),
  );
}
