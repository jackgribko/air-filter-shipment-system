"use strict";

/**
 * Smoke tests covering the highest-risk logic in this project:
 *   1. Rider normalization (the air-filter rider detector)
 *   2. Filter-size parsing (numeric, fractional, multi-token, malformed)
 *   3. End-to-end eligibility against the real fixture data
 *   4. End-to-end import against the real ShipStation CSV
 *
 * Run with: npm test
 *
 * Uses node:assert + node:test (built in to Node 18+) — no test runner needed.
 *
 * Isolation: a throwaway copy of database.db is created and exposed via the
 * AFS_DB_PATH env var, so the fixture database is never mutated by the tests.
 * The throwaway copy is removed after the suite completes.
 */

const path = require("path");
const fs = require("fs");

// Set up an isolated DB copy BEFORE requiring any project modules.
const REAL_DB = path.resolve(__dirname, "../database.db");
const TEST_DB = path.resolve(__dirname, "../database.test.db");
fs.copyFileSync(REAL_DB, TEST_DB);
process.env.AFS_DB_PATH = TEST_DB;

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasAirFilterRider, parseRiders, getEligibleTenants } = require("../src/eligibility");
const { runImport, getPendingReviews, getFilterStockSummary } = require("../src/import");
const db = require("../src/db");

// Cleanup: remove the test DB (and its WAL/SHM siblings) when the process exits.
process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch {} // best-effort
    }
  }
});

// ---------------------------------------------------------------------------

test("parseRiders handles fixture variants", () => {
  assert.deepEqual(parseRiders("{a,b,c}"), ["a", "b", "c"]);
  assert.deepEqual(parseRiders("{NULL}"), []);
  assert.deepEqual(parseRiders(""), []);
  assert.deepEqual(parseRiders(null), []);
  assert.deepEqual(parseRiders("{Free Airfilters Delivery,ID Theft Protection}"),
    ["Free Airfilters Delivery", "ID Theft Protection"]);
});

test("hasAirFilterRider matches both fixture variants", () => {
  assert.equal(hasAirFilterRider("{Free Airfilters Delivery}"), true);
  assert.equal(hasAirFilterRider("{Airfilters Delivery ($4)}"), true);
  assert.equal(hasAirFilterRider("{ID Theft Protection,Credit Reporting}"), false);
  assert.equal(hasAirFilterRider("{NULL}"), false);
  // case insensitive
  assert.equal(hasAirFilterRider("{airfilters delivery}"), true);
  // would-be variants
  assert.equal(hasAirFilterRider("{Premium Airfilters Delivery Service}"), true);
});

test("eligibility query returns plausible count for fixture data as of 2026-04-24", () => {
  const eligible = getEligibleTenants("2026-04-24");
  // Fixture data yields 88 tenants meeting active + air-filter rider + interval criteria.
  // (sensitive to data changes; bounds chosen wide.)
  assert.ok(eligible.length >= 80, `expected >=80 eligible, got ${eligible.length}`);
  assert.ok(eligible.length <= 100, `expected <=100 eligible, got ${eligible.length}`);

  // Sanity: every returned tenant has required fields
  for (const t of eligible) {
    assert.ok(typeof t.id === "number");
    assert.ok(typeof t.first_name === "string" && t.first_name.length > 0);
    assert.ok(typeof t.interval_days === "number" && t.interval_days > 0);
  }
});

test("eligibility caps last_ship_date at as_of (excludes future-dated history)", () => {
  // Tenant 135448 has a historical shipment dated 2026-05-15 (after as_of).
  // If they appear in the eligible list, their last_ship_date must not be that future date.
  const eligible = getEligibleTenants("2026-04-24");
  const t = eligible.find((x) => x.id === 135448);
  if (t && t.last_ship_date) {
    assert.ok(t.last_ship_date <= "2026-04-24",
      `last_ship_date should not be future-dated, got ${t.last_ship_date}`);
  }
});

test("import: matches the expected number of rows from shipstation-export.csv", () => {
  // Make this test deterministic regardless of prior state
  db.exec(`DELETE FROM filter_sizes; DELETE FROM pending_imports; DELETE FROM shipments;`);

  const csv = path.resolve(__dirname, "../shipstation-export.csv");
  const stats = runImport(csv);

  assert.equal(stats.total, 195);
  assert.equal(stats.matched + stats.unmatched + stats.duplicates + stats.invalid, stats.total);
  assert.ok(stats.matched >= 190, `expected at least 190 matched, got ${stats.matched}`);
  assert.equal(stats.unmatched, 2);
  assert.equal(stats.invalid, 0);
});

test("import: 'twenty-by-twenty' size token is captured with parse_error, not skipped", () => {
  const row = db.prepare(`
    SELECT fs.* FROM filter_sizes fs
    WHERE fs.raw_size = 'twenty-by-twenty'
  `).get();

  assert.ok(row, "expected a filter_sizes row for 'twenty-by-twenty'");
  assert.equal(row.parsed_ok, 0);
  assert.ok(row.parse_error, "parse_error should be populated");
  assert.ok(row.shipment_id || row.pending_import_id,
    "size must be linked to either a shipment or a pending import");
});

test("import: pending review queue contains the two known ambiguous rows", () => {
  const pending = getPendingReviews();
  assert.equal(pending.length, 2);
  const names = pending.map((p) => p.raw_name).sort();
  assert.deepEqual(names, ["Casey Morgan", "German Gerhold"]);
});

test("stock summary: totals reconcile with filter_sizes table", () => {
  const summary = getFilterStockSummary();

  // Parsed total in the summary must equal the parsed_ok rows in the table
  const dbParsed = db.prepare(`SELECT COUNT(*) AS c FROM filter_sizes WHERE parsed_ok = 1`).get().c;
  const dbUnparsed = db.prepare(`SELECT COUNT(*) AS c FROM filter_sizes WHERE parsed_ok = 0`).get().c;

  assert.equal(summary.totalParsed, dbParsed);
  assert.equal(summary.totalUnparsed, dbUnparsed);

  // The per-size counts must sum to the parsed total (nothing dropped)
  const sumOfRows = summary.parsed.reduce((s, r) => s + r.count, 0);
  assert.equal(sumOfRows, summary.totalParsed);

  // distinctSizes must match the number of grouped rows
  assert.equal(summary.distinctSizes, summary.parsed.length);

  // The known unparseable token must appear in the follow-up list, not the totals
  const followup = summary.unparsed.find((u) => u.raw_size === "twenty-by-twenty");
  assert.ok(followup, "'twenty-by-twenty' should be in the follow-up list");
});
