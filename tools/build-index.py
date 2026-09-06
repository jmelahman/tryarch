#!/usr/bin/env python3
"""Build the package index the page searches, from Arch's repo databases.

The site has no server: everything it knows about Arch's ~15k binary
packages has to arrive as static files. `core.db` and `extra.db` are the
canonical answer, but they are a 9 MB gzip'd tar between them and hold
far more than a browser needs — the page would download all of it to
answer "what version of jq is current?".

So the deploy runs this instead. It reads the dbs once, keeps the dozen
fields the page actually uses, and writes:

  names.json      every package name and a short description — one
                  fetch, enough to search over
  pkgs/<xx>.json  the current build of each package, sharded so a
                  lookup costs a few KB
  provides/<xx>.json  who provides `sh`, `libz.so`, ... for dependency
                  resolution

The shard is FNV-1a over the name, which the page recomputes in JS
(`Math.imul`) — see `shardOf` in site/js/index.js. Output is sorted and
separator-tight so an unchanged repo produces byte-identical files.

The index is never committed: it goes stale within hours of a mirror
sync (deleted package files 404), and the page falls back to fetching
the db itself when that happens.
"""

import argparse
import collections
import datetime
import http.client
import io
import json
import os
import sys
import tarfile
import urllib.request

# The only mirrors that send `Access-Control-Allow-Origin: *`, so the
# only ones the page itself can fall back to. Kept here in the same
# order as site/js/config.js — the indexer has no CORS problem, but a
# mirror the page cannot read is not one to build an index from either.
MIRRORS = (
    "https://mirror.lcarilla.de/archlinux/",
    "https://archlinux.mailtunnel.eu/",
    "https://repo.c48.uk/arch/",
    "https://mirror.iusearchbtw.nl/",
    "https://yonderly.org/mirrors/archlinux/",
)

TIMEOUT = 60

# 256 shards: ~60 packages each over core+extra, a few KB per fetch.
FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193

# Enough of a description to rank a search hit and show it in a row.
DESC_LIMIT = 120

# Older dbs split the dependency sections into a sibling file.
DB_FILES = ("desc", "depends")


def shard_of(name):
    """The shard a name falls in: two hex digits of FNV-1a over UTF-8."""
    h = FNV_OFFSET
    for byte in name.encode("utf-8"):
        h ^= byte
        h = (h * FNV_PRIME) & 0xFFFFFFFF
    return f"{h & 0xFF:02x}"


def bare_name(constraint):
    """`libz.so=1-64` -> `libz.so`, `linux-api-headers>=4.10` -> the name.

    Dependency and provides strings carry an optional comparison; the
    index is keyed by the name alone and the page compares versions.
    """
    for i, char in enumerate(constraint):
        if char in "<>=":
            return constraint[:i]
    return constraint


def parse_sections(text):
    """Split a db `desc` or `depends` file into `{KEY: [values]}`.

    The format is a `%KEY%` header line followed by one value per line,
    ended by a blank line (or the end of the file).
    """
    sections = {}
    key = None
    for line in text.splitlines():
        if not line.strip():
            key = None
            continue
        if line.startswith("%") and line.endswith("%") and len(line) > 2:
            key = line[1:-1]
            sections.setdefault(key, [])
            continue
        if key is not None:
            sections[key].append(line)
    return sections


def one(sections, key):
    """The single value of a section, or None when it is absent.

    Every section is parsed as a list because `%DEPENDS%` and friends
    are multi-valued; the rest are read back through this.
    """
    values = sections.get(key)
    return values[0] if values else None


def number(sections, key):
    """A section that holds an integer (`%CSIZE%`, `%BUILDDATE%`, ...)."""
    value = one(sections, key)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def parse_db(data):
    """Every entry in a repo db, as merged `{KEY: [values]}` sections.

    Entries are `<name>-<version>/desc` in a gzip'd tar; the sibling
    `depends` of an older db is folded in, with `desc` winning.
    """
    entries = collections.defaultdict(dict)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
        for member in tar:
            if not member.isfile():
                continue
            directory, _, leaf = member.name.rpartition("/")
            if leaf not in DB_FILES:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            text = handle.read().decode("utf-8", "replace")
            entries[directory][leaf] = parse_sections(text)

    merged = []
    for directory in sorted(entries):
        files = entries[directory]
        sections = dict(files.get("desc", {}))
        for key, values in files.get("depends", {}).items():
            sections.setdefault(key, values)
        merged.append(sections)
    return merged


