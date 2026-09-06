"""Tests for tools/build-site.py.

The builder is a script, not a package, so it is loaded by path. It runs
here against a site of four files, a node_modules tree of stubs and an
engine directory of dummies, all of them made in a tempdir: what is
under test is the assembly -- what ends up where, what gets renamed,
what is refused -- and none of that needs the real 45 MB.

Nothing here touches the network. --qemu-dir stands in for a locally
built engine, and the pins the fetch path follows name a file:// URL,
which urllib serves out of a tempdir as happily as it serves a release.
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
    """Swallow what the build prints, so a failing test is the only output.

    At the file-descriptor level, because the build shells out to
    asset-versions.py and to patch, which write past python entirely.
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


build_site = load("build-site.py")

INDEX_HTML = """<!doctype html>
<html>
  <body>
    <script src="vendor/xterm-pty.js"></script>
    <script type="module" src="js/app.js"></script>
  </body>
</html>
"""

SITE_FILES = {
    "index.html": INDEX_HTML,
    "style.css": "body { color: red }\n",
    "js/app.js": "import './boot.js';\n",
    "js/boot.js": "export const boot = 1;\n",
    # A local build leaves an index here; it is rebuilt at deploy time
    # and must not be copied into the artifact.
    "index/names.json": '{"names":{}}',
}

# The installed tree tools/vendor.py copies out of, stubbed.
NODE_MODULES = {
    "coi-serviceworker": {"coi-serviceworker.min.js": "worker"},
    "fzstd": {"umd/index.js": "decompress"},
    "ghostty-web": {
        "dist/ghostty-web.js": "ghostty",
        "dist/__vite-browser-external-cafe.js": "stub",
        "ghostty-vt.wasm": "wasm",
    },
    "xterm-pty": {"index.js": "openpty"},
    "xzwasm": {"dist/package/xzwasm.js": "subarray\n"},
}
VERSIONS = {
    "coi-serviceworker": "0.1.7",
    "fzstd": "0.1.1",
    "ghostty-web": "0.4.0-next.20.g1858a59",
    "xterm-pty": "0.10.1",
    "xzwasm": "0.1.2",
}

ENGINE_FILES = {
    "out.js": "the loader",
    "qemu-system-x86_64.wasm": "the engine",
    "qemu-system-x86_64.worker.js": "the worker",
    "vm.state": "a ram image",
}

TAG = "engine-20260101-0000"

GUEST_FILES = {
    "bzImage": "a kernel",
    "initramfs.cpio.gz": "an initramfs",
    "machine.json": '{"ram": "512M", "args": []}',
    "bios-256k.bin": "a bios",
}


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


# The default for build()'s qemu_dir, since None means "fetch it".
USE_LOCAL_ENGINE = object()


def sri(text):
    digest = hashlib.sha256(text.encode()).digest()
    return "sha256-" + base64.b64encode(digest).decode()


