// Assembling the emscripten Module and starting the VM.
//
// The VM is started in two steps, so packages can stream into the
// share while the engine is still being compiled:
//
//   startVM   instantiates the engine — the guest image and the
//             snapshot go into MEMFS, QEMU's main() is held back with
//             a run dependency, and the share is open for writing;
//   vm.run    writes the manifest, releases QEMU, and hands the guest
//             its handshake.
//
// Between the two the page writes each package as it arrives, and
// nothing is ever held for the whole closure at once.
//
// xterm-pty is a vendored UMD script, so openpty is a global; the
// terminal itself comes from terminal.js.
/* global openpty */

import { ensureDir, programsOf, SHARE_ROOT, writePackage } from "./share.js";
import { openTerminal } from "./terminal.js";
import { log } from "./log.js";

// The guest sees: -L /pack (BIOS, kernel, initramfs) and the 9p share
// /share the init script mounts (tag store0, matching guest/src/init).
const PACK_DIR = "/pack";
const SHARE_DIR = SHARE_ROOT;

// The share is laid out like an Arch root: every package is unpacked
// straight into it, so /share/usr/bin/jq is where jq lands and two
// packages that both ship /usr/lib merge there, the way they do on a
// real system (pacman refuses a file conflict, so nothing is lost by
// first-writer-wins). The directories the manifest links exist before
// anything is written, so the links resolve even when no package
// filled them.
const SHARE_DIRS = ["usr/bin", "usr/lib", "etc"];

// The shell fragment the guest init sources.
//
// The guest image is a static busybox initramfs with no /usr, /lib or
// /lib64 of its own — it is the same image trynix boots, kept
// byte-identical because the resumable snapshot is taken from it. So
// the Arch root is grafted on at the top: /usr, /lib and /lib64 become
// links into the share, which is where the dynamic loader
// (/lib64/ld-linux-x86-64.so.2 in every Arch binary's PT_INTERP) and
// the libraries under /usr/lib are found. /etc is copied rather than
// linked, since the initramfs already has one, and busybox's `cp -a`
// carries the packages' symlinks over as they are.
//
// PATH puts the packages' /usr/bin ahead of busybox's /bin, so a
// package's coreutils shadow busybox's, and what is not installed still
// works. HOME is /root because bash and friends write their history
// there.
//
// The console is a serial line, and a serial tty has no window size
// until something sets one: TIOCGWINSZ answers 0x0, and a full-screen
// program refuses to start. The browser's resize events reach the line
// discipline and stop there; nothing carries them into a 16550. The
// page already knows the size it laid the terminal out at, so it
// states it, rather than running `resize` and waiting on a reply that
// may never come.
//
// TERM is xterm-256color rather than ghostty's own xterm-ghostty: the
// guest's programs look the name up in the terminfo their own ncurses
// carries, and every era knows xterm-256color. LANG=C.UTF-8 is built
// into glibc since 2.35, so programs that insist on a UTF-8 locale get
// one; an older glibc falls back to C.
function manifest({ rows, cols }) {
  return [
    `ln -s ${SHARE_DIR}/usr /usr`,
    `ln -s ${SHARE_DIR}/usr/lib /lib`,
    `ln -s ${SHARE_DIR}/usr/lib /lib64`,
    `ln -s ${SHARE_DIR}/opt /opt`,
    `ln -s ${SHARE_DIR}/var /var`,
    `ln -s ${SHARE_DIR}/srv /srv`,
    "mkdir -p /root /home /run /tmp",
    `[ -d ${SHARE_DIR}/etc ] && cp -a ${SHARE_DIR}/etc/. /etc/`,
    "export PATH=/usr/bin:/bin",
    "export HOME=/root",
    "export TERM=xterm-256color",
    "export LANG=C.UTF-8",
    `stty rows ${rows} cols ${cols}`,
    // Later sizes arrive the same way, through the share: the page
    // writes winsize.1, winsize.2, ... as the terminal is resized (a
    // phone's keyboard, a zoom, a window), and this loop applies each
    // one to the console. Setting a tty's size makes the kernel send
    // SIGWINCH to whatever is running on it, so a full-screen program
    // redraws by itself, the way it would under a real terminal.
    //
    // Nothing else carries a resize into a serial console. A new file
    // per size rather than one rewritten file, because the share is
    // mounted cache=loose and a file the guest has read stays as it
    // was; a name it has never looked up is looked up fresh. The wait
    // is a timed read on a fifo rather than `sleep`, which would fork
    // a process a second on a CPU this slow.
    "mkfifo /tmp/tick",
    "(n=1; while :; do f=/share/winsize.$n;" +
      ' if [ -r "$f" ]; then read -r r c < "$f"; stty rows "$r" cols "$c" < /dev/console; n=$((n+1));' +
      " else read -r -t 1 _ <> /tmp/tick; fi; done) &",
    "cd /root",
    "",
  ].join("\n");
}

