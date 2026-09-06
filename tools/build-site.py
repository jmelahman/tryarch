#!/usr/bin/env python3
"""Assemble the deployable tree: everything the pages workflow uploads.

    index.html, style.css, fonts/  the site itself
    js.<hash>/                     its modules, renamed per build
    vendor/                        the pinned browser libraries
    qemu/                          the engine and the migration snapshot
    guest/                         kernel, initramfs, BIOS blobs
    assets.json                    content hashes for the two above

The package index is deliberately not part of it: it goes stale within
hours (tools/build-index.py builds it separately at deploy time), while
everything here is fixed by the commit.

Two cache-busting tricks, both of them load-bearing. The module tree is
hashed and renamed js.<hash>, so the HTML and the modules it pulls in
can never be a mismatched pair across deploys -- a browser holding a
cached index.html would otherwise pair it with new modules, or the other
way round. The engine, snapshot and guest image cannot be renamed (the
snapshot is 32 MB and the page keeps it in the Cache API, which keys on
the URL), so they get content hashes in assets.json and the page appends
them as a query string instead.

The one thing this checks rather than builds is the guest image. The
snapshot in the pinned release is a RAM image of one particular kernel
and initramfs, and it only resumes on the machine those were booted on,
so the committed guest/ must be the guest the snapshot was taken
against. engine-pins.json records its hashes and a mismatch stops the
build.
"""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

DEFAULT_SITE = os.path.join(ROOT, "site")
DEFAULT_GUEST = os.path.join(ROOT, "guest")
DEFAULT_PINS = os.path.join(ROOT, "engine-pins.json")

# The four files a locally built engine must supply, so a --qemu-dir
# missing the snapshot fails here rather than in the browser.
ENGINE_FILES = (
    "out.js",
    "qemu-system-x86_64.wasm",
    "qemu-system-x86_64.worker.js",
    "vm.state",
)

# Enough of a sha256 to make a collision irrelevant here; the same
# length tools/asset-versions.py uses.
HASH_LENGTH = 12

# What an output directory has to contain before it is safe to delete:
# the first and the last thing a build writes.
BUILD_MARKERS = ("index.html", "assets.json")

# Dropped in as soon as a build starts and removed when it finishes, so
# a build that failed halfway -- no assets.json yet -- is still
# recognisable as ours and can be replaced by the next attempt.
IN_PROGRESS = ".build-in-progress"

MISMATCH = (
    "the snapshot in the pinned release was taken against a different guest "
    "image; rebuild the snapshot with tools/make-snapshot.py and publish it "
    "with tools/publish-engine.py, see docs/engine.md"
)