class Fixture(unittest.TestCase):
    """A whole tryarch in a tempdir: site, node_modules, engine, guest."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tryarch-site-")

        self.site = os.path.join(self.tmp, "site")
        for name, text in SITE_FILES.items():
            write(os.path.join(self.site, name), text)

        self.node_modules = os.path.join(self.tmp, "tree", "node_modules")
        write(
            os.path.join(self.tmp, "tree", "package.json"),
            json.dumps({"devDependencies": VERSIONS}),
        )
        for package, files in NODE_MODULES.items():
            write(
                os.path.join(self.node_modules, package, "package.json"),
                json.dumps({"version": VERSIONS[package]}),
            )
            for name, text in files.items():
                write(os.path.join(self.node_modules, package, name), text)

        self.qemu = os.path.join(self.tmp, "qemu")
        for name, text in ENGINE_FILES.items():
            write(os.path.join(self.qemu, name), text)

        # The same four files again, as a release for the fetch path.
        self.releases = os.path.join(self.tmp, "releases")
        for name, text in ENGINE_FILES.items():
            write(os.path.join(self.releases, TAG, name), text)

        self.guest = os.path.join(self.tmp, "guest")
        for name, text in GUEST_FILES.items():
            write(os.path.join(self.guest, name), text)
        # Sources of the guest image, not part of it: they must stay out
        # of what gets served.
        write(os.path.join(self.guest, "src", "init"), "#!/bin/sh\n")

        self.pins = os.path.join(self.tmp, "engine-pins.json")
        self.write_pins({name: sri(text) for name, text in GUEST_FILES.items()})

        self.patches = os.path.join(self.tmp, "patches")
        os.makedirs(self.patches)

        self.out = os.path.join(self.tmp, "_site")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write_pins(self, guest):
        with open(self.pins, "w") as f:
            json.dump(
                {
                    "baseUrl": "file://" + self.releases,
                    "tag": TAG,
                    "files": {
                        name: sri(text) for name, text in ENGINE_FILES.items()
                    },
                    "guest": guest,
                },
                f,
            )

    def build(self, out=None, qemu_dir=USE_LOCAL_ENGINE):
        """A build. By default from --qemu-dir, which skips the guest check."""
        with quiet():
            return build_site.build(
                out or self.out,
                self.site,
                self.guest,
                self.qemu if qemu_dir is USE_LOCAL_ENGINE else qemu_dir,
                self.node_modules,
                self.patches,
                self.pins,
                os.path.join(self.tmp, "cache"),
            )

    def path(self, *parts):
        return os.path.join(self.out, *parts)

    def read(self, *parts):
        with open(self.path(*parts)) as f:
            return f.read()


class BuildTest(Fixture):
    def test_the_module_tree_is_renamed_and_the_page_follows(self):
        digest = self.build()
        self.assertRegex(digest, r"^[0-9a-f]{12}$")
        self.assertFalse(os.path.exists(self.path("js")))
        self.assertTrue(os.path.isfile(self.path(f"js.{digest}", "app.js")))
        self.assertIn(f'src="js.{digest}/app.js"', self.read("index.html"))
        self.assertNotIn('src="js/app.js"', self.read("index.html"))

    def test_the_hash_follows_the_modules(self):
        first = self.build()
        write(os.path.join(self.site, "js", "boot.js"), "export const boot = 2;\n")
        second = self.build()
        self.assertNotEqual(first, second)

    def test_the_hash_is_stable_across_rebuilds(self):
        self.assertEqual(self.build(), self.build())

    def test_a_page_that_does_not_name_the_entry_point_stops_the_build(self):
        write(os.path.join(self.site, "index.html"), "<html>nothing here</html>")
        with self.assertRaises(SystemExit) as caught:
            self.build()
        self.assertIn("expected once", str(caught.exception))

    def test_the_vendored_libraries_are_in_place(self):
        self.build()
        self.assertEqual(self.read("vendor", "xterm-pty.js"), "openpty")
        # At the root, because a service worker only controls its own
        # directory.
        self.assertEqual(self.read("coi-serviceworker.js"), "worker")

    def test_the_engine_comes_from_the_local_build(self):
        self.build()
        for name, text in ENGINE_FILES.items():
            self.assertEqual(self.read("qemu", name), text)

    def test_a_local_engine_missing_the_snapshot_stops_the_build(self):
        os.remove(os.path.join(self.qemu, "vm.state"))
        with self.assertRaises(SystemExit) as caught:
            self.build()
        self.assertIn("vm.state", str(caught.exception))

    def test_the_guest_image_is_served_without_its_sources(self):
        self.build()
        self.assertEqual(self.read("guest", "bzImage"), "a kernel")
        self.assertFalse(os.path.exists(self.path("guest", "src")))

    def test_the_local_index_is_not_deployed(self):
        # It is rebuilt at deploy time and stale within hours.
        self.build()
        self.assertFalse(os.path.exists(self.path("index")))

    def test_assets_json_versions_the_engine_and_the_guest(self):
        self.build()
        files = json.loads(self.read("assets.json"))["files"]
        for name in ENGINE_FILES:
            self.assertRegex(files[f"qemu/{name}"], r"^[0-9a-f]{12}$")
        for name in GUEST_FILES:
            self.assertIn(f"guest/{name}", files)
        # Only the two directories it was asked for.
        self.assertTrue(all(key.startswith(("qemu/", "guest/")) for key in files))

    def test_a_previous_build_is_replaced(self):
        self.build()
        stale = self.path("qemu", "left-over.js")
        write(stale, "from a build ago")
        self.build()
        self.assertFalse(os.path.exists(stale))

    def test_a_directory_that_is_not_a_build_is_refused(self):
        os.makedirs(self.out)
        write(os.path.join(self.out, "notes.txt"), "someone's home directory")
        with self.assertRaises(SystemExit) as caught:
            self.build()
        self.assertIn("refusing to replace it", str(caught.exception))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "notes.txt")))

    def test_an_empty_directory_is_fine(self):
        os.makedirs(self.out)
        self.build()
        self.assertTrue(os.path.isfile(self.path("index.html")))

    def test_the_engine_is_fetched_when_there_is_no_local_build(self):
        self.build(qemu_dir=None)
        for name, text in ENGINE_FILES.items():
            self.assertEqual(self.read("qemu", name), text)

    def test_a_fetched_build_checks_the_guest_against_the_pins(self):
        write(os.path.join(self.guest, "bzImage"), "a different kernel")
        with self.assertRaises(SystemExit) as caught:
            self.build(qemu_dir=None)
        self.assertIn("rebuild the snapshot", str(caught.exception))

    def test_a_build_that_failed_halfway_can_be_retried(self):
        # It has no assets.json, so nothing about it says "a build" --
        # except the marker a build drops on its way in.
        self.write_pins({"bzImage": sri("a different kernel")})
        with self.assertRaises(SystemExit):
            self.build(qemu_dir=None)
        self.assertTrue(os.path.isfile(self.path(build_site.IN_PROGRESS)))
        self.assertFalse(os.path.exists(self.path("assets.json")))

        self.write_pins({name: sri(text) for name, text in GUEST_FILES.items()})
        self.build(qemu_dir=None)
        self.assertTrue(os.path.isfile(self.path("assets.json")))
        # And a finished build does not carry the marker into the deploy.
        self.assertFalse(os.path.exists(self.path(build_site.IN_PROGRESS)))


class GuestPinsTest(Fixture):
    """The check that the committed guest is the one the snapshot holds."""

    def copy_guest(self, check=True):
        out = os.path.join(self.tmp, "checked")
        os.makedirs(out, exist_ok=True)
        with quiet():
            return build_site.copy_guest(self.guest, out, self.pins, check)

    def test_a_matching_guest_passes(self):
        self.assertEqual(self.copy_guest(), len(GUEST_FILES))

    def test_a_rebuilt_guest_stops_the_build(self):
        write(os.path.join(self.guest, "bzImage"), "a different kernel")
        with self.assertRaises(SystemExit) as caught:
            self.copy_guest()
        message = str(caught.exception)
        self.assertIn("bzImage is sha256-", message)
        self.assertIn("rebuild the snapshot with tools/make-snapshot.py", message)
        self.assertIn("docs/engine.md", message)

    def test_a_missing_guest_file_stops_the_build(self):
        os.remove(os.path.join(self.guest, "machine.json"))
        with self.assertRaises(SystemExit) as caught:
            self.copy_guest()
        self.assertIn("machine.json is missing", str(caught.exception))

    def test_the_check_is_skipped_for_a_local_engine(self):
        # A locally built snapshot was taken against whatever guest is
        # in the tree, so the pinned hashes say nothing about it.
        write(os.path.join(self.guest, "bzImage"), "a different kernel")
        self.assertEqual(self.copy_guest(check=False), len(GUEST_FILES))


if __name__ == "__main__":
    unittest.main()
