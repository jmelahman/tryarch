// A recipe the page can build, wherever it came from.
//
// Recipes arrive three ways — a name out of the AUR, the URL of a
// PKGBUILD somebody pasted, or files dropped on the page — and each
// becomes the same item: the parsed recipe, the PKGBUILD text the
// guest will run, where its files are to be found, and what the page
// has managed to gather so far. The item is the page's state for one
// recipe, redrawn as sources arrive; the build itself is build.js.
//
// Local files — patches, .desktop files, an .install script — are
// looked for beside the PKGBUILD first, at `origin`: the AUR mirror's
// branch for an AUR recipe, the URL's directory for a pasted one.
// Whatever the visitor drops on the page wins over that, because they
// went and got it after the fetch could not.

import { aurEntry, aurFileUrl, aurPageUrl, fetchAurRecipe } from "./aur.js";
import { buildWants, profileFor } from "./buildenv.js";
import { fetchWithProgress, mapConcurrent } from "./net.js";
import { parsePkgbuild } from "./pkgbuild.js";
import { fetchSources, sourceRows } from "./recipe.js";

// The file a dropped recipe has to include, by that exact name.
const PKGBUILD = "PKGBUILD";

// Files beside a PKGBUILD are usually small and on a host that has
// already answered once; a failure is a row for the visitor, not a
// retry storm.
const BESIDE_ATTEMPTS = 2;
const BESIDE_CONCURRENCY = 3;

const encoder = new TextEncoder();

// `id` is what the link carries: the AUR name, the URL, or for dropped
// files the base, which no link can restore.
function item({ id, kind, base, recipe, pkgbuild, page, origin, supplied }) {
  return {
    key: `${kind}:${id}`,
    id,
    kind,
    base,
    recipe,
    pkgbuild,
    page,
    origin,
    supplied,
    // Filled by gatherSources.
    files: new Map(),
    problems: [],
    rows: [],
    missing: [],
    ready: false,
    profile: profileFor(recipe, pkgbuild),
  };
}

// A recipe out of the AUR, by package name: the mirror keeps one
// branch per pkgbase, so a split package's name is first mapped to
// its base through the index.
export async function recipeFromAur(name) {
  const entry = await aurEntry(name);
  const base = entry?.base ?? name;
  const { recipe, pkgbuild, urls } = await fetchAurRecipe(base);
  if (pkgbuild === null) {
    throw new Error(
      `${base}: the mirror has the .SRCINFO but not the PKGBUILD`,
    );
  }
  return item({
    id: name,
    kind: "aur",
    base,
    recipe,
    pkgbuild,
    page: urls.page ?? aurPageUrl(base),
    origin: aurFileUrl(base, ""),
    supplied: new Map(),
  });
}

// A PKGBUILD by URL. The text is read fresh — a recipe is edited in
// place — and parsed here, since there is no .SRCINFO to lean on.
export async function recipeFromUrl(url) {
  let res;
  try {
    res = await fetch(url, { cache: "no-cache" });
  } catch (err) {
    throw new Error(`${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  const pkgbuild = await res.text();
  const recipe = parsePkgbuild(pkgbuild);
  return item({
    id: url,
    kind: "url",
    base: recipe.base,
    recipe,
    pkgbuild,
    page: url,
    origin: url.slice(0, url.lastIndexOf("/") + 1),
    supplied: new Map(),
  });
}

// Files dropped on the page: one must be the PKGBUILD, the rest are
// taken as its sources and scripts. Nothing about this rides in the
// link — there is no URL for a file on somebody's disk.
export function recipeFromFiles(files) {
  const bytes = files.get(PKGBUILD);
  if (bytes === undefined) {
    throw new Error(`no file named ${PKGBUILD} among those`);
  }
  const pkgbuild = new TextDecoder().decode(bytes);
  const recipe = parsePkgbuild(pkgbuild);
  const supplied = new Map(files);
  supplied.delete(PKGBUILD);
  return item({
    id: recipe.base,
    kind: "files",
    base: recipe.base,
    recipe,
    pkgbuild,
    page: null,
    origin: null,
    supplied,
  });
}

// The files named beside the PKGBUILD that nobody has supplied, read
// from `origin` if there is one. A file that will not come is simply
// not in the map: fetchSources reports it, with the URL to go and get.
async function fetchBeside(item, onBytes) {
  const found = new Map();
  if (item.origin === null) {
    return found;
  }
  const wanted = item.recipe.files.filter((name) => !item.supplied.has(name));
  await mapConcurrent(wanted, BESIDE_CONCURRENCY, async (name) => {
    try {
      const bytes = await fetchWithProgress(`${item.origin}${name}`, {
        onBytes,
        attempts: BESIDE_ATTEMPTS,
      });
      found.set(name, bytes);
    } catch {
      // reported by the row, not here
    }
  });
  return found;
}

// The scripts a recipe names outside source=(): an .install file and a
// changelog, which fetchSources does not know about.
const scriptsOf = (recipe) => {
  const sources = new Set(recipe.sources.map((source) => source.filename));
  return recipe.files.filter((name) => !sources.has(name));
};

// Gather everything the build needs and record what is still missing.
// Safe to call again after the visitor supplies a file: the fetched
// ones come from the cache the second time.
export async function gatherSources(item, { onBytes = () => {} } = {}) {
  const beside = await fetchBeside(item, onBytes);
  const supplied = new Map([...beside, ...item.supplied]);
  const { files, problems } = await fetchSources(item.recipe, {
    supplied,
    onBytes,
  });

  const rows = sourceRows(item.recipe, { files, problems });
  for (const name of scriptsOf(item.recipe)) {
    const bytes = supplied.get(name);
    if (bytes !== undefined) {
      files.set(name, bytes);
    }
    rows.push({
      filename: name,
      url: item.origin === null ? null : `${item.origin}${name}`,
      kind: "local",
      status: bytes === undefined ? "missing" : "ready",
      size: bytes?.byteLength ?? null,
      reason: bytes === undefined ? "not supplied" : null,
    });
  }

  item.files = files;
  item.problems = problems;
  item.rows = rows;
  item.missing = rows.filter((row) => row.status !== "ready");
  item.ready = item.missing.length === 0;
  return item;
}

// Files the visitor dropped for this recipe. They are kept, and the
// sources are gathered again with them in hand.
export function supply(item, files) {
  for (const [name, bytes] of files) {
    item.supplied.set(name, bytes);
  }
  return gatherSources(item);
}

// What has to be in the guest for this recipe to build, for the
// closure walk.
export const recipeWants = (item) => ({
  via: item.base,
  specs: buildWants(item.recipe, item.profile),
});

// The PKGBUILD as the guest gets it.
export const pkgbuildBytes = (item) => encoder.encode(item.pkgbuild);