// How the page names each size it hands the guest (see manifest).
const WINSIZE_FILE = `${SHARE_DIR}/winsize`;

const SNAPSHOT_FILE = `${PACK_DIR}/vm.state`;

// What holds QEMU's main() back until the share is complete.
const SHARE_DEPENDENCY = "tryarch-share";

// What init prints when it is parked waiting for the share, and how
// long the page will watch for it. The strings are the guest's, and
// the guest is trynix's, unchanged (docs/design.md says why): renaming
// them means a new initramfs and a new snapshot.
const READY_MARKER = "trynix: waiting for the store";
const MOUNTED_MARKER = "trynix: welcome to the multiverse";

const TRANSCRIPT_LIMIT = 65536;
// How often the resuming guest is offered its newline.
const RESUME_POLL_MS = 300;
// How long the console must be quiet after the guest mounts before the
// spare handshake newlines are taken to have all arrived.
const SETTLE_MS = 400;

// Ctrl-L: the shell's line editor clears its screen and draws the
// prompt again. Clearing the terminal from this side wipes the prompt
// with everything else, and a reader facing an empty console assumes
// it is still loading.
const REDRAW_PROMPT = "\x0c";
const HANDSHAKE_TIMEOUT_MS = 180000;

// MEMFS takes the buffer it is handed rather than copying it: the
// bytes then exist once, in the filesystem, instead of once there and
// once in whatever fetched them.
const OWN = { canOwn: true };

// QEMU's arguments, from the machine definition the guest image
// carries (guest/machine.json). The snapshot tool starts QEMU from
// the same file, which is what keeps the two ends of the migration
// identical, device for device.
function qemuArgs(machine) {
  const values = { pack: PACK_DIR, share: SHARE_DIR, ram: machine.ram };
  return machine.args.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (_, name) => values[name]),
  );
}

// The share, as the page maintains it: which packages have been
// written and what programs each one offers.
function packageShare(FS) {
  const programs = new Map();
  const state = { written: new Set() };

  return {
    // Materialise one fetched package (pkg.js). A name already there is
    // left alone: one version of a package is what the guest has, the
    // way pacman keeps one.
    write(pkg) {
      const { name } = pkg.build;
      if (programs.has(name)) {
        return;
      }
      const written = writePackage(FS, SHARE_DIR, pkg.entries, state);
      programs.set(name, programsOf(pkg.entries));
      return written;
    },

    programsOf: (name) => programs.get(name) ?? [],
    written: () => [...programs.keys()],
  };
}

