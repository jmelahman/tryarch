// Every version of a name the page can actually reach, in one list.
//
// Three sources answer, and they overlap: a repo somebody pasted, the
// official repos as the index has them, and the Internet Archive's copy
// of everything Arch has shipped. The first to name a version wins, so a
// build that is still in a repo is fetched from a mirror rather than
// from archive.org.

import { archivedBuilds } from "./archive.js";
import { buildFromMeta, current, extraRepos } from "./index.js";
import { packageUrl } from "./repodb.js";
import { satisfies, vercmp } from "./vercmp.js";

const lists = new Map();

// Newest first. Memoised per name: the version list is read again on
// every keystroke in the spec box and on every dependency the walk
// resolves against an era.
export function versionsOf(name) {
  if (!lists.has(name)) {
    lists.set(
      name,
      load(name).catch((err) => {
        // A failed lookup must not be the answer for the rest of the
        // session; the next call tries again.
        lists.delete(name);
        throw err;
      }),
    );
  }
  return lists.get(name);
}

async function load(name) {
  const builds = [];

  for (const repo of extraRepos()) {
    const meta = repo.entries.get(name);
    if (meta !== undefined) {
      builds.push(
        buildFromMeta(meta, {
          repo: repo.label,
          urls: [packageUrl(repo.url, meta.filename)],
        }),
      );
    }
  }

  const now = await current(name);
  if (now !== null) {
    builds.push(now);
  }

  builds.push(...(await archivedBuilds(name)));

  const seen = new Set();
  const unique = [];
  for (const build of builds) {
    if (!seen.has(build.version)) {
      seen.add(build.version);
      unique.push(build);
    }
  }

  return unique.sort((a, b) => vercmp(b.version, a.version));
}

const newest = (builds) =>
  builds.reduce((best, build) =>
    vercmp(build.version, best.version) > 0 ? build : best,
  );

// The build to use for a constraint, optionally as of a moment.
//
// `before` is the era rule: booting a 2018 package means resolving its
// dependencies against 2018, because a 2018 binary against today's
// glibc is a segfault, not a boot. It is a preference and not a filter —
// a dependency the archive has no dated build of is better satisfied by
// today's than not at all.
export function pickBuild(builds, constraint, { before = null } = {}) {
  const allowed = builds.filter((build) =>
    satisfies(build.version, constraint),
  );
  if (allowed.length === 0) {
    return null;
  }

  if (before !== null && allowed.some((build) => build.builddate !== null)) {
    const era = allowed.filter(
      (build) => build.builddate !== null && build.builddate <= before,
    );
    if (era.length > 0) {
      return newest(era);
    }
  }

  return newest(allowed);
}
