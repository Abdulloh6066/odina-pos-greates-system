import test from "node:test";
import assert from "node:assert/strict";
import {
  filterShiftHistory,
  listShiftHistoryShops,
  shiftHistoryDateKey,
  shiftHistoryStatusGroup,
} from "../src/lib/shift-history.js";

const shifts = [
  {
    id: "s1",
    user_name: "Dilnoza",
    shop_id: "shop-b",
    shop_name: "Odina Second",
    status: "closed",
    opened_at: "2026-09-12T20:30:00.000Z",
  },
  {
    id: "s2",
    user_name: "Abdulloh",
    shop_id: "shop-a",
    shop_name: "Odina Main",
    status: "open",
    opened_at: "2026-09-13T05:00:00.000Z",
  },
  {
    id: "s3",
    user_name: "Madina",
    shop_id: "shop-a",
    shop_name: "Odina Main",
    status: "closing",
    opened_at: "2026-09-14T05:00:00.000Z",
  },
];

test("shift date search uses Asia/Tashkent business date", () => {
  assert.equal(shiftHistoryDateKey(shifts[0]), "2026-09-13");
  assert.deepEqual(filterShiftHistory(shifts, { date: "2026-09-13" }).map((row) => row.id), ["s1", "s2"]);
});

test("cashier and shop text search is case-insensitive", () => {
  assert.deepEqual(filterShiftHistory(shifts, { query: "DILNOZA" }).map((row) => row.id), ["s1"]);
  assert.deepEqual(filterShiftHistory(shifts, { query: "main" }).map((row) => row.id), ["s2", "s3"]);
});

test("shop and status filters combine without changing source records", () => {
  const before = structuredClone(shifts);
  assert.deepEqual(
    filterShiftHistory(shifts, { shop_id: "shop-a", status: "open" }).map((row) => row.id),
    ["s2", "s3"],
  );
  assert.deepEqual(shifts, before);
});

test("closing shifts stay visible in the active shift group", () => {
  assert.equal(shiftHistoryStatusGroup(shifts[2]), "open");
  assert.equal(shiftHistoryStatusGroup(shifts[0]), "closed");
});

test("shop options are unique and alphabetically ordered", () => {
  assert.deepEqual(listShiftHistoryShops(shifts), [
    { id: "shop-a", name: "Odina Main" },
    { id: "shop-b", name: "Odina Second" },
  ]);
});