// guestFiles: Map of name -> Uint8Array (bzImage, initramfs, BIOS).
// machine: the parsed machine definition (guest/machine.json).
// snapshot: the migration stream, or null to cold-boot.
// engine: { main, locate } — the versioned URL of the emscripten
// module, and a resolver for whatever else it asks for by name. The
// wasm itself is not fetched here: the module streams it from the
// URL, which lets the browser compile while downloading and keep the
// compiled code across visits.
//
// Resolves once the engine is instantiated and the share is writable,
// which is before QEMU runs anything.
export async function startVM({
  guestFiles,
  machine,
  snapshot = null,
  terminalElement,
  keyBarElement,
  engine,
}) {
  const ui = await openTerminal(terminalElement, keyBarElement);
  const { master, slave } = openpty();
  ui.attach(master);

  // The console transcript, tapped before the terminal draws it.
  const console_ = watchConsole(master);

  // Resuming a snapshot skips the whole boot — BIOS, kernel, device
  // probe — and lands in a guest already spinning for the share,
  // which by then is full. Without one, the same arguments cold-boot.
  const args =
    snapshot === null
      ? qemuArgs(machine)
      : ["-incoming", `file:${SNAPSHOT_FILE}`, ...qemuArgs(machine)];

  // preRun hands the module out once its filesystem exists.
  let onFilesystem;
  const filesystem = new Promise((resolve) => {
    onFilesystem = resolve;
  });

  const Module = {
    arguments: args,
    // No `print`/`printErr` here. xterm-pty is linked into this build
    // as a js-library that routes emscripten's output through the pty,
    // and defining either one takes stdout and stderr away from it —
    // the terminal then stays blank for the whole run, guest console
    // included. QEMU's diagnostics arrive in the terminal instead.
    pty: slave,
    // Both of these must be the versioned URLs too: the worker and the
    // wasm are fetched by emscripten rather than by us, and a stale
    // one is a stale engine.
    mainScriptUrlOrBlob: new URL(engine.main, location.href).href,
    locateFile: (file) => engine.locate(file),
    preRun: [
      (mod) => {
        // Holding a run dependency keeps main() from starting until
        // the share is complete; vm.run releases it.
        mod.addRunDependency(SHARE_DEPENDENCY);

        // The -L directory: BIOS blobs, kernel, initramfs.
        ensureDir(mod.FS, PACK_DIR);
        for (const [name, bytes] of guestFiles) {
          mod.FS.writeFile(`${PACK_DIR}/${name}`, bytes, OWN);
        }
        if (snapshot !== null) {
          mod.FS.writeFile(SNAPSHOT_FILE, snapshot, OWN);
        }
        for (const dir of SHARE_DIRS) {
          ensureDir(mod.FS, `${SHARE_DIR}/${dir}`);
        }

        onFilesystem(mod);
      },
    ],
  };

  // The factory's promise settles only once the runtime is up, which
  // is after the run dependency is released — so it is not awaited
  // here. A failure before then (a wasm that will not compile, a
  // worker that will not start) is logged rather than lost.
  const initEmscriptenModule = (await import(`../${engine.main}`)).default;
  const runtime = initEmscriptenModule(Module);
  runtime.catch((err) => log(`engine failed: ${err.message ?? err}`));

  const mod = await filesystem;
  const share = packageShare(mod.FS);

  // Every resize from here on goes to the guest through the share; the
  // size at boot went in the manifest.
  let resizes = 0;
  ui.terminal.onResize(({ rows, cols }) => {
    resizes += 1;
    mod.FS.writeFile(`${WINSIZE_FILE}.${resizes}`, `${rows} ${cols}\n`);
  });

  // Reachable from the browser console: the terminal, the pty pair,
  // and everything the guest has said. Debugging a guest that will not
  // talk is otherwise guesswork.
  window.tryarch = {
    terminal: ui.terminal,
    master,
    slave,
    transcript: console_.transcript,
  };

  return {
    terminal: ui.terminal,
    share,

    // Finish the share and let QEMU run. Resolves when the guest is at
    // its prompt — or when the page has given up waiting for it.
    async run() {
      mod.FS.writeFile(
        `${SHARE_DIR}/manifest`,
        manifest({ rows: ui.terminal.rows, cols: ui.terminal.cols }),
      );
      mod.removeRunDependency(SHARE_DEPENDENCY);

      // The handshake: init parks on a read until the page says the
      // share is populated (guest/src/init). Mounting only after this
      // is what makes the snapshot possible to take at all, since
      // QEMU refuses to migrate a VM with a virtfs export mounted.
      //
      // Markers are matched against the console stream rather than
      // against the terminal's screen. A screen scrolls, wraps and
      // gets cleared, and reading one ties this to a particular
      // terminal's buffer API; the stream is what the guest actually
      // said.
      if (snapshot === null) {
        await coldBoot(console_, master, ui.terminal);
      } else {
        await resume(console_, master, ui.terminal);
      }

      // QEMU has read everything it will ever read from /pack: the
      // snapshot is in the guest's RAM and the kernel and initramfs
      // are in the fw_cfg it booted from. The MEMFS copies are dead
      // weight — the snapshot alone is 32 MB — so they go.
      for (const name of [...guestFiles.keys(), SNAPSHOT_FILE]) {
        const path = name.startsWith("/") ? name : `${PACK_DIR}/${name}`;
        try {
          mod.FS.unlink(path);
        } catch {
          // a cold boot never wrote the snapshot
        }
      }
    },

    // Add packages to a VM that is already running.
    //
    // The share is an ordinary directory in the emscripten filesystem
    // and 9p's local backend passes every lookup through to it, so
    // writing a package after boot is enough for the guest to find its
    // programs on the PATH it already has — no remount, no reboot.
    // Only /etc does not follow: the guest copied it at boot, so a
    // later package's /etc files stay under /share/etc.
    add(pkg) {
      share.write(pkg);
    },

    // The programs a written package offers, by name.
    programsOf: (name) => share.programsOf(name),

    // Building in the guest (build.js) is a conversation over the
    // console: the page stages what a build needs on the share, types
    // one command at the prompt, waits for the marker the driver
    // prints, and reads back what the guest wrote. Everything the
    // guest has printed is what the markers are matched against.
    //
    // Files are keyed by path under `dir`, which is itself under the
    // share, as bytes or as text; a directory in a path is made on the
    // way. Nothing here touches what a package wrote.
    stage(dir, files) {
      for (const [name, content] of files) {
        const path = `${SHARE_DIR}/${dir}/${name}`;
        ensureDir(mod.FS, path.slice(0, path.lastIndexOf("/")));
        mod.FS.writeFile(path, content);
      }
    },

    // The bytes of a file under the share, as the guest left them.
    readFile: (path) => mod.FS.readFile(`${SHARE_DIR}/${path}`),

    // Drop a staged directory and everything in it.
    unstage(dir) {
      removeTree(mod.FS, `${SHARE_DIR}/${dir}`);
    },

    // Keystrokes at the prompt: a line, and the newline that runs it.
    type(line) {
      send(master, `${line}\n`);
    },

    waitFor: (marker, options) => console_.waitFor(marker, options),
    transcript: () => console_.transcript(),
  };
}

