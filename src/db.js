"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const fs = require("fs");

// DB_PATH override lets the test suite point at a throwaway copy so tests
// never mutate the fixture database that ships with the repo.
const DB_PATH = process.env.AFS_DB_PATH
  ? path.resolve(process.env.AFS_DB_PATH)
  : path.resolve(__dirname, "../database.db");
const PROPERTIES_PATH = path.resolve(__dirname, "../properties.json");

// Fallback shipment interval for tenants present in the tenants table but
// absent from properties.json. 90 days is the modal interval across the
// configured properties and a conservative middle-ground (range 45-120).
// See README → "Data Issues Found" for the full rationale.
const DEFAULT_INTERVAL_DAYS = 90;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    shipment_interval_days INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tenant_properties (
    tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
    property_id TEXT    NOT NULL REFERENCES properties(id),
    PRIMARY KEY (tenant_id, property_id)
  );

  CREATE TABLE IF NOT EXISTS export_batches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exported_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count   INTEGER NOT NULL,
    filename    TEXT
  );

  CREATE TABLE IF NOT EXISTS shipment_orders (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id            INTEGER NOT NULL REFERENCES tenants(id),
    batch_id             INTEGER NOT NULL REFERENCES export_batches(id),
    ordered_at           TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_shipment_id INTEGER REFERENCES shipments(id)
  );

  CREATE TABLE IF NOT EXISTS shipments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
    ship_date       TEXT NOT NULL,
    tracking_number TEXT NOT NULL UNIQUE,
    imported_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS filter_sizes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id       INTEGER REFERENCES shipments(id),
    pending_import_id INTEGER REFERENCES pending_imports(id),
    raw_size          TEXT NOT NULL,
    length_inches     REAL,
    width_inches      REAL,
    depth_inches      REAL,
    parsed_ok         INTEGER NOT NULL DEFAULT 0,
    parse_error       TEXT,
    parsed_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_imports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_name          TEXT NOT NULL,
    raw_custom_field_1 TEXT,
    address1          TEXT,
    address2          TEXT,
    city              TEXT,
    state             TEXT,
    zip               TEXT,
    ship_date         TEXT,
    tracking_number   TEXT NOT NULL UNIQUE,
    status            TEXT NOT NULL DEFAULT 'pending',
    matched_tenant_id INTEGER REFERENCES tenants(id),
    reviewed_at       TEXT,
    dismissed         INTEGER NOT NULL DEFAULT 0
  );
`);

// ---------------------------------------------------------------------------
// Seed properties from properties.json
// ---------------------------------------------------------------------------

function seedProperties() {
  const raw = JSON.parse(fs.readFileSync(PROPERTIES_PATH, "utf8"));
  const seenIds = new Map(); // id -> first-seen name (for dedup logging)
  const warnings = { dupePropertyIds: [], missingTenants: [], orphanTenants: [] };

  const insertProp = db.prepare(`
    INSERT OR IGNORE INTO properties (id, name, shipment_interval_days)
    VALUES (@id, @name, @shipment_interval_days)
  `);
  const insertTenantProp = db.prepare(`
    INSERT OR IGNORE INTO tenant_properties (tenant_id, property_id)
    VALUES (@tenant_id, @property_id)
  `);
  const tenantExists = db.prepare(`SELECT 1 FROM tenants WHERE id = ?`);

  const assignedTenantIds = new Set();

  const run = db.transaction(() => {
    for (const prop of raw.properties) {
      // Handle duplicate property ID: the second entry for "prop-riverbend"
      // has a different name ("Riverbend Annex") and a shorter interval (45
      // days). We keep the first occurrence and log the conflict. Tenants
      // listed in both entries are mapped only to the first-inserted property;
      // the conflict is surfaced in the startup warning so an operator can
      // correct the data file.
      if (seenIds.has(prop.id)) {
        warnings.dupePropertyIds.push({ id: prop.id, kept: seenIds.get(prop.id), dropped: prop.name });
        continue;
      }
      seenIds.set(prop.id, prop.name);

      insertProp.run({
        id: prop.id,
        name: prop.name,
        shipment_interval_days: prop.shipment_interval_days,
      });

      for (const tenantId of prop.tenant_ids) {
        if (!tenantExists.get(tenantId)) {
          warnings.missingTenants.push({ tenantId, propertyName: prop.name });
          continue;
        }
        insertTenantProp.run({ tenant_id: tenantId, property_id: prop.id });
        assignedTenantIds.add(tenantId);
      }
    }

    // Synthetic "default" property for tenants present in the database but
    // absent from properties.json. The spec asks for a "reasonable fallback
    // approach for property data that cannot be applied cleanly". A synthetic
    // property with the modal interval (90 days) lets these tenants flow
    // through the eligibility engine instead of being silently excluded;
    // they're surfaced in a startup warning so the data gap is visible.
    insertProp.run({
      id: "prop-unassigned-default",
      name: "(Unassigned — default fallback)",
      shipment_interval_days: DEFAULT_INTERVAL_DAYS,
    });

    const allTenantIds = db.prepare("SELECT id FROM tenants").all().map((t) => t.id);
    for (const tid of allTenantIds) {
      if (!assignedTenantIds.has(tid)) {
        insertTenantProp.run({ tenant_id: tid, property_id: "prop-unassigned-default" });
        warnings.orphanTenants.push(tid);
      }
    }
  });

  run();
  return warnings;
}

const warnings = seedProperties();

// ---------------------------------------------------------------------------
// Surface data-quality warnings at startup
// ---------------------------------------------------------------------------

if (warnings.dupePropertyIds.length) {
  console.warn(`[properties] ${warnings.dupePropertyIds.length} duplicate property ID(s) in properties.json:`);
  for (const w of warnings.dupePropertyIds) {
    console.warn(`    - id="${w.id}" kept="${w.kept}" dropped="${w.dropped}"`);
  }
}
if (warnings.missingTenants.length) {
  console.warn(`[properties] ${warnings.missingTenants.length} tenant ID(s) referenced in properties.json but missing from tenants table:`);
  for (const w of warnings.missingTenants.slice(0, 10)) {
    console.warn(`    - tenant ${w.tenantId} (referenced by property "${w.propertyName}")`);
  }
}
if (warnings.orphanTenants.length) {
  console.warn(
    `[properties] ${warnings.orphanTenants.length} tenant(s) have no property assignment in properties.json. ` +
    `Assigning them to "prop-unassigned-default" with a ${DEFAULT_INTERVAL_DAYS}-day interval.`
  );
}

module.exports = db;
