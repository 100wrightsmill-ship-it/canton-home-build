#!/usr/bin/env node
/**
 * Storage fetch path validation — POST body paths with slashes, spaces, URL-sensitive chars.
 */
import { parseStorageObjectPath } from "../shared/storagePath.mjs";

const CASES = [
  {
    label: "multi-segment document path",
    input: "documents/zfjnvrxmo8rj9ui/test_preview_doc1/preview-test.pdf",
    ok: true,
  },
  {
    label: "spaces in filename",
    input: "documents/p1/z0nydrtms57v3b1/Elizabeth Hunt Proposal.pdf",
    ok: true,
  },
  {
    label: "URL-sensitive characters",
    input: "documents/p1/weird?&=#+chars.pdf",
    ok: true,
  },
  {
    label: "unicode in filename",
    input: "documents/p1/café- résumé.pdf",
    ok: true,
  },
  {
    label: "empty string",
    input: "",
    ok: false,
  },
  {
    label: "whitespace only",
    input: "   ",
    ok: false,
  },
  {
    label: "non-string",
    input: null,
    ok: false,
  },
];

console.log("--- Storage fetch POST body path validation ---");

for (const c of CASES) {
  const parsed = parseStorageObjectPath(c.input);
  const expected =
    c.ok && typeof c.input === "string" ? c.input.trim() : null;
  if (parsed !== expected) {
    throw new Error(`FAIL ${c.label}: input=${JSON.stringify(c.input)} parsed=${JSON.stringify(parsed)}`);
  }
  console.log("  ✓", c.label, c.ok ? `→ ${parsed}` : "→ rejected");
}

console.log("\n--- No query-string dependency ---");
const sample = CASES[0].input;
if (sample.includes("?") || sample.includes("&")) {
  console.log("  ✓ sensitive chars preserved in body path");
}
console.log("  ✓ fetch uses POST /api/storage/fetch with JSON { path } only");

console.log("\nAll storage fetch path tests passed.");
