"""Tests for tools/vendor.py.

The vendorer is a script, not a package, so it is loaded by path. It
runs against a node_modules tree built here rather than the real one:
the point is the copying and the version check, not the libraries, and
a test that needed `npm ci` first would be a test of the network.

The patch step is the one thing that shells out. It gets a patches
directory of its own here, with a one-line diff against the fake
xzwasm.js, so this exercises `patch -p1` in the vendored directory
without depending on what the real patch happens to say today.
"""

import contextlib
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
    """Swallow what the tool prints, so a failing test is the only output.

    At the file-descriptor level rather than sys.stderr, because the
    patch step is a subprocess and writes past python entirely.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    saved = os.dup(1), os.dup(2)
    with open(os.devnull, "w") as null:
        os.dup2(null.fileno(), 1)
        os.dup2(null.fileno(), 2)
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved[0], 1)
        os.dup2(saved[1], 2)
        os.close(saved[0])
        os.close(saved[1])


def load(name):
    path = os.path.join(ROOT, "tools", name)
    spec = importlib.util.spec_from_file_location(
        name.removesuffix(".py").replace("-", "_"), path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vendor = load("vendor.py")

# What an installed tree has to hold for a vendor run to succeed: every
# source COPIES names, at the version package.json pins.
VERSIONS = {
    "coi-serviceworker": "0.1.7",
    "fzstd": "0.1.1",
    "ghostty-web": "0.4.0-next.20.g1858a59",
    "xterm-pty": "0.10.1",
    "xzwasm": "0.1.2",
}

FILES = {
    "xterm-pty": {"index.js": "openpty"},
    "xzwasm": {"dist/package/xzwasm.js": "subarray\n"},
    "fzstd": {"umd/index.js": "decompress"},
    "coi-serviceworker": {"coi-serviceworker.min.js": "worker"},
    "ghostty-web": {
        "dist/ghostty-web.js": "ghostty",
        "dist/__vite-browser-external-deadbeef.js": "stub",
        "ghostty-vt.wasm": "\0asm",
    },
}

PATCH = """--- a/xzwasm.js
+++ b/xzwasm.js
@@ -1 +1 @@
-subarray
+slice
"""


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


def make_tree(base, versions=None, files=None):
    """A package.json and the node_modules tree beside it, as npm leaves them."""
    versions = VERSIONS if versions is None else versions
    files = FILES if files is None else files

    write(
        os.path.join(base, "package.json"),
        json.dumps({"name": "fake", "devDependencies": versions}),
    )
    node_modules = os.path.join(base, "node_modules")
    for package, contents in files.items():
        if package in versions:
            write(
                os.path.join(node_modules, package, "package.json"),
                json.dumps({"name": package, "version": versions[package]}),
            )
        for name, text in contents.items():
            write(os.path.join(node_modules, package, name), text)
    return node_modules


def make_patches(base):
    """A patches directory holding one diff against the vendored xzwasm.js."""
    write(os.path.join(base, "xzwasm", "0001-slice.patch"), PATCH)
    return base


class VendorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tryarch-vendor-")
        self.node_modules = make_tree(os.path.join(self.tmp, "tree"))
        self.patches = make_patches(os.path.join(self.tmp, "patches"))
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_vendor(self):
        with quiet():
            vendor.vendor(self.out, self.node_modules, self.patches)

    def read(self, *parts):
        with open(os.path.join(self.out, *parts)) as f:
            return f.read()

    def test_every_file_lands_under_its_expected_name(self):
        self.run_vendor()
        # These names are site/index.html's and site/js/*.js's, so the
        # test is really asserting the page's import paths.
        self.assertEqual(self.read("vendor", "xterm-pty.js"), "openpty")
        self.assertEqual(self.read("vendor", "fzstd.js"), "decompress")
        self.assertEqual(self.read("vendor", "ghostty-web.js"), "ghostty")
        self.assertTrue(
            os.path.isfile(os.path.join(self.out, "vendor", "ghostty-vt.wasm"))
        )

    def test_service_worker_is_at_the_site_root(self):
        # A service worker only controls the directory it was served
        # from, so this one cannot live under vendor/.
        self.run_vendor()
        self.assertEqual(self.read("coi-serviceworker.js"), "worker")
        self.assertFalse(
            os.path.exists(os.path.join(self.out, "vendor", "coi-serviceworker.js"))
        )

    def test_hashed_stub_keeps_its_own_name(self):
        # ghostty-web imports it by the name its build gave it, hash and
        # all, so the glob must not rename what it matches.
        self.run_vendor()
        self.assertEqual(
            self.read("vendor", "__vite-browser-external-deadbeef.js"), "stub"
        )

    def test_patches_are_applied_in_the_vendor_directory(self):
        self.run_vendor()
        self.assertEqual(self.read("vendor", "xzwasm.js"), "slice\n")

    def test_no_patches_directory_is_not_an_error(self):
        # A tree with nothing to patch vendors the same way.
        with quiet():
            vendor.vendor(self.out, self.node_modules, os.path.join(self.tmp, "none"))
        self.assertEqual(self.read("vendor", "xzwasm.js"), "subarray\n")

    def test_files_are_readable_and_not_executable(self):
        # ghostty-vt.wasm comes out of the npm tarball with the execute
        # bit set; nothing served over HTTP wants it.
        self.run_vendor()
        mode = os.stat(os.path.join(self.out, "vendor", "ghostty-vt.wasm")).st_mode
        self.assertEqual(mode & 0o777, 0o644)

    def test_a_wrong_version_stops_the_build(self):
        wrong = dict(VERSIONS, fzstd="0.0.9")
        node_modules = make_tree(os.path.join(self.tmp, "wrong"), versions=wrong)
        # package.json is the same file npm installed from, so mismatch
        # it the other way: pin one version, install another.
        with open(os.path.join(node_modules, "fzstd", "package.json"), "w") as f:
            json.dump({"name": "fzstd", "version": "0.1.1"}, f)
        with self.assertRaises(SystemExit) as caught, quiet():
            vendor.vendor(self.out, node_modules, self.patches)
        self.assertIn("fzstd is 0.1.1", str(caught.exception))

    def test_an_uninstalled_package_stops_the_build(self):
        shutil.rmtree(os.path.join(self.node_modules, "xzwasm"))
        with self.assertRaises(SystemExit) as caught:
            self.run_vendor()
        self.assertIn("xzwasm is not installed", str(caught.exception))

    def test_a_package_missing_from_package_json_stops_the_build(self):
        versions = {k: v for k, v in VERSIONS.items() if k != "xterm-pty"}
        node_modules = make_tree(os.path.join(self.tmp, "unpinned"), versions=versions)
        with self.assertRaises(SystemExit) as caught, quiet():
            vendor.vendor(self.out, node_modules, self.patches)
        self.assertIn("xterm-pty is not a devDependency", str(caught.exception))

    def test_a_missing_file_stops_the_build(self):
        os.remove(os.path.join(self.node_modules, "xterm-pty", "index.js"))
        with self.assertRaises(SystemExit) as caught:
            self.run_vendor()
        self.assertIn("xterm-pty has no index.js", str(caught.exception))

    def test_an_ambiguous_glob_stops_the_build(self):
        # Two stubs means the build cannot know which one ghostty-web
        # imports, and copying both would leave a stale file in the site.
        write(
            os.path.join(
                self.node_modules, "ghostty-web", "dist", "__vite-browser-external-2.js"
            ),
            "other",
        )
        with self.assertRaises(SystemExit) as caught:
            self.run_vendor()
        self.assertIn("matched 2 files", str(caught.exception))

    def test_a_glob_matching_nothing_stops_the_build(self):
        os.remove(
            os.path.join(
                self.node_modules,
                "ghostty-web",
                "dist",
                "__vite-browser-external-deadbeef.js",
            )
        )
        with self.assertRaises(SystemExit) as caught:
            self.run_vendor()
        self.assertIn("matched 0 files", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
