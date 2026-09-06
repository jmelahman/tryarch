#!/usr/bin/env python3
"""Publish the engine and the snapshot as a release, and repin them.

The four artifacts (docs/engine.md) go up under a fresh, dated release
tag, and engine-pins.json is rewritten to name that release and the
hash of every file in it, plus the hashes of the guest image the
snapshot was taken from.

The pins still point at fzakaria/trynix, where the engine and the
snapshot tryarch serves were published: they are the same bytes, so
there was nothing to republish. The first publish from here moves them
to this repository, which is why baseUrl is rewritten too and not just
the tag.

A tag is never reused. A release is what the pins of a commit resolve
against, so an asset replaced in place would break every commit that
pinned the old bytes; a new tag per publish keeps a checkout of any
commit in the history buildable. Dated to the minute in UTC, because
two publishes in one day have already happened.

Usage:

    python3 tools/publish-engine.py --dir <directory>

The directory holds out.js, qemu-system-x86_64.wasm,
qemu-system-x86_64.worker.js and vm.state. --guest is the guest image
the snapshot was taken against, whose hashes the pins record; it
defaults to the committed guest/, which is what a snapshot is normally
taken from.

Needs the `gh` CLI, authenticated for the repository below.
"""

import argparse
import base64
import datetime
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REPO = "jmelahman/tryarch"
PINS = os.path.join(ROOT, "engine-pins.json")
DEFAULT_GUEST = os.path.join(ROOT, "guest")

ENGINE_FILES = (
    "out.js",
    "qemu-system-x86_64.wasm",
    "qemu-system-x86_64.worker.js",
    "vm.state",
)
GUEST_FILES = ("bzImage", "initramfs.cpio.gz", "machine.json")

TAG_PREFIX = "engine-"
TAG_TIME_FORMAT = "%Y%m%d-%H%M"


def sri(path):
    """The subresource-integrity sha256 the pins hold: sha256-<base64>.

    The same form tools/fetch-engine.py verifies against, and the same
    one an <script integrity=> attribute would take, so a pin can be
    checked by hand with sha256sum and base64.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256-" + base64.b64encode(digest.digest()).decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="directory holding the four artifacts")
    parser.add_argument(
        "--guest",
        default=DEFAULT_GUEST,
        help="the guest image the snapshot was taken from (default: guest/)",
    )
    parser.add_argument(
        "--tag",
        default=TAG_PREFIX + datetime.datetime.now(datetime.timezone.utc).strftime(TAG_TIME_FORMAT),
        help="release tag to create (default: engine-<UTC date>-<UTC time>)",
    )
    parser.add_argument("--notes", default="", help="release notes")
    args = parser.parse_args()

    paths = [os.path.join(args.dir, name) for name in ENGINE_FILES]
    missing = [path for path in paths if not os.path.isfile(path)]
    if missing:
        sys.exit(f"missing: {', '.join(missing)}")

    # Hash everything before touching the network, so a failure here
    # leaves no half-made release behind.
    files = {name: sri(path) for name, path in zip(ENGINE_FILES, paths)}
    guest = os.path.realpath(args.guest)
    guest_hashes = {name: sri(os.path.join(guest, name)) for name in GUEST_FILES}

    with open(PINS) as f:
        pins = json.load(f)

    subprocess.run(
        [
            "gh", "release", "create", args.tag,
            "--repo", REPO,
            "--title", args.tag,
            "--notes", args.notes or f"qemu-wasm engine and snapshot, taken against guest {os.path.basename(guest)}",
            *paths,
        ],
        check=True,
    )

    pins["baseUrl"] = f"https://github.com/{REPO}/releases/download"
    pins["tag"] = args.tag
    pins["files"] = files
    pins["guest"] = guest_hashes
    with open(PINS, "w") as f:
        json.dump(pins, f, indent=2)
        f.write("\n")

    print(f"published {args.tag} and rewrote {os.path.relpath(PINS)}", flush=True)


if __name__ == "__main__":
    main()
