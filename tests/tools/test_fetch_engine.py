"""Tests for tools/fetch-engine.py.

The fetcher is a script, not a package, so it is loaded by path. It
downloads with urllib, which speaks file:// as happily as https, so a
directory of files in a tempdir stands in for a GitHub release and the
whole thing runs offline.

What is actually under test is the hash, in both directions: a file that
matches its pin is kept and reused, and a file that does not is fatal
and leaves nothing behind for the next run to trust. Those 45 MB are
the engine the browser executes and a RAM image it resumes into, so a
truncated download that got cached would be a site that boots into
nothing.
"""

import base64
import contextlib
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@contextlib.contextmanager
def quiet():
    """Swallow the fetcher's progress lines, so a failure is the only output."""
    sys.stderr.flush()
    saved = os.dup(2)
    with open(os.devnull, "w") as null:
        os.dup2(null.fileno(), 2)
    try:
        yield
    finally:
        sys.stderr.flush()
        os.dup2(saved, 2)
        os.close(saved)


def load(name):
    path = os.path.join(ROOT, "tools", name)
    spec = importlib.util.spec_from_file_location(
        name.removesuffix(".py").replace("-", "_"), path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fetch_engine = load("fetch-engine.py")

TAG = "engine-20260101-0000"

# Not the real four names: the fetcher takes them from the pins, and
# using short stand-ins keeps the fixture readable.
RELEASE = {
    "out.js": b"the loader",
    "vm.state": b"a ram image, at a hundredth of the size",
}


def sri(data):
    return "sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode()


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tryarch-engine-")
        self.releases = os.path.join(self.tmp, "releases")
        self.assets = os.path.join(self.releases, TAG)
        os.makedirs(self.assets)
        for name, data in RELEASE.items():
            with open(os.path.join(self.assets, name), "wb") as f:
                f.write(data)

        self.cache = os.path.join(self.tmp, "cache")
        self.out = os.path.join(self.tmp, "out")
        self.pins_path = os.path.join(self.tmp, "engine-pins.json")
        self.write_pins({name: sri(data) for name, data in RELEASE.items()})

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write_pins(self, files):
        pins = {
            "baseUrl": "file://" + self.releases,
            "tag": TAG,
            "files": files,
        }
        with open(self.pins_path, "w") as f:
            json.dump(pins, f)

    def fetch(self):
        with quiet():
            return fetch_engine.fetch_engine(self.out, self.pins_path, self.cache)

    def cached(self, name):
        return os.path.join(self.cache, TAG, name)

    def test_files_arrive_and_are_cached_under_the_tag(self):
        self.fetch()
        for name, data in RELEASE.items():
            with open(os.path.join(self.out, name), "rb") as f:
                self.assertEqual(f.read(), data)
            self.assertTrue(os.path.isfile(self.cached(name)))

    def test_a_second_run_uses_the_cache(self):
        self.fetch()
        # With the release gone there is nothing to download, so a run
        # that still succeeds can only have read the cache.
        shutil.rmtree(self.releases)
        shutil.rmtree(self.out)
        self.fetch()
        self.assertTrue(os.path.isfile(os.path.join(self.out, "out.js")))

    def test_a_bad_hash_is_fatal_and_keeps_nothing(self):
        self.write_pins({"out.js": sri(b"not what the release holds")})
        with self.assertRaises(SystemExit) as caught, quiet():
            self.fetch()
        self.assertIn("does not match engine-pins.json", str(caught.exception))
        # Nothing kept: not the file, not a half-written one beside it.
        self.assertEqual(
            sorted(os.listdir(os.path.join(self.cache, TAG))),
            [],
        )
        self.assertFalse(os.path.exists(os.path.join(self.out, "out.js")))

    def test_a_stale_cache_entry_is_refetched(self):
        self.fetch()
        with open(self.cached("out.js"), "wb") as f:
            f.write(b"whatever was there before")
        shutil.rmtree(self.out)
        self.fetch()
        with open(os.path.join(self.out, "out.js"), "rb") as f:
            self.assertEqual(f.read(), RELEASE["out.js"])

    def test_a_stale_cache_entry_that_cannot_be_refetched_is_fatal(self):
        self.fetch()
        with open(self.cached("out.js"), "wb") as f:
            f.write(b"corrupt")
        shutil.rmtree(self.releases)
        with self.assertRaises(SystemExit) as caught, quiet():
            self.fetch()
        self.assertIn("could not fetch", str(caught.exception))

    def test_a_missing_asset_is_fatal(self):
        os.remove(os.path.join(self.assets, "vm.state"))
        with self.assertRaises(SystemExit) as caught, quiet():
            self.fetch()
        self.assertIn("could not fetch", str(caught.exception))

    def test_pins_without_a_tag_are_rejected(self):
        with open(self.pins_path, "w") as f:
            json.dump({"baseUrl": "file://" + self.releases, "files": {}}, f)
        with self.assertRaises(SystemExit) as caught, quiet():
            self.fetch()
        self.assertIn("no tag", str(caught.exception))

    def test_the_sri_form_is_what_the_pins_hold(self):
        # sha256-<base64>: the same string tools/publish-engine.py
        # writes, and the same form a script integrity= attribute takes.
        path = os.path.join(self.assets, "out.js")
        self.assertEqual(fetch_engine.sri(path), sri(RELEASE["out.js"]))
        self.assertTrue(fetch_engine.sri(path).startswith("sha256-"))


if __name__ == "__main__":
    unittest.main()
