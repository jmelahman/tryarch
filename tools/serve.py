#!/usr/bin/env python3
"""Serve a built site locally, with the headers the page cannot do without.

The VM runs on SharedArrayBuffer, and a browser only hands that out to a
cross-origin isolated document: Cross-Origin-Opener-Policy: same-origin
and Cross-Origin-Embedder-Policy: require-corp on every response. GitHub
Pages cannot set headers, so the deployed site registers a service
worker that fakes them; here they are real, which is one moving part
fewer while iterating.

Cache-Control: no-store because a rebuild reuses every URL. The deployed
tree never does -- the module directory is renamed and the big files
carry a content hash in the query string -- but a local build overwrites
_site in place, and a 304 would serve yesterday's modules against
today's page.

Two overlays, so the two things that take minutes to build do not have
to be rebuilt to be tried:

    --index DIR  a package index at /index/, built by tools/build-index.py
    --qemu DIR   an engine and snapshot at /qemu/, from tools/build-engine.sh

An engine overlay also gets assets.json recomputed over it: the manifest
in the built site describes the pinned engine, and the page appends
those hashes as a query string, so serving different bytes under the old
hashes would hand the browser a cached copy of the wrong engine.
"""

import argparse
import functools
import http.server
import importlib.util
import json
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_PORT = 8137
DEFAULT_BIND = "127.0.0.1"
DEFAULT_SITE = "_site"

# python's mimetypes reads /etc/mime.types, so what a file is called
# depends on the machine serving it. These are the types the page needs
# to be right about: a wasm module served as anything but
# application/wasm is refused by instantiateStreaming, and a module
# script needs a JavaScript type or the browser will not execute it.
TYPES = {
    ".css": "text/css",
    ".db": "application/octet-stream",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mjs": "text/javascript",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
    ".zst": "application/zstd",
}


def load(name):
    """Import a sibling script whose file name is not an identifier."""
    path = os.path.join(HERE, name)
    spec = importlib.util.spec_from_file_location(
        name.removesuffix(".py").replace("-", "_"), path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


assets = load("asset-versions.py")


class Server(http.server.ThreadingHTTPServer):
    """Threaded, with a listen backlog deep enough for this page.

    Booting fires dozens of fetches at once -- the engine, the snapshot,
    the guest image, the modules, then a package and its dependencies --
    and the default backlog of five means the kernel drops connections
    the server has not accepted yet. The browser reports those as
    network errors and the boot fails, on the local server only.
    """

    request_queue_size = 256


class Handler(http.server.SimpleHTTPRequestHandler):
    """The built site, plus the overlays, plus the isolation headers."""

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def __init__(self, *args, site, index=None, qemu=None, manifest=None, **kwargs):
        self.site = site
        self.overlays = {}
        if index:
            self.overlays["/index/"] = index
        if qemu:
            self.overlays["/qemu/"] = qemu
        self.manifest = manifest
        super().__init__(*args, **kwargs)

    def do_GET(self):
        # The recomputed manifest never exists on disk, so it is answered
        # from memory before the file lookup.
        if self.manifest and urllib.parse.urlparse(self.path).path == "/assets.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(self.manifest)))
            self.end_headers()
            self.wfile.write(self.manifest)
            return
        super().do_GET()

    def translate_path(self, path):
        """Map a URL onto a file, inside the site or an overlay and nowhere else."""
        path = urllib.parse.unquote(
            urllib.parse.urlparse(path).path, errors="surrogatepass"
        )

        base = self.site
        for prefix, directory in self.overlays.items():
            if path.startswith(prefix):
                base, path = directory, path[len(prefix) - 1 :]
                break

        # Drop everything that could climb out before joining, the way
        # SimpleHTTPRequestHandler does, and then confirm the result
        # really is under the directory it was resolved against -- a
        # symlink in the tree could still point anywhere.
        parts = [part for part in path.split("/") if part not in ("", ".", "..")]
        root = os.path.realpath(base)
        resolved = os.path.realpath(os.path.join(base, *parts))
        if resolved != root and not resolved.startswith(root + os.sep):
            # A name that cannot be there, because SimpleHTTPRequestHandler
            # answers a path that does not exist with a 404 and there is
            # no cleaner way to refuse from here.
            return os.path.join(base, "outside-the-site")
        return resolved

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def manifest_for(site, qemu):
    """assets.json with the overlaid engine's real hashes in place of the pins."""
    path = os.path.join(site, "assets.json")
    try:
        with open(path) as f:
            manifest = json.load(f)
    except FileNotFoundError:
        manifest = {"files": {}}

    # asset-versions.py keys its entries by the directory name it was
    # given, and an overlay directory is called whatever the person who
    # built it called it, so the keys are moved back under qemu/.
    qemu = os.path.abspath(qemu)
    found = assets.versions(os.path.dirname(qemu), os.path.basename(qemu))
    for key, digest in found.items():
        manifest["files"]["qemu/" + key.split("/", 1)[1]] = digest
    return json.dumps(manifest).encode()


def main():
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument(
        "--site", default=DEFAULT_SITE, help="the built site (default: _site)"
    )
    parser.add_argument("--index", help="serve this package index at /index/")
    parser.add_argument("--qemu", help="serve this engine build at /qemu/")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--bind", default=DEFAULT_BIND)
    args = parser.parse_args()

    site = os.path.abspath(args.site)
    if not os.path.isfile(os.path.join(site, "index.html")):
        sys.exit(f"{site} does not look like a built site; run tools/build-site.py first")

    for name, value in (("--index", args.index), ("--qemu", args.qemu)):
        if value and not os.path.isdir(value):
            sys.exit(f"{name} {value} is not a directory")

    index = os.path.abspath(args.index) if args.index else None
    qemu = os.path.abspath(args.qemu) if args.qemu else None
    manifest = manifest_for(site, qemu) if qemu else None

    # Everything works without an index except choosing a package: the
    # page falls back to fetching a repo database itself, and a ?pkg= in
    # the URL boots without ever searching.
    if not index and not os.path.isdir(os.path.join(site, "index")):
        print(
            "no package index: search will find nothing. Build one with "
            "`python3 tools/build-index.py index` and pass --index index.",
            file=sys.stderr,
        )

    handler = functools.partial(
        Handler, site=site, index=index, qemu=qemu, manifest=manifest
    )
    server = Server((args.bind, args.port), handler)
    print(f"serving {site} on http://{args.bind}:{args.port}/", flush=True)
    if index:
        print(f"  /index/ from {index}", flush=True)
    if qemu:
        print(f"  /qemu/  from {qemu} (assets.json recomputed)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("", flush=True)


if __name__ == "__main__":
    main()
