import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLeads } from "../frontend/src/leads.ts";
test("handles header rows, quoted CSV fields and duplicate addresses", () => {
  assert.deepEqual(
    parseLeads(
      'name,email\n"Maya, K",maya+demo@example.org\nLeo,leo@example.net\nMAYA+DEMO@example.org',
    ),
    ["maya+demo@example.org", "leo@example.net"],
  );
});
test("blank and address-free files are empty", () => {
  assert.deepEqual(parseLeads("name,company\nMaya,Outbox"), []);
});
