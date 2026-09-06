// Checking downloaded bytes against the digest that named them.
//
// Two sources vouch for a package and they do not agree on an
// algorithm: a repo database carries %SHA256SUM%, while the Internet
// Archive's metadata carries the sha1 it computed when it ingested the
// file. Both are worth checking for the same reason — a body can arrive
// short without the fetch failing, and a bad body must be neither used
// nor kept — so a digest travels as { algorithm, hex } and this hashes
// with whichever one it names.
//
// There is no signature check anywhere: Arch's packages are signed, but
// verifying the detached PGP signature would mean shipping a keyring
// and an OpenPGP implementation to the browser. The digests come from
// the same mirrors as the bytes, so they catch corruption, not a
// hostile mirror. The site says so.

const HEX_DIGITS_PER_BYTE = 2;

const toHex = (bytes) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// Whether `bytes` hash to what the digest says. Null is not "no": it
// means the question could not be asked — no digest to check against,
// or no SubtleCrypto (which a page outside a secure context does not
// get). A caller treats null as unverified, not as a failure.
export async function verifyDigest(bytes, digest) {
  if (digest?.hex === undefined || digest.hex === null || digest.hex === "") {
    return null;
  }
  if (globalThis.crypto?.subtle === undefined) {
    return null;
  }

  let hashed;
  try {
    hashed = await crypto.subtle.digest(digest.algorithm, bytes);
  } catch {
    // An algorithm this browser will not hash: unverified, not bad.
    return null;
  }

  const want = digest.hex.toLowerCase();
  if (want.length !== new Uint8Array(hashed).length * HEX_DIGITS_PER_BYTE) {
    return false;
  }
  return toHex(new Uint8Array(hashed)) === want;
}