def entry_of(sections, repo):
    """The indexed form of one db entry, or None if it is unusable.

    An entry with no `%FILENAME%` names no file to download, and one
    with no `%NAME%` cannot be keyed — both are skipped rather than
    written as a package the page can never fetch.
    """
    name = one(sections, "NAME")
    filename = one(sections, "FILENAME")
    if not name or not filename:
        return None

    return name, {
        "v": one(sections, "VERSION"),
        "r": repo,
        "f": filename,
        "cs": number(sections, "CSIZE"),
        "is": number(sections, "ISIZE"),
        "sha": one(sections, "SHA256SUM"),
        "b": number(sections, "BUILDDATE"),
        "d": list(sections.get("DEPENDS", [])),
        "p": list(sections.get("PROVIDES", [])),
        "base": one(sections, "BASE") or name,
        "desc": one(sections, "DESC") or "",
        "url": one(sections, "URL"),
    }


def db_bytes(repo, arch, mirrors, db_dir):
    """The bytes of `<repo>.db`, from disk or the first mirror that has it."""
    if db_dir:
        with open(os.path.join(db_dir, f"{repo}.db"), "rb") as f:
            return f.read()

    for mirror in mirrors:
        url = f"{mirror}{repo}/os/{arch}/{repo}.db"
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
                return response.read()
        # HTTPError and URLError are both OSErrors; a truncated
        # response raises from http.client instead. Any of them just
        # means "ask the next mirror".
        except (OSError, http.client.HTTPException) as err:
            print(f"index: {url}: {err}", file=sys.stderr)

    raise SystemExit(f"index: no mirror served {repo}.db")


def index_repos(repos, arch, mirrors, db_dir):
    """Fold every repo into `(pkgs, provides)`.

    A package in two repos keeps the first one named in `--repos`, and
    only that copy contributes to `provides`.
    """
    pkgs = {}
    providers = collections.defaultdict(list)

    for position, repo in enumerate(repos):
        for sections in parse_db(db_bytes(repo, arch, mirrors, db_dir)):
            found = entry_of(sections, repo)
            if found is None:
                continue
            name, entry = found
            if name in pkgs:
                continue
            pkgs[name] = entry
            for provided in entry["p"]:
                provided = bare_name(provided)
                # A package providing its own name teaches the page
                # nothing: it looks in `pkgs` first.
                if provided and provided != name:
                    providers[provided].append((position, name))

    # Repo order first, then alphabetical, so the page's first choice
    # is the one from the repo the deploy trusts most.
    provides = {
        provided: [name for _, name in sorted(found)]
        for provided, found in providers.items()
    }
    return pkgs, provides


def write_shards(outdir, subdir, entries):
    """Write one `<xx>.json` per non-empty shard of a name-keyed map."""
    shards = collections.defaultdict(dict)
    for name, value in entries.items():
        shards[shard_of(name)][name] = value

    directory = os.path.join(outdir, subdir)
    os.makedirs(directory, exist_ok=True)
    for shard, group in shards.items():
        path = os.path.join(directory, f"{shard}.json")
        with open(path, "w") as f:
            json.dump(group, f, separators=(",", ":"), sort_keys=True)
    return len(shards)


def write_index(outdir, pkgs, provides, repos, arch, generated):
    """Write names.json and the two shard directories."""
    os.makedirs(outdir, exist_ok=True)
    names = {name: entry["desc"][:DESC_LIMIT] for name, entry in pkgs.items()}
    with open(os.path.join(outdir, "names.json"), "w") as f:
        json.dump(
            {
                "generated": generated,
                "arch": arch,
                "repos": list(repos),
                "count": len(pkgs),
                "names": names,
            },
            f,
            separators=(",", ":"),
            sort_keys=True,
        )
    write_shards(outdir, "pkgs", pkgs)
    write_shards(outdir, "provides", provides)


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("outdir", help="directory to write the index into")
    parser.add_argument(
        "--mirror",
        action="append",
        metavar="URL",
        help="mirror to download the dbs from (repeatable; default: the "
        "CORS-enabled mirrors the page itself uses)",
    )
    parser.add_argument(
        "--db-dir", metavar="DIR", help="read DIR/<repo>.db instead of downloading"
    )
    parser.add_argument(
        "--repos", default="core,extra", help="repos, in priority order"
    )
    parser.add_argument("--arch", default="x86_64")
    args = parser.parse_args()

    repos = [repo for repo in args.repos.split(",") if repo]
    if not repos:
        raise SystemExit("index: --repos named no repo")

    mirrors = [
        mirror if mirror.endswith("/") else mirror + "/"
        for mirror in (args.mirror or MIRRORS)
    ]

    pkgs, provides = index_repos(repos, args.arch, mirrors, args.db_dir)
    if not pkgs:
        raise SystemExit("index: the dbs held no usable package")

    generated = datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_index(args.outdir, pkgs, provides, repos, args.arch, generated)

    print(
        f"index: {len(pkgs)} packages from {', '.join(repos)}"
        f" ({generated}) -> {args.outdir}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