// rm -rf on the emscripten filesystem; a path that is not there is
// nothing to do.
function removeTree(FS, path) {
  let stat;
  try {
    stat = FS.stat(path);
  } catch {
    return;
  }
  if (FS.isDir(stat.mode)) {
    for (const name of FS.readdir(path)) {
      if (name !== "." && name !== "..") {
        removeTree(FS, `${path}/${name}`);
      }
    }
    FS.rmdir(path);
  } else {
    FS.unlink(path);
  }
}

// A cold boot announces itself, takes one newline, and mounts.
async function coldBoot(console_, master, terminal) {
  await console_.waitFor(READY_MARKER);
  sendLine(master);
  await console_.waitFor(MOUNTED_MARKER);
  terminal.clear();
  send(master, REDRAW_PROMPT);
}

// Hand a resumed guest the handshake.
//
// The guest arrives running. The snapshot was taken while the source
// VM ran (tools/make-snapshot.py), the migration stream records that
// runstate, and QEMU starts a restored VM whose source was running
// without being told to — the fork's own migration example resumes
// with -incoming and nothing else.
//
// The guest is parked on init's read, exactly where the snapshot
// caught it, so one newline finishes the handshake — but a newline
// sent while QEMU is still loading the stream is lost, and nothing
// says when loading is done. So newlines are offered every
// RESUME_POLL_MS until the guest has mounted the share and said so.
//
// Waiting for the console to show anything at all is not good enough:
// the line discipline echoes every newline straight back, so the
// console has output before the guest has read a byte. A poll stopped
// on the strength of that echo leaves a guest still parked on its read
// with nothing left to wake it. The spare newlines queue in the UART
// and reach the shell as bare prompts, which the clear below removes.
async function resume(console_, master, terminal) {
  const poll = setInterval(() => sendLine(master), RESUME_POLL_MS);
  sendLine(master);
  await console_.waitFor(MOUNTED_MARKER);
  clearInterval(poll);

  // Drop what the guest said on the way up; the reader starts at a
  // prompt.
  await quiet(SETTLE_MS);
  terminal.clear();
  send(master, REDRAW_PROMPT);
}

// Input goes in the way a keystroke does: the line discipline the
// terminal addon feeds when someone types.
function send(master, data) {
  master.ldisc.writeFromLower(data);
}

const sendLine = (master) => send(master, "\n");

const quiet = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything the guest has written, and a way to wait for a line in it.
//
// The transcript is capped: a guest that runs for an hour must not
// grow this without bound, and every marker is answered early in the
// run.
function watchConsole(master) {
  let transcript = "";
  const waiters = [];

  const decoder = new TextDecoder();

  const outputWaiters = [];

  master.onWrite(([data]) => {
    for (const resolve of outputWaiters.splice(0)) {
      resolve();
    }
    // The pty emits either a string or raw bytes depending on what the
    // guest wrote; concatenating the bytes directly would stringify the
    // array and match no marker ever again.
    transcript +=
      typeof data === "string" ? data : decoder.decode(data, { stream: true });
    if (transcript.length > TRANSCRIPT_LIMIT) {
      transcript = transcript.slice(-TRANSCRIPT_LIMIT);
    }
    for (const waiter of waiters.splice(0)) {
      if (transcript.includes(waiter.marker)) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  });

  return {
    transcript: () => transcript,

    // Resolves the next time the guest writes anything at all.
    waitForOutput() {
      return new Promise((resolve) => {
        outputWaiters.push(resolve);
      });
    },

    // Resolves true when the marker has been seen, and false after
    // `timeoutMs`, quietly: a guest this far off script at boot has a
    // worse problem than a missing newline, and unveiling its console
    // is more useful than waiting forever. A build waits as long as it
    // takes, with Infinity.
    waitFor(marker, { timeoutMs = HANDSHAKE_TIMEOUT_MS } = {}) {
      if (transcript.includes(marker)) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const waiter = { marker, resolve: () => resolve(true) };
        waiters.push(waiter);
        if (timeoutMs === Infinity) {
          return;
        }
        setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) {
            waiters.splice(at, 1);
          }
          resolve(false);
        }, timeoutMs);
      });
    },
  };
}
