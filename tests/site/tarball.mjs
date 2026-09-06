// A tar and a checksum, built here so a test's archive can be exactly
// one thing. Not a test file: the runner's glob wants ".test." in the
// name, and this is shared by the ones that need a package in a tar.

const BLOCK = 512;
const encoder = new TextEncoder();

// One ustar archive of the given files, in order. A value may be a
// string or bytes; a key ending in "/" is a directory.
export function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const dir = name.endsWith("/");
    const body =
      typeof content === "string" ? encoder.encode(content) : content;
    const header = new Uint8Array(BLOCK);
    const put = (offset, value) => header.set(encoder.encode(value), offset);
    put(0, name);
    put(100, dir ? "0000755" : "0000644");
    put(108, "0000000");
    put(116, "0000000");
    put(124, (dir ? 0 : body.length).toString(8).padStart(11, "0"));
    put(136, "00000000000");
    put(156, dir ? "5" : "0");
    put(257, "ustar 00");
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, sum.toString(8).padStart(6, "0"));
    blocks.push(header);
    if (!dir && body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / BLOCK) * BLOCK);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const bytes = new Uint8Array(
    blocks.reduce((total, block) => total + block.length, 0),
  );
  let at = 0;
  for (const block of blocks) {
    bytes.set(block, at);
    at += block.length;
  }
  return bytes;
}

export async function sha256(bytes) {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hashed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// An in-memory stand-in for the Cache API net.js stores downloads in.
export function fakeCaches() {
  const store = new Map();
  globalThis.caches = {
    open: async () => ({
      match: async (url) => {
        const bytes = store.get(url);
        return bytes === undefined ? undefined : new Response(bytes);
      },
      put: async (url, res) => {
        store.set(url, new Uint8Array(await res.arrayBuffer()));
      },
      delete: async (url) => store.delete(url),
    }),
  };
  return store;
}
