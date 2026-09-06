#!/usr/bin/env python3
"""Boot the site in a real browser, repeatedly, and fail if it hangs.

Everything else in the tree checks that the pieces are the right bytes.
Nothing checked the one thing a reader actually does: open the page and
wait for a shell. Two separate bugs shipped through that gap, both of
them a guest that never reaches its prompt while the page waits out its
handshake timeout, and both invisible to the CI workflow.

Cold boots only, one fresh browser profile each, because the failures
were races in the resume handshake and a warm profile hides them. The
run fails if any boot takes longer than --limit, which is set well
under the page's own timeout so a hang shows up as a failure rather
than a slow pass.

    python3 tools/boot-test.py --site _site
    python3 tools/boot-test.py --site _site --runs 20
    python3 tools/boot-test.py --url 'https://jamison.lahman.dev/tryarch/?pkg=jq&boot=1'

Needs `pip install websocket-client` and a headless browser: whatever
TRYARCH_BROWSER names, or chromium on PATH. A boot needs the network
too, since the package comes from an Arch mirror.
"""

import argparse
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websocket

# What init prints once it has mounted the share and is about to hand
# over the shell. This is half the test: the page is only useful once
# this appears.
#
# The wording is the guest's, and the guest is trynix's, unchanged:
# it lives inside the published snapshot, so renaming the string means
# rebuilding the initramfs and retaking the snapshot (docs/engine.md).
READY_MARKER = "welcome to the multiverse"

# The other half. A shell prompt proves the VM resumed; it proves
# nothing about the share, since init prints the marker before anything
# from a package has run. So the test types this at the prompt and
# waits for the answer: `jq --version` prints "jq-1.7.1", and that dash
# is a program that came off an Arch mirror, was unpacked into MEMFS,
# reached the guest over 9p and executed.
CHECK_COMMAND = "jq --version\n"
CHECK_OUTPUT = "jq-"

# The page gives the guest 180 s before it gives up, so a boot that is
# going to hang hangs for that long. Anything over this is a failure,
# not a slow machine: a healthy cold boot is a few seconds.
DEFAULT_LIMIT_SECONDS = 30
DEFAULT_RUNS = 10

# The package to boot. Small on purpose: this measures whether the guest
# comes up, not how fast a package downloads.
DEFAULT_PACKAGE = "jq"

POLL_SECONDS = 0.15


def free_port():
    """A port nothing is listening on, for the server or the debugger."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves the site with the headers SharedArrayBuffer needs."""

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve(directory):
    """Serve `directory` on a free port; returns (url_base, shutdown)."""
    port = free_port()
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", port), functools.partial(Handler, directory=directory)
    )
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}", httpd.shutdown


