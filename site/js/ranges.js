// The spec lane: a line of package specs, each a name and an optional
// version constraint, resolved against everything the page can reach.
//
//   jq  bash@>=5.2  python@3.11.*  glibc@2.40-1
//
// Both spellings are accepted, the site's own "name@constraint" and
// pacman's bare "name>=5.2", because the second is what a reader has in
// front of them in a PKGBUILD or a `pacman -Si` listing.
//
// Each spec is resolved on its own: the newest version that matches.
// That can hand back a set that never coexisted in one repo, which is
// fine here — packages are unpacked side by side, not solved for — but
// it is not a coexistence guarantee, and the page says so.

import { pickBuild, versionsOf } from "./versions.js";
import { satisfies } from "./vercmp.js";

// name, an optional "@", an optional operator, and a version pattern.
const SPEC = /^([^@\s<>=]+)(?:@?(>=|<=|>|<|=)?([^\s]*))?$/;

export function parseSpecs(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((raw) => {
      const match = SPEC.exec(raw);
      if (match === null) {
        throw new Error(`cannot parse "${raw}"`);
      }
      const [, name, op, version] = match;
      return {
        raw,
        name,
        op: op ?? null,
        version: version === "" || version === undefined ? null : version,
      };
    });
}

// Does one build match one spec? A pattern with a "*" is a prefix match
// on the version string, which is how a reader asks for "any 3.11";
// everything else is pacman's own comparison, so a constraint without a
// release ignores the candidate's release.
export function matches(build, spec) {
  if (spec.version === null) {
    return true;
  }

  const star = spec.version.indexOf("*");
  if (star !== -1) {
    const prefix = spec.version.slice(0, star).replace(/[.-]$/, "");
    return build.version === prefix || build.version.startsWith(`${prefix}.`);
  }

  // A version with no operator pins it: "jq@1.7.1" is "=1.7.1".
  return satisfies(build.version, {
    op: spec.op ?? "=",
    version: spec.version,
  });
}

// Resolve every spec to its newest matching build. Returns
// { resolved, problems }, with a line of prose per spec that could not
// be answered.
export async function resolveSpecs(specs) {
  const resolved = [];
  const problems = [];

  for (const spec of specs) {
    const builds = await versionsOf(spec.name);
    if (builds.length === 0) {
      problems.push(`${spec.name} is in no repo the page can reach`);
      continue;
    }

    const candidates = builds.filter((build) => matches(build, spec));
    const hit = pickBuild(candidates, null);
    if (hit === null) {
      problems.push(
        `no version of ${spec.name} matches ${spec.op ?? ""}${spec.version}`,
      );
      continue;
    }
    resolved.push(hit);
  }

  return { resolved, problems };
}
