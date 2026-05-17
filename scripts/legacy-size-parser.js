#!/usr/bin/env node

/**
 * Legacy filter-size parser utility.
 *
 * This script was used for an earlier prototype. It may be useful as reference
 * material, but it is not intended to define the final application design.
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const readline = require("readline");
const Database = require("better-sqlite3");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const CSV_PATH = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, "shipstation-export.csv");
const DB_PATH  = path.join(REPO_ROOT, "database.db");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!fs.existsSync(CSV_PATH)) {
  console.error("Error: CSV file not found at " + CSV_PATH);
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error("Error: database not found at " + DB_PATH);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS filter_sizes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER REFERENCES tenants(id),
    shipment_id   TEXT,
    raw_size      TEXT    NOT NULL,
    length_inches REAL,
    width_inches  REAL,
    depth_inches  REAL,
    parsed_ok     INTEGER NOT NULL DEFAULT 0,
    parse_error   TEXT,
    parsed_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// CSV parsing (manual, line-by-line)
// ---------------------------------------------------------------------------

/**
 * Read the CSV into an array of plain objects keyed by header name.
 * We roll our own reader here to handle quoted fields.
 */
function readCsv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines   = content.split(/\r?\n/).filter((l) => l.trim() !== "");

  if (lines.length === 0) return [];

  // Parse a single CSV line respecting double-quoted fields
  function parseLine(line) {
    const fields = [];
    let current  = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          // Escaped quote inside quoted field
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  const headers = parseLine(lines[0]);
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    const record = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j] !== undefined ? values[j] : "";
    }
    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// Size parsing
// ---------------------------------------------------------------------------

function parseDimension(token) {
  if (!token || token.trim() === "") return null;

  const t = token.trim();

  // Plain integer or decimal: "16", "17.5"
  const plainMatch = t.match(/^(\d+(?:\.\d+)?)$/);
  if (plainMatch) {
    return parseFloat(plainMatch[1]);
  }

  // Mixed number with hyphen fraction: "16-1/2"
  const mixedMatch = t.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (mixedMatch) {
    const whole = parseInt(mixedMatch[1], 10);
    const num   = parseInt(mixedMatch[2], 10);
    const den   = parseInt(mixedMatch[3], 10);
    if (den === 0) return null;
    return whole + num / den;
  }

  // Plain fraction: "1/2"
  const fracMatch = t.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    if (den === 0) return null;
    return num / den;
  }

  return null;
}

/** Parse the LENGTH from a size string split on 'x'. */
function parseLength(parts) {
  return parseDimension(parts[0]);
}

/** Parse the WIDTH from a size string split on 'x'. */
function parseWidth(parts) {
  if (parts.length < 2) return null;
  return parseDimension(parts[1]);
}

/** Parse the DEPTH from a size string split on 'x'. */
function parseDepth(parts) {
  if (parts.length < 3) return null;
  return parseDimension(parts[2]);
}

function parseSizeToken(token) {
  const raw    = token.trim();
  const result = { raw, length: null, width: null, depth: null, ok: false, error: null };

  if (!raw) {
    result.error = "empty token";
    return result;
  }

  // Normalize the separator to lowercase 'x' before splitting
  const normalized = raw.replace(/X/g, "x");

  // Split on 'x' — but only when 'x' is used as a separator, not inside a
  // hyphen fraction like "16-1/2".  A separator 'x' sits between digit groups.
  const parts = normalized.split("x");

  if (parts.length < 2 || parts.length > 3) {
    result.error = `expected 2 or 3 dimensions, got ${parts.length} (raw: "${raw}")`;
    return result;
  }

  const length = parseLength(parts);
  const width  = parseWidth(parts);
  const depth  = parseDepth(parts);

  if (length === null) {
    result.error = `could not parse length from "${parts[0]}"`;
    return result;
  }
  if (width === null) {
    result.error = `could not parse width from "${parts[1]}"`;
    return result;
  }
  // Depth is optional (2-D sizes are allowed)
  if (parts.length === 3 && depth === null) {
    result.error = `could not parse depth from "${parts[2]}"`;
    return result;
  }

  result.length = length;
  result.width  = width;
  result.depth  = depth;
  result.ok     = true;
  return result;
}

