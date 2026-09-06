// The URL is the boot's state. Everything selected lives in the query
// string, so any environment is a link someone can send:
//
//   ?pkg=jq@1.7.1-2,bash   packages, at a version or at the newest
//   ?pkg=ripgrep           whatever the index calls current
//   &aur=yay-bin,paru      packages to build from the AUR, by name
//   &pkgbuild=https://…    a recipe somebody pasted the URL of
//   &repo=https://…/x.db   an extra pacman repository
//   &boot=1                start without a click
//
// An AUR package carries no version: the AUR has exactly one recipe
// per name and it is whatever it is today. A pkgbuild is a URL, so it
// is never split on commas — a URL may hold one.
//
// Everything is written back with replaceState as it changes, so the
// address bar is always the link for what is on screen — the repo
// somebody pasted travels in the same link as the packages taken from
// it.

const PARAM_PKG = "pkg";
const PARAM_AUR = "aur";
const PARAM_PKGBUILD = "pkgbuild";
const PARAM_REPO = "repo";
const PARAM_BOOT = "boot";
const VERSION_SEPARATOR = "@";

// A comma-separated, repeatable list of names, blanks dropped.
const nameList = (params, key) =>
  params
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((one) => one.trim())
    .filter(Boolean);

// A repeatable list of URLs, which are never split: a URL may hold a
// comma.
const urlList = (params, key) =>
  params
    .getAll(key)
    .map((url) => url.trim())
    .filter(Boolean);

// { pkgs: [{name, version|null}], repos: [url], aur: [name],
//   pkgbuilds: [url], boot: boolean }
//
// The query string is a parameter so the tests can read one without a
// document; the page calls it with none.
export function readUrl(search = globalThis.location?.search ?? "") {
  const params = new URLSearchParams(search);

  const pkgs = params.getAll(PARAM_PKG).flatMap((spec) =>
    spec
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean)
      .map((one) => {
        const at = one.lastIndexOf(VERSION_SEPARATOR);
        if (at === -1) {
          return { name: one, version: null };
        }
        return { name: one.slice(0, at), version: one.slice(at + 1) };
      }),
  );

  return {
    pkgs,
    repos: urlList(params, PARAM_REPO),
    aur: nameList(params, PARAM_AUR),
    pkgbuilds: urlList(params, PARAM_PKGBUILD),
    boot: params.get(PARAM_BOOT) === "1",
  };
}

// Rewrite the address bar to describe the current selection. `boot`
// stays out unless asked for: a shared link should offer the boot, and
// only the reload path wants it automatic.
export function writeUrl(
  { pkgs = [], repos = [], aur = [], pkgbuilds = [] },
  { boot = false } = {},
) {
  const params = new URLSearchParams();
  for (const { name, version } of pkgs) {
    params.append(
      PARAM_PKG,
      version === null || version === undefined
        ? name
        : `${name}${VERSION_SEPARATOR}${version}`,
    );
  }
  // What is being installed comes before where it comes from, so the
  // link reads the way the page does.
  for (const name of aur) {
    params.append(PARAM_AUR, name);
  }
  for (const url of pkgbuilds) {
    params.append(PARAM_PKGBUILD, url);
  }
  for (const url of repos) {
    params.append(PARAM_REPO, url);
  }
  if (boot) {
    params.set(PARAM_BOOT, "1");
  }

  // The site is a project page under /tryarch/, so the path is kept and
  // never assumed to be "/".
  const path = globalThis.location?.pathname ?? "/";
  const query = params.toString();
  return `${path}${query === "" ? "" : `?${query}`}`;
}
