// Tests the digest check. Node has the same SubtleCrypto the browser
// does, so the vectors here are the real thing; the interesting cases
// are the three ways of answering "I could not check that", which the
// caller must not confuse with "that is wrong".
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyDigest } from "../../site/js/hash.js";

const bytes = new TextEncoder().encode("abc");

const SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA1 = "a9993e364706816aba3e25717850c26c9cd0d89d";

test("a matching digest verifies", async () => {
  assert.equal(
    await verifyDigest(bytes, { algorithm: "SHA-256", hex: SHA256 }),
    true,
  );
  // The Internet Archive vouches for its copies with sha1, so both have
  // to work off the same call.
  assert.equal(
    await verifyDigest(bytes, { algorithm: "SHA-1", hex: SHA1 }),
    true,
  );
});

test("the hex comparison ignores case", async () => {
  assert.equal(
    await verifyDigest(bytes, {
      algorithm: "SHA-256",
      hex: SHA256.toUpperCase(),
    }),
    true,
  );
});

test("a wrong digest fails", async () => {
  assert.equal(
    await verifyDigest(bytes, {
      algorithm: "SHA-256",
      hex: SHA256.replace(/.$/, "0"),
    }),
    false,
  );
  assert.equal(
    await verifyDigest(new TextEncoder().encode("abd"), {
      algorithm: "SHA-256",
      hex: SHA256,
    }),
    false,
  );
});

test("a digest of the wrong length fails rather than throwing", async () => {
  assert.equal(
    await verifyDigest(bytes, { algorithm: "SHA-256", hex: "ba78" }),
    false,
  );
});

test("no digest is not an answer", async () => {
  assert.equal(await verifyDigest(bytes, null), null);
  assert.equal(await verifyDigest(bytes, undefined), null);
  assert.equal(
    await verifyDigest(bytes, { algorithm: "SHA-256", hex: "" }),
    null,
  );
  assert.equal(
    await verifyDigest(bytes, { algorithm: "SHA-256", hex: null }),
    null,
  );
});

test("an algorithm this runtime will not hash is not an answer", async () => {
  assert.equal(
    await verifyDigest(bytes, {
      algorithm: "MD5",
      hex: "900150983cd24fb0d6963f7d28e17f72",
    }),
    null,
  );
});

test("no SubtleCrypto is not an answer", async () => {
  const original = globalThis.crypto;
  // A page served over plain HTTP gets no crypto.subtle, and a boot
  // there must still be possible — just unverified.
  Object.defineProperty(globalThis, "crypto", {
    value: {},
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(
      await verifyDigest(bytes, { algorithm: "SHA-256", hex: SHA256 }),
      null,
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
});
