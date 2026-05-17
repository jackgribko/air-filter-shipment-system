#!/usr/bin/env node
/**
 * Reset script — clears all data created by this application, leaving the
 * provided fixture data (tenants, enrollments, historical_shipments) intact.
 *
 * Use this to return the database to its "fresh" state before a demo or
 * before re-running the import end-to-end.
 *
 * Run with: npm run reset
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const db   = require("./db");

const TABLES_TO_CLEAR = [
  "filter_sizes",
  "pending_imports",
  "shipment_orders",
  "shipments",
  "export_batches",
  // Note: properties and tenant_properties are re-seeded from properties.json
  // on every startup, so we clear them too for a fully clean state.
  "tenant_properties",
  "properties",
];

const run = db.transaction(() => {
  for (const table of TABLES_TO_CLEAR) {
    const info = db.prepare(`DELETE FROM ${table}`).run();
    console.log(`  cleared ${table}: ${info.changes} rows`);
  }
});

run();

// Clear generated export CSVs
const exportsDir = path.resolve(__dirname, "../exports");
if (fs.existsSync(exportsDir)) {
  for (const f of fs.readdirSync(exportsDir)) {
    if (f.endsWith(".csv")) {
      fs.unlinkSync(path.join(exportsDir, f));
      console.log(`  removed exports/${f}`);
    }
  }
}

console.log("\nReset complete. Run `npm start` for a fresh demo.");
db.close();
