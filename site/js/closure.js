// Walking a dependency closure from the selected builds, fetching each
// package as it is discovered. Every lookup is a browser fetch against
// the site's own index, a CORS-enabled mirror, or archive.org — no
// server anywhere.
//
// An Arch package names its dependencies loosely: by package name, by
// a name with a version constraint (`linux-api-headers>=4.10`), or by
// something only *provided* by a package (`sh`, `libz.so=1-64`). Each
// is turned into one concrete build here, and the walk keeps one build
// per package name, the way pacman keeps one installed version.
//
// Dependencies of a current build are known from the index, so the
// walk runs ahead of the downloads; an archived build only says what
// it needs in its own .PKGINFO, so its dependencies are queued once it
// has been fetched.

import { PACKAGE_CONCURRENCY, REPOS } from "./config.js";
import { current, providersOf, refreshRepo } from "./index.js";
import { fetchPackage, NotFoundError } from "./pkg.js";
import { parseDepend, satisfies } from "./vercmp.js";
import { pickBuild, versionsOf } from "./versions.js";
import { log } from "./log.js";

// A dependency on a shared object (`libz.so=1-64`) is never a package
// name, so the provides table is consulted straight away rather than
// after a lookup that cannot succeed.
const isSoname = (name) => name.includes(".so");

// Strip the version from a provides entry: `libz.so=1-64` provides
// `libz.so`.
const providedName = (spec) => parseDepend(spec).name;