function parseSizesFromCell(cellValue) {
  if (!cellValue || cellValue.trim() === "") return [];

  // Split on whitespace to get individual tokens, then filter out empties
  const tokens = cellValue.trim().split(/\s+/).filter((t) => t.length > 0);

  const results = [];
  for (const token of tokens) {
    results.push(parseSizeToken(token));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tenant lookup (per-row queries — one DB call per CSV row)
// ---------------------------------------------------------------------------

/**
 * Normalize a name string for comparison: lowercase and collapse whitespace.
 */
function normalizeName(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Split a full name "First Last" into parts.
 * Assumes the first token is first_name and the rest is last_name.
 */
function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return { first: parts[0] || "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

const findTenantByName = db.prepare(`
  SELECT * FROM tenants
  WHERE lower(first_name) = lower(@first)
    AND lower(last_name)  = lower(@last)
  LIMIT 1
`);

const findTenantByLastName = db.prepare(`
  SELECT * FROM tenants
  WHERE lower(last_name) = lower(@last)
`);

/**
 * Try to resolve a CSV row's name field to a tenant record.
 * Returns the tenant row or null.
 */
function lookupTenant(csvName) {
  if (!csvName || csvName.trim() === "") return null;

  const normalized = normalizeName(csvName);
  const { first, last } = splitName(normalized);

  // Attempt 1: exact first + last match
  const exact = findTenantByName.get({ first, last });
  if (exact) return exact;

  // Attempt 2: last-name-only match
  const byLast = findTenantByLastName.all({ last });
  if (byLast.length === 1) return byLast[0];

  return null;
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

const insertFilterSize = db.prepare(`
  INSERT INTO filter_sizes
    (tenant_id, shipment_id, raw_size, length_inches, width_inches, depth_inches,
     parsed_ok, parse_error)
  VALUES
    (@tenant_id, @shipment_id, @raw_size, @length_inches, @width_inches,
     @depth_inches, @parsed_ok, @parse_error)
`);

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

let rowsProcessed    = 0;
let rowsSkipped      = 0;
let sizesInserted    = 0;
let sizesFailedParse = 0;
let tenantsNotFound  = 0;
let tenantsFound     = 0;

// ---------------------------------------------------------------------------
// Main processing loop
// ---------------------------------------------------------------------------

console.log(`\nReading CSV: ${CSV_PATH}`);
const records = readCsv(CSV_PATH);
console.log(`Found ${records.length} rows\n`);

const insertAll = db.transaction(() => {
  for (const record of records) {
    rowsProcessed++;

    const rawCell   = record["custom_field_1"] || "";
    const csvName   = record["name"]           || "";
    const shipmentId = record["shipment_id"]   || "";

    // Skip rows with no size data
    if (!rawCell || rawCell.trim() === "") {
      console.warn(`  [ROW ${rowsProcessed}] No size data for "${csvName}", skipping`);
      rowsSkipped++;
      continue;
    }

    // Look up the tenant
    const tenant = lookupTenant(csvName);

    if (!tenant) {
      console.warn(`  [ROW ${rowsProcessed}] Tenant not found for name "${csvName}"`);
      tenantsNotFound++;
      // Still parse and store the size; tenant_id will be NULL
    } else {
      tenantsFound++;
    }

    const tenantId = tenant ? tenant.id : null;

    // Parse all size tokens in the cell
    const sizeResults = parseSizesFromCell(rawCell);

    if (sizeResults.length === 0) {
      console.warn(`  [ROW ${rowsProcessed}] Cell "${rawCell}" yielded no size tokens`);
      rowsSkipped++;
      continue;
    }

    for (const sz of sizeResults) {
      if (!sz.ok) {
        console.warn(
          `  [ROW ${rowsProcessed}] Parse failed for token "${sz.raw}": ${sz.error}`
        );
        sizesFailedParse++;
      }

      insertFilterSize.run({
        tenant_id:     tenantId,
        shipment_id:   shipmentId,
        raw_size:      sz.raw,
        length_inches: sz.length,
        width_inches:  sz.width,
        depth_inches:  sz.depth,
        parsed_ok:     sz.ok ? 1 : 0,
        parse_error:   sz.error || null,
      });

      sizesInserted++;
    }
  }
});

insertAll();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"─".repeat(50)}`);
console.log(`Size parse complete`);
console.log(`  CSV rows read:       ${records.length}`);
console.log(`  Rows processed:      ${rowsProcessed}`);
console.log(`  Rows skipped:        ${rowsSkipped}  (no size data)`);
console.log(`  Tenants matched:     ${tenantsFound}`);
console.log(`  Tenants not found:   ${tenantsNotFound}  (size stored with NULL tenant_id)`);
console.log(`  Size rows inserted:  ${sizesInserted}`);
console.log(`  Parse failures:      ${sizesFailedParse}  (stored with parsed_ok=0)`);
console.log(`${"─".repeat(50)}\n`);

// Show a sample of what was stored
const sample = db.prepare(`
  SELECT fs.id, fs.raw_size, fs.length_inches, fs.width_inches, fs.depth_inches,
         fs.parsed_ok, t.first_name || ' ' || t.last_name AS tenant_name
  FROM   filter_sizes fs
  LEFT JOIN tenants t ON t.id = fs.tenant_id
  ORDER  BY fs.id DESC
  LIMIT  10
`).all();

if (sample.length > 0) {
  console.log("Most recently inserted rows (newest first):");
  for (const row of sample) {
    const dims = row.parsed_ok
      ? `${row.length_inches}" × ${row.width_inches}" × ${row.depth_inches}"`
      : `(parse error)`;
    console.log(
      `  [${row.id}] ${String(row.raw_size).padEnd(16)} ${dims.padEnd(22)} tenant: ${row.tenant_name || "—"}`
    );
  }
}

db.close();
