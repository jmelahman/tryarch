#!/usr/bin/env python3
"""Copy the browser's libraries out of node_modules into the site.

The page is cross-origin isolated -- it needs SharedArrayBuffer, so it
sends COOP/COEP -- and under that policy every cross-origin subresource
has to carry a CORP header nobody controls on a CDN. So none of these
libraries are loaded from one: they are served from the site itself,
same-origin. npm is what pins them (exact versions in package.json,
hashes in package-lock.json) and this copies out the seven files the
page actually loads, because the installed tree around them is megabytes
of sources, types and tests the browser never asks for.

xterm-pty is a UMD bundle exposing the openpty global: the line
discipline, pinned to the version whose emscripten-pty.js the qemu-wasm
build linked against. xzwasm exposes XzReadableStream and fzstd exposes
decompress, because Arch's packages are zstd today and xz in the older
files a mirror still holds. ghostty-web is libghostty-vt compiled to
wasm with xterm.js-shaped bindings. coi-serviceworker installs the
COOP/COEP headers on hosts that cannot set them, GitHub Pages among
them.

The names on the way out are not free to change: site/index.html and
site/js/*.js ask for exactly these.
"""

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_NODE_MODULES = os.path.join(ROOT, "node_modules")
DEFAULT_PATCHES = os.path.join(ROOT, "patches")

# (package, path inside it, destination relative to the site root).
# A destination ending in "/" keeps the source's own name, which is how
# the one file below whose name carries a hash gets copied.
#
# coi-serviceworker lands at the site root rather than under vendor/: a
# service worker's scope is the directory it was served from, so a
# worker under vendor/ could never control index.html -- it would reload
# the page forever trying.
COPIES = (
    ("xterm-pty", "index.js", "vendor/xterm-pty.js"),
    # The readable build, not the minified one, so the patch below
    # applies to it.
    ("xzwasm", "dist/package/xzwasm.js", "vendor/xzwasm.js"),
    ("fzstd", "umd/index.js", "vendor/fzstd.js"),
    ("ghostty-web", "dist/ghostty-web.js", "vendor/ghostty-web.js"),
    # The wasm sits beside the module because that is where the module
    # looks for it.
    ("ghostty-web", "ghostty-vt.wasm", "vendor/ghostty-vt.wasm"),
    # A stub ghostty-web dynamically imports on a Node-only readFile
    # fallback. Copied so the browser's probe for it is a hit and not a
    # 404 in the console; its name carries a build hash, hence the glob.
    ("ghostty-web", "dist/__vite-browser-external-*.js", "vendor/"),
    ("coi-serviceworker", "coi-serviceworker.min.js", "coi-serviceworker.js"),
)

# Vendored files that get patches/<name>/*.patch applied in place, with
# `patch -p1` run in the directory the file was copied into (the diffs
# are against a/<basename>).
PATCHED = (("vendor/xzwasm.js", "xzwasm"),)


def installed_version(node_modules, package):
    """The version npm actually installed, or None if it is not there."""
    manifest = os.path.join(node_modules, package, "package.json")
    if not os.path.isfile(manifest):
        return None
    with open(manifest) as f:
        return json.load(f).get("version")


def check_versions(node_modules, packages):
    """Fail unless every package is installed at the version we pinned.

    The vendored bytes are what the page ships, so a tree left behind by
    an older package.json would quietly deploy a different library. npm
    ci makes this impossible; a stale `npm install` does not.
    """
    with open(os.path.join(os.path.dirname(node_modules), "package.json")) as f:
        wanted = json.load(f).get("devDependencies", {})

    problems = []
    for package in packages:
        want = wanted.get(package)
        if want is None:
            problems.append(f"{package} is not a devDependency of package.json")
            continue
        got = installed_version(node_modules, package)
        if got is None:
            problems.append(f"{package} is not installed under {node_modules}")
        elif got != want:
            problems.append(f"{package} is {got}, but package.json pins {want}")

    if problems:
        sys.exit("\n".join(["run `npm ci` first:", *problems]))


def resolve(node_modules, package, pattern):
    """The one file `pattern` names inside an installed package."""
    directory, _, leaf = pattern.rpartition("/")
    base = os.path.join(node_modules, package, directory)
    if "*" not in leaf:
        path = os.path.join(base, leaf)
        if not os.path.isfile(path):
            sys.exit(f"{package} has no {pattern}")
        return path

    if not os.path.isdir(base):
        sys.exit(f"{package} has no {directory or '.'}/")
    matches = sorted(name for name in os.listdir(base) if fnmatch.fnmatch(name, leaf))
    if len(matches) != 1:
        sys.exit(f"{package}/{pattern} matched {len(matches)} files, expected one")
    return os.path.join(base, matches[0])


def apply_patches(outdir, patches):
    """Patch the vendored copies in place, `patch -p1` in their directory."""
    for destination, name in PATCHED:
        directory = os.path.join(patches, name)
        if not os.path.isdir(directory):
            continue
        target = os.path.join(outdir, os.path.dirname(destination))
        for leaf in sorted(os.listdir(directory)):
            if not leaf.endswith(".patch"):
                continue
            path = os.path.join(directory, leaf)
            print(f"  patching {destination} with {name}/{leaf}", file=sys.stderr)
            with open(path, "rb") as f:
                subprocess.run(["patch", "-d", target, "-p1"], stdin=f, check=True)


def vendor(outdir, node_modules=DEFAULT_NODE_MODULES, patches=DEFAULT_PATCHES):
    """Copy every vendored file into `outdir` and patch what needs it."""
    check_versions(node_modules, sorted({package for package, _, _ in COPIES}))

    for package, pattern, destination in COPIES:
        source = resolve(node_modules, package, pattern)
        if destination.endswith("/"):
            destination += os.path.basename(source)
        target = os.path.join(outdir, destination)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(source, target)
        # The wasm comes out of the tarball executable; nothing served
        # over HTTP needs that.
        os.chmod(target, 0o644)
        print(f"  {destination} <- {package}/{pattern}", file=sys.stderr)

    apply_patches(outdir, patches)


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("outdir", help="the site root to copy into")
    parser.add_argument(
        "--node-modules",
        default=DEFAULT_NODE_MODULES,
        help="the installed tree to copy out of (default: this repository's)",
    )
    parser.add_argument(
        "--patches",
        default=DEFAULT_PATCHES,
        help="the patches directory (default: this repository's)",
    )
    args = parser.parse_args()

    vendor(args.outdir, args.node_modules, args.patches)
    print(f"vendored into {args.outdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