def load(name):
    """Import a sibling script whose file name is not an identifier."""
    path = os.path.join(HERE, name)
    spec = importlib.util.spec_from_file_location(
        name.removesuffix(".py").replace("-", "_"), path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vendor_tool = load("vendor.py")
fetch_engine_tool = load("fetch-engine.py")


def sha256_hex(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sri(path):
    return "sha256-" + base64.b64encode(bytes.fromhex(sha256_hex(path))).decode()


def prepare(outdir):
    """Empty the output directory, refusing anything that is not ours.

    OUTDIR is deleted wholesale, so it had better be a previous build:
    a mistyped path is otherwise a `rm -rf` on whatever it named.
    """
    if not os.path.exists(outdir):
        os.makedirs(outdir)
        return
    if not os.path.isdir(outdir):
        sys.exit(f"{outdir} is not a directory")

    if os.listdir(outdir) and not os.path.exists(os.path.join(outdir, IN_PROGRESS)):
        missing = [
            marker
            for marker in BUILD_MARKERS
            if not os.path.exists(os.path.join(outdir, marker))
        ]
        if missing:
            sys.exit(
                f"{outdir} is not empty and does not look like a previous build "
                f"(no {' and no '.join(missing)}); refusing to replace it"
            )
    shutil.rmtree(outdir)
    os.makedirs(outdir)


def copy_site(site, outdir):
    """Copy site/ over, minus the index a local build may have left in it.

    site/index/ is where `python3 tools/build-index.py site/index` puts
    an index for `tools/serve.py` to pick up. It is megabytes, it is
    stale within hours, and the deploy builds its own, so it never
    belongs in an artifact.
    """
    top = os.path.abspath(site)

    def ignore(directory, names):
        if os.path.abspath(directory) != top:
            return set()
        return {name for name in names if name == "index"}

    shutil.copytree(site, outdir, dirs_exist_ok=True, ignore=ignore)


def copy_engine(qemu_dir, outdir, pins_path, cache):
    """The engine and snapshot: fetched by hash, or taken from a local build."""
    target = os.path.join(outdir, "qemu")
    if not qemu_dir:
        fetch_engine_tool.fetch_engine(target, pins_path, cache)
        return

    missing = [
        name for name in ENGINE_FILES if not os.path.isfile(os.path.join(qemu_dir, name))
    ]
    if missing:
        sys.exit(f"{qemu_dir} is missing {', '.join(missing)}")

    os.makedirs(target, exist_ok=True)
    for name in sorted(os.listdir(qemu_dir)):
        path = os.path.join(qemu_dir, name)
        if os.path.isfile(path):
            shutil.copyfile(path, os.path.join(target, name))
    print(f"  qemu/: {qemu_dir}", file=sys.stderr)


def copy_guest(guest, outdir, pins_path, check):
    """Copy the committed guest image, first checking it is the pinned one.

    guest/src/ holds what the image is built from (tools/build-guest.sh)
    and is not served, so only the regular files at the top go out.
    """
    target = os.path.join(outdir, "guest")
    os.makedirs(target, exist_ok=True)
    copied = 0
    for name in sorted(os.listdir(guest)):
        path = os.path.join(guest, name)
        if os.path.isfile(path):
            shutil.copyfile(path, os.path.join(target, name))
            copied += 1

    if not check:
        # A locally built engine comes with its own snapshot, taken
        # against whatever guest is in the tree, so the pinned hashes say
        # nothing about it.
        print("  guest/: not checked against the pins (--qemu-dir)", file=sys.stderr)
        return copied

    with open(pins_path) as f:
        pins = json.load(f).get("guest", {})

    problems = []
    for name, want in sorted(pins.items()):
        path = os.path.join(guest, name)
        if not os.path.isfile(path):
            problems.append(f"{name} is missing from {guest}")
            continue
        got = sri(path)
        if got != want:
            problems.append(f"{name} is {got}, but the snapshot was taken against {want}")

    if problems:
        sys.exit("\n".join([*problems, MISMATCH]))
    return copied


def hash_modules(outdir):
    """The digest of the module tree, over its file hashes and its names.

    Byte for byte the shell it replaces:

        find js -type f | LC_ALL=C sort | xargs sha256sum | sha256sum

    so a tree that hashed to js.abc under the flake still hashes to
    js.abc here, and a deploy across the change is not a cache flush.
    """
    base = os.path.join(outdir, "js")
    names = []
    for directory, _, leaves in os.walk(base):
        for leaf in leaves:
            path = os.path.join(directory, leaf)
            names.append(os.path.join("js", os.path.relpath(path, base)))

    listing = "".join(
        f"{sha256_hex(os.path.join(outdir, name))}  {name}\n" for name in sorted(names)
    )
    return hashlib.sha256(listing.encode()).hexdigest()[:HASH_LENGTH]


def rename_modules(outdir):
    """Rename js/ to js.<hash>/ and point index.html at it."""
    digest = hash_modules(outdir)
    os.rename(os.path.join(outdir, "js"), os.path.join(outdir, f"js.{digest}"))

    page = os.path.join(outdir, "index.html")
    with open(page) as f:
        html = f.read()
    if html.count("js/app.js") != 1:
        sys.exit(
            f"index.html mentions js/app.js {html.count('js/app.js')} times, expected once"
        )
    with open(page, "w") as f:
        f.write(html.replace("js/app.js", f"js.{digest}/app.js"))
    return digest


def build(outdir, site, guest, qemu_dir, node_modules, patches, pins_path, cache):
    prepare(outdir)
    open(os.path.join(outdir, IN_PROGRESS), "w").close()
    copy_site(site, outdir)
    vendor_tool.vendor(outdir, node_modules, patches)
    copy_engine(qemu_dir, outdir, pins_path, cache)
    copy_guest(guest, outdir, pins_path, check=not qemu_dir)
    digest = rename_modules(outdir)

    # The manifest is written by the same script the serve overlay reuses,
    # so a locally served engine and a deployed one are versioned alike.
    subprocess.run(
        [sys.executable, os.path.join(HERE, "asset-versions.py"), outdir, "qemu", "guest"],
        check=True,
    )

    os.remove(os.path.join(outdir, IN_PROGRESS))
    return digest


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("outdir", help="where to assemble the site")
    parser.add_argument(
        "--qemu-dir",
        help="a locally built engine and snapshot instead of the pinned release",
    )
    parser.add_argument(
        "--node-modules",
        default=vendor_tool.DEFAULT_NODE_MODULES,
        help="the installed tree to vendor from (default: this repository's)",
    )
    parser.add_argument(
        "--cache",
        default=fetch_engine_tool.DEFAULT_CACHE,
        help="engine download cache (default: .cache/engine)",
    )
    # The rest exist so the tests can point the build at a tree of their
    # own; a real build has no reason to pass them.
    parser.add_argument("--site", default=DEFAULT_SITE, help="the site sources")
    parser.add_argument("--guest", default=DEFAULT_GUEST, help="the guest image")
    parser.add_argument(
        "--patches", default=vendor_tool.DEFAULT_PATCHES, help="the patches directory"
    )
    parser.add_argument("--pins", default=DEFAULT_PINS, help="the pins file")
    args = parser.parse_args()

    digest = build(
        args.outdir,
        args.site,
        args.guest,
        args.qemu_dir,
        args.node_modules,
        args.patches,
        args.pins,
        args.cache,
    )
    print(f"built {args.outdir} (js.{digest})", file=sys.stderr)


if __name__ == "__main__":
    main()
