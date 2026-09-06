// Tests pacman's version comparison, which decides what "current"
// means, which archived build an era picks, and whether a dependency is
// satisfied. Every vector below is ground truth: the table was produced
// by running pacman's own vercmp(8) over the pairs (the generator is
// kept in the scratchpad), not by reading the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDepend,
  parseVersion,
  sameName,
  satisfies,
  vercmp,
} from "../../site/js/vercmp.js";

// [a, b, vercmp(a, b)]
const VECTORS = [
  ["1.0", "1.0", 0],
  ["1.0", "1.0.1", -1],
  ["1.0.1", "1.0", 1],
  ["1.0a", "1.0b", -1],
  ["1.0a", "1.0", -1],
  ["1.0", "1.0a", 1],
  ["1.0.0", "1.0", 1],
  ["1.0", "1.0.0", -1],
  ["1:1.0", "2.0", 1],
  ["2.0", "1:1.0", -1],
  ["1:1.0", "1:1.0", 0],
  ["1.0-1", "1.0-2", -1],
  ["1.0-2", "1.0-1", 1],
  ["1.0-2", "1.0", 0],
  ["1.0", "1.0-2", 0],
  ["2.0rc1", "2.0", -1],
  ["2.0", "2.0rc1", 1],
  ["1.7.1", "1.7.1-2", 0],
  ["20240101", "2024.01.01", 1],
  ["1.005", "1.5", 0],
  ["1.5", "1.05", 0],
  ["1.0", "1.0rc1", 1],
  ["1.0.a", "1.0.1", -1],
  ["1.0a1", "1.0", -1],
  ["1.0.a", "1.0", 1],
  ["alpha", "beta", -1],
  ["1", "1.0", -1],
  ["1.0", "1", 1],
  ["a1", "a", 1],
  ["1.0.1a", "1.0.1", -1],
  ["01", "1", 0],
  ["1.0_alpha", "1.0", 1],
  ["1.0+1", "1.0", 1],
  ["1.0-", "1.0", 0],
  ["1.0.", "1.0", 1],
  ["3.0.0", "3.0", 1],
  ["2.0.1", "2.0.1a", 1],
  ["1.0-1", "1.0.1-1", -1],
  ["4.4.4", "4.4.4.1", -1],
  ["1:1.0-1", "1:1.0-2", -1],
  ["2:1.0", "1:9.9", 1],
  ["1.6.3", "1.7", -1],
  ["2.40+r16+gaa533d58ff-1", "2.40-1", 1],
  ["2.39+r52+gf8e4623421-1", "2.40+r16+gaa533d58ff-1", -1],
  ["1.7.1-2", "1.7.1-10", -1],
  ["r100", "r99", 1],
];

test("vercmp agrees with pacman's vercmp(8) on every vector", () => {
  for (const [a, b, want] of VECTORS) {
    assert.equal(vercmp(a, b), want, `${a} vs ${b}`);
  }
});

test("comparison is antisymmetric", () => {
  for (const [a, b, want] of VECTORS) {
    assert.equal(vercmp(b, a), want === 0 ? 0 : -want, `${b} vs ${a}`);
  }
});

test("parseVersion splits epoch, version and release", () => {
  assert.deepEqual(parseVersion("1.7.1-2"), {
    epoch: "0",
    ver: "1.7.1",
    rel: "2",
  });
  assert.deepEqual(parseVersion("1:26.2.2-1"), {
    epoch: "1",
    ver: "26.2.2",
    rel: "1",
  });
  // No release at all is not the same as an empty one: it means "any
  // release", which is what makes 1.7.1 and 1.7.1-2 compare equal.
  assert.deepEqual(parseVersion("1.7.1"), {
    epoch: "0",
    ver: "1.7.1",
    rel: null,
  });
  // The release is whatever follows the *last* dash.
  assert.deepEqual(parseVersion("2.40+r16+gaa533d58ff-1"), {
    epoch: "0",
    ver: "2.40+r16+gaa533d58ff",
    rel: "1",
  });
});

test("parseDepend reads the name, the operator and the version", () => {
  assert.deepEqual(parseDepend("glibc"), {
    name: "glibc",
    op: null,
    version: null,
  });
  assert.deepEqual(parseDepend("linux-api-headers>=4.10"), {
    name: "linux-api-headers",
    op: ">=",
    version: "4.10",
  });
  // A soname provision: the name keeps its dots, the "=" is an operator.
  assert.deepEqual(parseDepend("libz.so=1-64"), {
    name: "libz.so",
    op: "=",
    version: "1-64",
  });
  assert.deepEqual(parseDepend("sh"), { name: "sh", op: null, version: null });
  // An optdepend explains itself after ": ".
  assert.deepEqual(parseDepend("bash-completion: for tab completion"), {
    name: "bash-completion",
    op: null,
    version: null,
  });
  assert.deepEqual(parseDepend("libx11<2:1.9"), {
    name: "libx11",
    op: "<",
    version: "2:1.9",
  });
});

test("satisfies answers a dependency the way alpm_depcmp does", () => {
  // No operator: anything satisfies it.
  assert.equal(satisfies("1.0-1", parseDepend("jq")), true);
  assert.equal(satisfies("1.7.1-2", parseDepend("jq>=1.7")), true);
  assert.equal(satisfies("1.6-4", parseDepend("jq>=1.7")), false);
  assert.equal(satisfies("1.7.1-2", parseDepend("jq<1.8")), true);
  // A constraint with no release ignores the candidate's release, so a
  // rebuild still satisfies "=1.7.1".
  assert.equal(satisfies("1.7.1-2", parseDepend("jq=1.7.1")), true);
  // With a release named, the release counts.
  assert.equal(satisfies("1.7.1-2", parseDepend("jq=1.7.1-1")), false);
  assert.equal(satisfies("1.7.1-2", parseDepend("jq=1.7.1-2")), true);
  // Epochs beat everything left of them.
  assert.equal(satisfies("1:1.0-1", parseDepend("foo>=9.0")), true);
});

test("sameName sees past a version constraint", () => {
  assert.equal(sameName("libz.so=1-64", "libz.so"), true);
  assert.equal(sameName("glibc>=2.40", "glibc"), true);
  assert.equal(sameName("libz.so", "libzstd.so"), false);
});