class Browser:
    """One headless browser, driven over the DevTools protocol."""

    def __init__(self, binary, profile):
        self.profile = profile
        self.port = free_port()
        # start_new_session so the whole browser can be killed as a
        # process group: killing the parent alone leaves renderers
        # running a guest, which starves the next boot and makes the
        # measurement a lie.
        #
        # --no-sandbox: GitHub's ubuntu-latest (24.04) forbids unprivileged
        # user namespaces, and chromium's sandbox exits at launch without
        # them, before the debugging port ever opens. The page under test
        # is this repository's own. stderr is kept, so a launch that fails
        # says why instead of timing out in silence.
        self.stderr = tempfile.NamedTemporaryFile(prefix="chromium-", suffix=".log")
        self.process = subprocess.Popen(
            [
                binary,
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                f"--remote-debugging-port={self.port}",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                "--disable-gpu",
                "--enable-features=SharedArrayBuffer",
                "--remote-allow-origins=*",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=self.stderr,
            start_new_session=True,
        )
        self.socket = websocket.create_connection(self._page_socket(), max_size=None, timeout=60)
        self.message_id = 0
        self.send("Runtime.enable")
        self.send("Page.enable")

    def _page_socket(self):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise SystemExit(
                    f"the browser exited with status {self.process.returncode}:\n{self._stderr_tail()}"
                )
            try:
                targets = json.load(
                    urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json", timeout=2)
                )
                pages = [t for t in targets if t["type"] == "page"]
                if pages:
                    return pages[0]["webSocketDebuggerUrl"]
            except Exception:
                pass
            time.sleep(0.25)
        raise SystemExit(f"the browser never opened a debugging port:\n{self._stderr_tail()}")

    def _stderr_tail(self):
        """The last of what chromium said, for a launch that went wrong."""
        self.stderr.flush()
        with open(self.stderr.name, errors="replace") as f:
            return "".join(f.readlines()[-20:])

    def send(self, method, **params):
        self.message_id += 1
        self.socket.send(
            json.dumps({"id": self.message_id, "method": method, "params": params})
        )
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") == self.message_id:
                return message

    def evaluate(self, expression):
        reply = self.send(
            "Runtime.evaluate", expression=expression, returnByValue=True, timeout=15000
        )
        return reply.get("result", {}).get("result", {}).get("value")

    def close(self):
        try:
            self.socket.close()
        except Exception:
            pass
        for signal_number in (15, 9):
            try:
                os.killpg(os.getpgid(self.process.pid), signal_number)
            except Exception:
                pass
            time.sleep(0.5)
        shutil.rmtree(self.profile, ignore_errors=True)


def wait_for(browser, marker, deadline):
    """Poll the guest's transcript until `marker` shows up in it."""
    while time.monotonic() < deadline:
        transcript = browser.evaluate(
            "(window.tryarch && window.tryarch.transcript "
            "&& window.tryarch.transcript()) || ''"
        )
        if transcript and marker in transcript:
            return True
        time.sleep(POLL_SECONDS)
    return False


def boot_once(binary, url, limit, workdir, index, check):
    """One cold boot: returns (seconds to the shell, None), or (None, why).

    The clock stops at the shell; running `check` afterwards has to fit
    in the same budget but is not part of the time, since it measures
    the guest's speed rather than the page's.
    """
    browser = Browser(binary, os.path.join(workdir, f"profile-{index}"))
    try:
        started = time.monotonic()
        deadline = started + limit
        browser.send("Page.navigate", url=url)
        if not wait_for(browser, READY_MARKER, deadline):
            return None, f"NO SHELL within {limit:g}s"
        taken = time.monotonic() - started

        if check:
            command, expected = check
            # Typed the way a keystroke is, through the line discipline
            # the terminal feeds — the same call site/js/boot.js makes.
            browser.evaluate(
                f"window.tryarch.master.ldisc.writeFromLower({json.dumps(command)})"
            )
            if not wait_for(browser, expected, deadline):
                return None, f"shell in {taken:.1f}s, but {command.strip()!r} said nothing"
        return taken, None
    finally:
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", help="a built site directory to serve")
    parser.add_argument("--url", help="boot this URL instead of serving a directory")
    parser.add_argument("--package", default=DEFAULT_PACKAGE)
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS)
    parser.add_argument("--limit", type=float, default=DEFAULT_LIMIT_SECONDS)
    parser.add_argument(
        "--browser",
        default=os.environ.get("TRYARCH_BROWSER", "chromium"),
        help="the headless browser to drive",
    )
    args = parser.parse_args()

    if not args.url and not args.site:
        sys.exit("pass --site <directory> or --url <address>")

    shutdown = None
    if args.url:
        url = args.url
    else:
        base, shutdown = serve(args.site)
        url = f"{base}/?pkg={args.package}&boot=1"

    # Only jq's own output is known here, so a different --package is
    # booted but not asked to run anything.
    check = (CHECK_COMMAND, CHECK_OUTPUT) if args.package == DEFAULT_PACKAGE else None

    print(f"booting {url}", flush=True)
    print(f"{args.runs} cold boots, each must reach a shell within {args.limit:g}s", flush=True)
    if check:
        print(f"and answer {check[0].strip()!r} with {check[1]!r}", flush=True)

    times = []
    stalls = 0
    with tempfile.TemporaryDirectory() as workdir:
        try:
            for index in range(args.runs):
                taken, problem = boot_once(
                    args.browser, url, args.limit, workdir, index, check
                )
                if problem:
                    stalls += 1
                    print(f"  boot {index + 1}: {problem}", flush=True)
                else:
                    times.append(taken)
                    print(f"  boot {index + 1}: {taken:.1f}s", flush=True)
        finally:
            if shutdown:
                shutdown()

    if times:
        times.sort()
        print(
            f"median {times[len(times) // 2]:.1f}s, "
            f"slowest {times[-1]:.1f}s, {stalls} of {args.runs} never got there"
        )
    if stalls:
        sys.exit(f"{stalls} of {args.runs} boots did not come up")
    print("every boot reached a shell and ran the package")


if __name__ == "__main__":
    main()
