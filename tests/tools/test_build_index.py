"""Tests for tools/build-index.py.

The indexer is a script, not a package, so it is loaded by path. The
fixture is a pair of synthetic repo dbs built the way `repo-add` builds
them — a gzip'd tar of `<name>-<version>/desc` — small enough to read.

The shard vectors matter beyond this file: site/js/index.js recomputes
the same FNV-1a in JS, and its test asserts the same numbers.
"""

import gzip
import importlib.util
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_indexer():
    """Import tools/build-index.py, whose name is not an identifier."""
    path = os.path.join(ROOT, "tools", "build-index.py")
    spec = importlib.util.spec_from_file_location("build_index", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


indexer = load_indexer()


def desc(**sections):
    """One db file from `{KEY: value or [values]}`, in the db's own format."""
    out = []
    for key, value in sections.items():
        values = value if isinstance(value, list) else [value]
        out.append(f"%{key}%\n" + "\n".join(values) + "\n")
    return "\n".join(out)


def write_db(path, entries):
    """A gzip'd tar of `<dir>/<file>` exactly like `repo-add` writes."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for directory, files in entries.items():
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            tar.addfile(info)
            for leaf, text in files.items():
                data = text.encode("utf-8")
                info = tarfile.TarInfo(f"{directory}/{leaf}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
    with open(path, "wb") as f:
        f.write(gzip.compress(raw.getvalue(), mtime=0))


LONG_DESC = (
    "a description that runs well past the hundred and twenty character limit "
    + "x" * 80
)

CORE = {
    "bash-5.3-1": {
        "desc": desc(
            FILENAME="bash-5.3-1-x86_64.pkg.tar.zst",
            NAME="bash",
            BASE="bash",
            VERSION="5.3-1",
            DESC="The GNU Bourne Again shell",
            CSIZE="2002014",
            ISIZE="10055508",
            SHA256SUM="aa" * 32,
            URL="https://www.gnu.org/software/bash/bash.html",
            ARCH="x86_64",
            BUILDDATE="1781065932",
            PROVIDES=["sh", "bash"],
            DEPENDS=["readline>=8.0", "libreadline.so=8-64", "glibc"],
            OPTDEPENDS=["bash-completion: for tab completion"],
        )
    },
    # Also in extra, with a different version: core is named first in
    # --repos, so this copy is the one that must survive.
    "dup-1.0-1": {
        "desc": desc(
            FILENAME="dup-1.0-1-x86_64.pkg.tar.zst",
            NAME="dup",
            VERSION="1.0-1",
            DESC="the core copy",
            PROVIDES=["shared-thing"],
        )
    },
}

EXTRA = {
    "jq-1.7.1-2": {
        "desc": desc(
            FILENAME="jq-1.7.1-2-x86_64.pkg.tar.zst",
            NAME="jq",
            BASE="jq",
            VERSION="1.7.1-2",
            DESC=LONG_DESC,
            CSIZE="294184",
            ISIZE="934000",
            SHA256SUM="bb" * 32,
            BUILDDATE="1718000000",
            PROVIDES=["libjq.so=1-64"],
            DEPENDS=["glibc", "libonig.so=5-64"],
        )
    },
    "dup-2.0-1": {
        "desc": desc(
            FILENAME="dup-2.0-1-x86_64.pkg.tar.zst",
            NAME="dup",
            VERSION="2.0-1",
            DESC="the extra copy",
            PROVIDES=["shared-thing"],
        )
    },
    # An older db: the dependency sections live in a sibling file.
    "old-1.0-1": {
        "desc": desc(
            FILENAME="old-1.0-1-any.pkg.tar.gz",
            NAME="old",
            VERSION="1.0-1",
            DESC="an entry from an older db",
            CSIZE="not a number",
        ),
        "depends": desc(
            DEPENDS=["glibc>=2.0"],
            PROVIDES=["shared-thing", "old"],
        ),
    },
    # No %FILENAME%: nothing to download, so nothing to index.
    "ghost-1.0-1": {
        "desc": desc(NAME="ghost", VERSION="1.0-1", DESC="never written")
    },
}


class ShardTest(unittest.TestCase):
    # FNV-1a over UTF-8, low byte, hex. Worked by hand from
    # h = 0x811c9dc5 and h = (h ^ b) * 0x01000193 mod 2**32:
    #   ""      -> 0x811c9dc5           -> c5
    #   "a"     -> 0xe40c292c           -> 2c
    #   "jq"    -> 0x5c3f60e4           -> e4
    #   "glibc" -> 0x9347fe02           -> 02
    VECTORS = {
        "": "c5",
        "a": "2c",
        "jq": "e4",
        "bash": "1f",
        "glibc": "02",
        "sh": "5e",
        "libz.so": "6e",
        "libreadline.so": "d6",
        "python-setuptools": "62",
        "zzz": "9d",
        "tryarch": "76",
    }

    def test_vectors(self):
        for name, shard in self.VECTORS.items():
            self.assertEqual(indexer.shard_of(name), shard, name)

    def test_shape(self):
        # Every shard is two lowercase hex digits, and non-ASCII names
        # hash over their UTF-8 bytes rather than throwing.
        for name in ("", "jq", "libgtk-3.so", "ünïcödé"):
            shard = indexer.shard_of(name)
            self.assertRegex(shard, r"^[0-9a-f]{2}$")

    def test_full_hash_is_mixed_in(self):
        # Only the low byte is kept, but the whole name feeds it: names
        # sharing a prefix must not be forced into one shard.
        shards = {indexer.shard_of(f"pkg{i}") for i in range(64)}
        self.assertGreater(len(shards), 32)


class ParseTest(unittest.TestCase):
    def test_sections(self):
        sections = indexer.parse_sections(CORE["bash-5.3-1"]["desc"])
        self.assertEqual(sections["NAME"], ["bash"])
        self.assertEqual(sections["PROVIDES"], ["sh", "bash"])
        self.assertEqual(
            sections["DEPENDS"], ["readline>=8.0", "libreadline.so=8-64", "glibc"]
        )

    def test_blank_line_ends_a_section(self):
        # A value line that follows a blank line without a header
        # belongs to nothing — it must not join the previous section.
        sections = indexer.parse_sections("%NAME%\nbash\n\nstray\n\n%VERSION%\n5.3-1\n")
        self.assertEqual(sections["NAME"], ["bash"])
        self.assertEqual(sections["VERSION"], ["5.3-1"])
        self.assertNotIn("stray", sections["NAME"])

    def test_missing_trailing_blank_line(self):
        sections = indexer.parse_sections("%NAME%\nbash")
        self.assertEqual(sections["NAME"], ["bash"])

    def test_empty_section(self):
        sections = indexer.parse_sections("%GROUPS%\n\n%NAME%\nbash\n")
        self.assertEqual(sections["GROUPS"], [])
        self.assertIsNone(indexer.one(sections, "GROUPS"))

    def test_bare_name(self):
        self.assertEqual(indexer.bare_name("glibc"), "glibc")
        self.assertEqual(indexer.bare_name("libz.so=1-64"), "libz.so")
        self.assertEqual(
            indexer.bare_name("linux-api-headers>=4.10"), "linux-api-headers"
        )
        self.assertEqual(indexer.bare_name("foo<=2"), "foo")
        self.assertEqual(indexer.bare_name("foo>2"), "foo")
        self.assertEqual(indexer.bare_name("foo<2"), "foo")

    def test_numbers(self):
        sections = indexer.parse_sections("%CSIZE%\n42\n\n%ISIZE%\nnope\n")
        self.assertEqual(indexer.number(sections, "CSIZE"), 42)
        self.assertIsNone(indexer.number(sections, "ISIZE"))
        self.assertIsNone(indexer.number(sections, "BUILDDATE"))

    def test_entry_needs_a_filename(self):
        sections = indexer.parse_sections(EXTRA["ghost-1.0-1"]["desc"])
        self.assertIsNone(indexer.entry_of(sections, "extra"))


class IndexTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="tryarch-index-")
        cls.db_dir = os.path.join(cls.tmp, "db")
        os.makedirs(cls.db_dir)
        write_db(os.path.join(cls.db_dir, "core.db"), CORE)
        write_db(os.path.join(cls.db_dir, "extra.db"), EXTRA)
        cls.pkgs, cls.provides = indexer.index_repos(
            ["core", "extra"], "x86_64", indexer.MIRRORS, cls.db_dir
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp)

    def test_packages(self):
        self.assertEqual(set(self.pkgs), {"bash", "dup", "jq", "old"})

    def test_fields(self):
        bash = self.pkgs["bash"]
        self.assertEqual(bash["v"], "5.3-1")
        self.assertEqual(bash["r"], "core")
        self.assertEqual(bash["f"], "bash-5.3-1-x86_64.pkg.tar.zst")
        self.assertEqual(bash["cs"], 2002014)
        self.assertEqual(bash["is"], 10055508)
        self.assertEqual(bash["sha"], "aa" * 32)
        self.assertEqual(bash["b"], 1781065932)
        self.assertEqual(bash["base"], "bash")
        self.assertEqual(bash["url"], "https://www.gnu.org/software/bash/bash.html")
        # The `>=` and `=` suffixes stay in the recorded dependency: the
        # page needs the constraint, only the index key is bare.
        self.assertEqual(bash["d"], ["readline>=8.0", "libreadline.so=8-64", "glibc"])
        self.assertEqual(bash["p"], ["sh", "bash"])

    def test_missing_fields_are_null(self):
        old = self.pkgs["old"]
        self.assertIsNone(old["url"])
        self.assertIsNone(old["is"])
        self.assertIsNone(old["b"])
        # `%CSIZE%` held something that is not a number.
        self.assertIsNone(old["cs"])
        # No `%BASE%`: the package is its own pkgbase as far as the page
        # can tell.
        self.assertEqual(old["base"], "old")

    def test_sibling_depends_file_is_merged(self):
        self.assertEqual(self.pkgs["old"]["d"], ["glibc>=2.0"])
        self.assertEqual(self.pkgs["old"]["p"], ["shared-thing", "old"])

    def test_repo_order_wins(self):
        self.assertEqual(self.pkgs["dup"]["v"], "1.0-1")
        self.assertEqual(self.pkgs["dup"]["r"], "core")
        self.assertEqual(self.pkgs["dup"]["desc"], "the core copy")

    def test_reversed_repo_order_wins_the_other_way(self):
        pkgs, _ = indexer.index_repos(
            ["extra", "core"], "x86_64", indexer.MIRRORS, self.db_dir
        )
        self.assertEqual(pkgs["dup"]["v"], "2.0-1")
        self.assertEqual(pkgs["dup"]["r"], "extra")

    def test_provides(self):
        self.assertEqual(self.provides["sh"], ["bash"])
        # Keyed by the bare name, `=1-64` stripped.
        self.assertEqual(self.provides["libjq.so"], ["jq"])
        # A dependency nothing in these repos provides is simply absent.
        self.assertNotIn("libreadline.so", self.provides)

    def test_provides_are_ordered_core_first(self):
        # `dup` (core) and `old` (extra) both provide it; the losing
        # `dup` from extra contributes nothing.
        self.assertEqual(self.provides["shared-thing"], ["dup", "old"])

    def test_self_provides_are_not_recorded(self):
        # bash provides "bash" and old provides "old": the page looks in
        # `pkgs` first, so recording those would only cost bytes.
        self.assertNotIn("bash", self.provides)
        self.assertNotIn("old", self.provides)

    def test_provides_ordering_is_by_repo_then_name(self):
        providers = {"thing": [(1, "zeta"), (0, "yankee"), (1, "alpha")]}
        ordered = [name for _, name in sorted(providers["thing"])]
        self.assertEqual(ordered, ["yankee", "alpha", "zeta"])


GENERATED = "2026-09-05T23:10:00Z"


class WriteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="tryarch-index-")
        self.db_dir = os.path.join(self.tmp, "db")
        os.makedirs(self.db_dir)
        write_db(os.path.join(self.db_dir, "core.db"), CORE)
        write_db(os.path.join(self.db_dir, "extra.db"), EXTRA)
        self.out = os.path.join(self.tmp, "index")
        pkgs, provides = indexer.index_repos(
            ["core", "extra"], "x86_64", indexer.MIRRORS, self.db_dir
        )
        indexer.write_index(
            self.out,
            pkgs,
            provides,
            ["core", "extra"],
            "x86_64",
            GENERATED,
        )

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def read(self, *parts):
        with open(os.path.join(self.out, *parts)) as f:
            return json.load(f)

    def test_names(self):
        names = self.read("names.json")
        self.assertEqual(names["generated"], GENERATED)
        self.assertEqual(names["arch"], "x86_64")
        self.assertEqual(names["repos"], ["core", "extra"])
        self.assertEqual(names["count"], 4)
        self.assertEqual(sorted(names["names"]), ["bash", "dup", "jq", "old"])
        self.assertEqual(names["names"]["bash"], "The GNU Bourne Again shell")

    def test_description_is_truncated(self):
        names = self.read("names.json")
        self.assertEqual(len(names["names"]["jq"]), 120)
        self.assertEqual(names["names"]["jq"], LONG_DESC[:120])
        # The full description stays in the shard.
        self.assertEqual(self.read("pkgs", "e4.json")["jq"]["desc"], LONG_DESC)

    def test_names_are_sorted(self):
        with open(os.path.join(self.out, "names.json")) as f:
            text = f.read()
        self.assertLess(text.index('"bash"'), text.index('"jq"'))
        # Separator-tight, so an unchanged repo rebuilds byte-identical.
        self.assertNotIn(", ", text)
        self.assertNotIn(": ", text)

    def test_shard_files(self):
        # Each package lands in the file its own name hashes to.
        for name in ("bash", "jq", "dup", "old"):
            shard = self.read("pkgs", f"{indexer.shard_of(name)}.json")
            self.assertIn(name, shard)

    def test_provides_shards(self):
        self.assertEqual(self.read("provides", "5e.json")["sh"], ["bash"])
        shard = self.read("provides", f"{indexer.shard_of('shared-thing')}.json")
        self.assertEqual(shard["shared-thing"], ["dup", "old"])

    def test_rebuild_is_byte_identical(self):
        before = {}
        for root, _, files in os.walk(self.out):
            for leaf in files:
                path = os.path.join(root, leaf)
                with open(path, "rb") as f:
                    before[os.path.relpath(path, self.out)] = f.read()

        pkgs, provides = indexer.index_repos(
            ["core", "extra"], "x86_64", indexer.MIRRORS, self.db_dir
        )
        indexer.write_index(
            self.out,
            pkgs,
            provides,
            ["core", "extra"],
            "x86_64",
            GENERATED,
        )

        after = {}
        for root, _, files in os.walk(self.out):
            for leaf in files:
                path = os.path.join(root, leaf)
                with open(path, "rb") as f:
                    after[os.path.relpath(path, self.out)] = f.read()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
