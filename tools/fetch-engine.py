#!/usr/bin/env python3
"""Fetch the qemu-wasm engine and the migration snapshot, by hash.

Four files, about 45 MB of them, are not built here: the engine needs
docker and a pinned emscripten SDK, and the snapshot needs a native
build of the same QEMU fork to capture it (docs/engine.md). They are
built by hand, published to a dated GitHub release, and pinned by SRI
hash in engine-pins.json -- so a build still describes exactly which
bytes it serves, it just downloads them instead of compiling them.

A release tag is never reused. tools/publish-engine.py creates a new one
per publish and rewrites the pins in the same commit, so a checkout of
any older commit still resolves the bytes that commit was pinned to.

The download is cached under .cache/engine/<tag>/, keyed by the tag for
exactly that reason: a new tag is new bytes and a new directory, and the
old one can be deleted whenever the disk is wanted back. A cached file
is re-verified before it is used, so a truncated download or a bad disk
is caught rather than copied into the site. A hash that does not match
is fatal and leaves nothing behind.
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PINS = os.path.join(ROOT, "engine-pins.json")
DEFAULT_CACHE = os.path.join(ROOT, ".cache", "engine")

CHUNK = 1024 * 1024
TIMEOUT = 120


def sri(path):
    """The subresource-integrity form of a file's sha256: what the pins hold."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            digest.update(chunk)
    return "sha256-" + base64.b64encode(digest.digest()).decode()


def load_pins(path):
    with open(path) as f:
        pins = json.load(f)
    for key in ("baseUrl", "tag", "files"):
        if key not in pins:
            sys.exit(f"{path} has no {key}")
    return pins


def download(url, target):
    """Fetch `url` to `target`, through a partial file that is never seen.

    Writing straight to the cached name would leave a half-file behind
    for the next run to trust, so the bytes land beside it and are moved
    into place only once the hash has been checked.
    """
    partial = target + ".partial"
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            with open(partial, "wb") as f:
                shutil.copyfileobj(response, f, CHUNK)
    except urllib.error.URLError as error:
        if os.path.exists(partial):
            os.remove(partial)
        sys.exit(f"could not fetch {url}: {error}")
    return partial


def cached(name, want, pins, cache):
    """The verified path of one pinned file, downloading it if need be."""
    directory = os.path.join(cache, pins["tag"])
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, name)

    if os.path.isfile(target):
        if sri(target) == want:
            return target
        # Whatever is there is not what was pinned; it is worth nothing
        # and would only be trusted again next time.
        print(f"  {name}: cached copy is stale, refetching", file=sys.stderr)
        os.remove(target)

    url = f"{pins['baseUrl'].rstrip('/')}/{pins['tag']}/{name}"
    print(f"  {name}: fetching {url}", file=sys.stderr)
    partial = download(url, target)

    got = sri(partial)
    if got != want:
        os.remove(partial)
        sys.exit(
            f"{name} from {url}\n"
            f"  is   {got}\n"
            f"  want {want}\n"
            "The release asset does not match engine-pins.json. Nothing was kept."
        )

    os.replace(partial, target)
    return target


def fetch_engine(outdir, pins_path=DEFAULT_PINS, cache=DEFAULT_CACHE):
    """Put every pinned engine file into `outdir`, verified."""
    pins = load_pins(pins_path)
    os.makedirs(outdir, exist_ok=True)
    for name, want in sorted(pins["files"].items()):
        source = cached(name, want, pins, cache)
        shutil.copyfile(source, os.path.join(outdir, name))
    return pins


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("outdir", help="where to put the engine files")
    parser.add_argument(
        "--pins", default=DEFAULT_PINS, help="the pins file (default: engine-pins.json)"
    )
    parser.add_argument(
        "--cache", default=DEFAULT_CACHE, help="download cache (default: .cache/engine)"
    )
    args = parser.parse_args()

    pins = fetch_engine(args.outdir, args.pins, args.cache)
    print(f"{args.outdir}: {len(pins['files'])} files from {pins['tag']}", file=sys.stderr)


if __name__ == "__main__":
    main()