// Walk from `roots` (Build[], selection order), fetching at most
// PACKAGE_CONCURRENCY packages at a time. Each fetched package is handed
// to `onPackage(pkg)` as soon as it is unpacked and is not kept here.
//
// `known` maps the names already in the guest to their builds: they
// satisfy dependencies but are neither fetched nor reported again.
// Resolves to { builds, problems }: the builds fetched by this walk in
// completion order, and what could not be resolved. A dependency that
// cannot be found is reported and skipped rather than failing the walk:
// a program is often usable without the one library nothing can name.
// A root that cannot be fetched fails the walk.
export async function walkClosure(
  roots,
  {
    known = new Map(),
    onDiscover = () => {},
    onPackage = async () => {},
    onBytes = () => {},
    onTotal = () => {},
  } = {},
) {
  // name -> build, for everything queued or present.
  const visited = new Map(known);
  // provided name -> build, from the same set.
  const provided = new Map();
  for (const build of known.values()) {
    for (const spec of build.provides ?? []) {
      provided.set(providedName(spec), build);
    }
  }
  // Dependency names whose resolution is under way or settled, so a
  // diamond (two packages needing glibc) resolves it once.
  const resolving = new Map();

  const pending = [];
  const builds = [];
  const problems = [];
  let expected = 0;
  let active = 0;
  let waiting = [];

  const wake = () => {
    for (const resolve of waiting.splice(0)) {
      resolve();
    }
  };

  const enqueue = (build, { era, root }) => {
    visited.set(build.name, build);
    for (const spec of build.provides ?? []) {
      if (!provided.has(providedName(spec))) {
        provided.set(providedName(spec), build);
      }
    }
    expected += build.size ?? 0;
    onTotal(expected);
    onDiscover(build);
    pending.push({ build, era, root });
    wake();
  };

  // One dependency string of a build, in the era its root set.
  async function resolve(spec, { era, via }) {
    const constraint = parseDepend(spec);
    const { name } = constraint;

    const existing = visited.get(name) ?? provided.get(name);
    if (existing !== undefined) {
      if (
        visited.has(name) &&
        constraint.op !== null &&
        !satisfies(existing.version, constraint)
      ) {
        problems.push(
          `${via} wants ${spec}, ${name} ${existing.version} is in the closure`,
        );
      }
      return;
    }
    if (resolving.has(name)) {
      return resolving.get(name);
    }
    const work = (async () => {
      const build = await candidateFor(constraint, era);
      if (build === null) {
        problems.push(`nothing provides ${spec} (wanted by ${via})`);
        return;
      }
      // Another resolution may have queued it under a provided name in
      // the meantime.
      if (!visited.has(build.name)) {
        enqueue(build, { era, root: false });
      }
    })();
    resolving.set(name, work);
    return work;
  }

  // The build that satisfies a constraint: the package of that name
  // when there is one, else the first package providing the name. In
  // the current era the index answers; in an archived one, the newest
  // build no later than the root, so a 2016 program gets a 2016 libc.
  async function candidateFor(constraint, era) {
    const { name } = constraint;
    if (!isSoname(name)) {
      const direct =
        era === null
          ? await current(name)
          : pickBuild(await versionsOf(name), constraint, { before: era });
      if (
        direct !== null &&
        (era !== null || constraintAllows(direct, constraint))
      ) {
        return direct;
      }
    }
    for (const provider of await providersOf(name)) {
      if (visited.has(provider)) {
        return visited.get(provider);
      }
      const build =
        era === null
          ? await current(provider)
          : pickBuild(
              await versionsOf(provider),
              { name: provider, op: null, version: null },
              { before: era },
            );
      if (build !== null) {
        return build;
      }
    }
    return null;
  }

  // A current build is taken even when it is short of a version
  // constraint: the repos are consistent with themselves, and a mismatch
  // means the index is a few hours behind, which the fetch fallback
  // will settle. The mismatch is still reported.
  function constraintAllows(build, constraint) {
    if (constraint.op === null || satisfies(build.version, constraint)) {
      return true;
    }
    problems.push(
      `${build.name} ${build.version} is what the repos have; ${constraint.name}${constraint.op}${constraint.version} was asked for`,
    );
    return true;
  }

  // Fetch one build; when its file is gone from every mirror, the repo
  // has moved on since the index was built, so the repo's own db says
  // what replaced it.
  async function fetchFresh(build) {
    try {
      return await fetchPackage(build, { onBytes });
    } catch (err) {
      if (!(err instanceof NotFoundError) || !REPOS.includes(build.repo)) {
        throw err;
      }
      log(
        `${build.filename} is gone from the mirrors; refreshing ${build.repo}`,
      );
      await refreshRepo(build.repo);
      const fresh = await current(build.name);
      if (fresh === null || fresh.filename === build.filename) {
        throw err;
      }
      visited.set(fresh.name, fresh);
      return fetchPackage(fresh, { onBytes });
    }
  }

  async function worker() {
    for (;;) {
      if (pending.length === 0) {
        if (active === 0) {
          return;
        }
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      const { build, era, root } = pending.shift();
      active += 1;
      try {
        const known = build.depends !== null;
        // Dependencies the index already knows are resolved while the
        // package is still downloading.
        const ahead = known
          ? Promise.all(
              build.depends.map((spec) =>
                resolve(spec, { era, via: build.name }),
              ),
            )
          : null;
        let pkg;
        try {
          pkg = await fetchFresh(build);
        } catch (err) {
          if (root) {
            throw err;
          }
          problems.push(`${build.name} ${build.version}: ${err.message}`);
          continue;
        }
        builds.push(pkg.build);
        await onPackage(pkg);
        if (ahead !== null) {
          await ahead;
        } else {
          await Promise.all(
            (pkg.build.depends ?? []).map((spec) =>
              resolve(spec, { era, via: build.name }),
            ),
          );
        }
      } finally {
        active -= 1;
        wake();
      }
    }
  }

  for (const root of roots) {
    if (visited.has(root.name)) {
      const have = visited.get(root.name);
      if (have.version !== root.version) {
        problems.push(
          `${root.name} ${root.version} skipped: ${have.version} is already in the closure`,
        );
      }
      continue;
    }
    // An archived root sets the era for everything it pulls in; a
    // current one takes the repos as they are.
    const era = root.repo === "archive" ? (root.builddate ?? null) : null;
    enqueue(root, { era, root: true });
  }

  await Promise.all(Array.from({ length: PACKAGE_CONCURRENCY }, worker));
  return { builds, problems };
}
