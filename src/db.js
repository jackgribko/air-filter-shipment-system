"use strict";

const path = require("path");
const Database = require("better-sqlite3");
const fs = require("fs");

const DB_PATH = path.resolve(__dirname, "../database.db");
const PROPERTIES_PATH = path.resolve(__dirname, "../properties.json");

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

  const insertProp = db.prepare(`
    INSERT OR IGNORE INTO properties (id, name, shipment_interval_days)
    VALUES (@id, @name, @shipment_interval_days)
  `);
  const insertTenantProp = db.prepare(`
    INSERT OR IGNORE INTO tenant_properties (tenant_id, property_id)
    VALUES (@tenant_id, @property_id)
  `);
  const tenantExists = db.prepare(`SELECT 1 FROM tenants WHERE id = ?`);

  const run = db.transaction(() => {
    for (const prop of raw.properties) {
      // Handle duplicate property ID: the second entry for "prop-riverbend"
      // has a different name ("Riverbend Annex") and a shorter interval (45 days).
      // We keep the first occurrence and log the conflict. Tenants that appear
      // in both entries get the interval from the first-inserted property; the
      // more conservative (shorter) interval is preferred, so callers should be
      // aware of this ordering assumption. See README for full discussion.
      if (seenIds.has(prop.id)) {
        console.warn(
          `[properties] Duplicate property ID "${prop.id}" ` +
          `(first: "${seenIds.get(prop.id)}", duplicate: "${prop.name}") — skipping duplicate.`
        );
        continue;
      }
      seenIds.set(prop.id, prop.name);

      insertProp.run({
        id: prop.id,
        name: prop.name,
        shipment_interval_days: prop.shipment_interval_days,
      });

      for (const tenantId of prop.tenant_ids) {
        const exists = tenantExists.get(tenantId);
        if (!exists) {
          console.warn(`[properties] Tenant ID ${tenantId} in property "${prop.name}" not found in tenants table — skipping.`);
          continue;
        }
        insertTenantProp.run({ tenant_id: tenantId, property_id: prop.id });
      }
    }
  });

  run();
}

seedProperties();

module.exports = db;
