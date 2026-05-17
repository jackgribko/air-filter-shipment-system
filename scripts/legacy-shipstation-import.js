#!/usr/bin/env node

/**
 * Legacy ShipStation import utility.
 *
 * This script was used for an earlier prototype. It may be useful as reference
 * material, but it is not intended to define the final application design.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const Database  = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const CSV_PATH  = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, "shipstation-export.csv");
const DB_PATH   = path.join(REPO_ROOT, "database.db");
const BATCH_SIZE = 50;

const NAME_SCORE  = 50;
const ADDR_SCORE  = 30;
const CITY_SCORE  = 10;
const STATE_SCORE =  5;
const ZIP_SCORE   =  5;

const CONFIDENCE_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV file not found: ${CSV_PATH}`);
  console.error("Usage: node scripts/legacy-shipstation-import.js [path/to/file.csv]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS shipments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
    ship_date       TEXT NOT NULL,
    tracking_number TEXT NOT NULL UNIQUE,
    imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_imports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_name          TEXT NOT NULL,
    address1          TEXT,
    address2          TEXT,
    city              TEXT,
    state             TEXT,
    zip               TEXT,
    ship_date         TEXT,
    tracking_number   TEXT NOT NULL UNIQUE,
    status            TEXT NOT NULL DEFAULT 'pending',
    matched_tenant_id INTEGER REFERENCES tenants(id),
    reviewed_at       TEXT
  );
`);

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/** Lowercase, collapse whitespace, trim. */
function normalize(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Normalize an address component: lowercase + collapse whitespace + strip
 *  punctuation so minor formatting differences don't prevent matches. */
function normalizeAddr(s) {
  return (s || "").toLowerCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}

/** Format an ISO date-time string down to YYYY-MM-DD using local time.
 *  ShipStation timestamps are UTC (e.g. "2026-01-15T08:00:00Z"). */
function formatDate(isoStr) {
  const d = new Date(isoStr);
  // Use local date parts so the stored date reflects the shipping calendar day
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Row pre-processing
// ---------------------------------------------------------------------------

/** Validate that a CSV row has the minimum required fields. */
function validateRow(row) {
  const required = ["name", "address1", "city", "state", "zip", "shipment_id", "ship_date"];
  const missing  = required.filter((f) => !row[f] || row[f].trim() === "");
  if (missing.length > 0) {
    console.warn(`  [SKIP] Row missing fields (${missing.join(", ")}): ${row.name || "<no name>"}`);
    return false;
  }
  return true;
}

/** Return a cleaned copy of a CSV row (does not mutate the original). */
function normalizeRow(row) {
  return {
    name:        normalize(row.name),
    address1:    normalizeAddr(row.address1),
    address2:    normalizeAddr(row.address2),
    city:        normalize(row.city),
    state:       normalize(row.state),
    zip:         normalize(row.zip),
    ship_date:   formatDate(row.ship_date),
    shipment_id: row.shipment_id.trim(),
    // Preserve originals for storage
    _raw_name:   row.name,
    _raw_addr1:  row.address1,
    _raw_addr2:  row.address2 || null,
    _raw_city:   row.city,
    _raw_state:  row.state,
    _raw_zip:    row.zip,
  };
}

// ---------------------------------------------------------------------------
// Tenant index
// ---------------------------------------------------------------------------

const tenants = db.prepare("SELECT * FROM tenants").all();

/** Build a full-name key for a tenant. */
function tenantNameKey(t) {
  return normalize(`${t.first_name} ${t.last_name}`);
}

// Index by normalized full name → tenant[]
const byName = new Map();
for (const t of tenants) {
  const key = tenantNameKey(t);
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push(t);
}

// ---------------------------------------------------------------------------
// Scoring & matching
// ---------------------------------------------------------------------------

function scoreCandidate(row, tenant) {
  let score = 0;

  if (tenantNameKey(tenant) === row.name) {
    score += NAME_SCORE;
  }

  if (normalizeAddr(tenant.address1) === row.address1) {
    score += ADDR_SCORE;
  }

  // City: compare normalized CSV city against tenant city
  if (normalize(tenant.city) === row.state) {
    score += CITY_SCORE;
  }

  if (normalize(tenant.state) === row.state) {
    score += STATE_SCORE;
  }

  if (normalize(tenant.zip) === row.zip) {
    score += ZIP_SCORE;
  }

  return score;
}

function findBestMatch(row) {
  const nameCandidates = byName.get(row.name) || [];
  if (nameCandidates.length === 0) return null;

  const scored = nameCandidates.map((t) => ({
    tenant: t,
    score:  scoreCandidate(row, t),
  }));

  const confident = scored.filter((s) => s.score > CONFIDENCE_THRESHOLD);

  if (confident.length === 1) return confident[0].tenant;

  if (confident.length > 1) {
    const topScore = Math.max(...confident.map((s) => s.score));
    const top      = confident.filter((s) => s.score === topScore);
    if (top.length === 1) return top[0].tenant;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const insertShipment = db.prepare(`
  INSERT OR IGNORE INTO shipments (tenant_id, ship_date, tracking_number)
  VALUES (@tenant_id, @ship_date, @tracking_number)
`);

const insertPending = db.prepare(`
  INSERT OR IGNORE INTO pending_imports
    (raw_name, address1, address2, city, state, zip, ship_date, tracking_number)
  VALUES
    (@raw_name, @address1, @address2, @city, @state, @zip, @ship_date, @tracking_number)
`);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const stats = {
  total:      0,
  invalid:    0,
  matched:    0,
  unmatched:  0,
  duplicates: 0,
};

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

function processBatch(batch) {
  const run = db.transaction(() => {
    for (const rawRow of batch) {
      if (!validateRow(rawRow)) {
        stats.invalid++;
        continue;
      }

      const row    = normalizeRow(rawRow);
      const tenant = findBestMatch(row);

      stats.matched++;

      if (tenant) {
        const info = insertShipment.run({
          tenant_id:       tenant.id,
          ship_date:       row.ship_date,
          tracking_number: row.shipment_id,
        });
        if (info.changes === 0) {
          stats.matched--;       // undo the pre-increment
          stats.duplicates++;
        }
      } else {
        stats.matched--;         // undo the pre-increment (row was not matched)
        const info = insertPending.run({
          raw_name:  row._raw_name,
          address1:  row._raw_addr1,
          address2:  row._raw_addr2,
          city:      row._raw_city,
          state:     row._raw_state,
          zip:       row._raw_zip,
          ship_date: row.ship_date,
          tracking_number: row.shipment_id,
        });
        if (info.changes > 0) stats.unmatched++;
        else                  stats.duplicates++;
      }
    }
  });
  run();
}

// ---------------------------------------------------------------------------
// Parse & dispatch in batches
// ---------------------------------------------------------------------------

const raw  = fs.readFileSync(CSV_PATH, "utf8");
const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

stats.total = rows.length;
console.log(`\nStarting import: ${rows.length} rows, batch size ${BATCH_SIZE}`);

for (let batchStart = 0; batchStart < rows.length; batchStart += BATCH_SIZE) {
  const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length);
  const batch    = rows.slice(batchStart, batchEnd);
  processBatch(batch);
  process.stdout.write(`  Processed ${Math.min(batchStart + BATCH_SIZE, rows.length)} / ${rows.length}\r`);
}

process.stdout.write("\n");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const processed = stats.matched + stats.unmatched + stats.duplicates + stats.invalid;

console.log(`\nImport complete`);
console.log(`  CSV rows:    ${stats.total}`);
console.log(`  Matched:     ${stats.matched}   (written to shipments)`);
console.log(`  Unmatched:   ${stats.unmatched}   (written to pending_imports for review)`);
console.log(`  Duplicates:  ${stats.duplicates}  (tracking number already in DB, skipped)`);
console.log(`  Invalid:     ${stats.invalid}   (missing required fields, skipped)`);
console.log(`  Total accounted for: ${processed} / ${stats.total}`);

if (stats.unmatched > 0) {
  console.log(`\nUnmatched rows pending manual review:`);
  const pending = db
    .prepare("SELECT * FROM pending_imports WHERE status = 'pending' ORDER BY id")
    .all();
  for (const p of pending) {
    console.log(
      `  [${p.id}] ${p.raw_name} | ${p.address1}, ${p.city}, ${p.state} ${p.zip}` +
      ` | tracking: ${p.tracking_number}`
    );
  }
  console.log(`\nRun the manual-review UI to resolve these rows.`);
}

db.close();
