import test from "node:test";
import assert from "node:assert/strict";
import { allocation, HOUR } from "../backend/src/policy.ts";
test("a full sender waits until the next UTC hour", () => {
  assert.equal(
    allocation(100, { window: 0, used: 2, next_at: 75 }, 2).available,
    HOUR,
  );
});
test("a cooldown crosses the window boundary", () => {
  const b = allocation(HOUR, { window: 0, used: 2, next_at: HOUR + 500 }, 2);
  assert.equal(b.used, 0);
  assert.equal(b.available, HOUR + 500);
});
test("notify on consuming the final slot", () => {
  assert.equal(allocation(1, undefined, 1).hit, true);
  assert.equal(allocation(1, undefined, 2).hit, false);
});
test("a 1000-lead burst consumes only 200 slots in the first hour", () => {
  let used = 0;
  for (let i = 0; i < 1000; i++) {
    const b = allocation(i, { window: 0, used, next_at: 0 }, 200);
    if (b.available <= i) used++;
  }
  assert.equal(used, 200);
});
