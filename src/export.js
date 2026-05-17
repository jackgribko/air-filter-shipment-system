"use strict";

const path = require("path");
const fs = require("fs");
const { stringify } = require("csv-stringify/sync");
const db = require("./db");
const { getEligibleTenants } = require("./eligibility");

const EXPORTS_DIR = path.resolve(__dirname, "../exports");

// Ensure exports directory exists
if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });

const insertBatch = db.prepare(`
  INSERT INTO export_batches (row_count, filename) VALUES (@row_count, @filename)
`);
const insertOrder = db.prepare(`
  INSERT OR IGNORE INTO shipment_orders (tenant_id, batch_id)
  VALUES (@tenant_id, @batch_id)
`);

/**
 * Generate a CSV of eligible tenants as of @asOf, write it to the exports
 * directory, record the batch, and return { filename, rowCount, tenants }.
 *
 * Recording strategy: we insert a shipment_order row for each exported tenant.
 * This blocks them from being re-exported in subsequent batches until the
 * interval elapses from their order date. A shipment has been *ordered*, not
 * delivered, so we use the order date as a conservative proxy for "last
 * shipment" in the eligibility query (see eligibility.js).
 */
function runExport(asOf) {
  const tenants = getEligibleTenants(asOf);
  if (tenants.length === 0) {
    return { filename: null, rowCount: 0, tenants: [] };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `shipment-export-${timestamp}.csv`;
  const filepath = path.join(EXPORTS_DIR, filename);

  const rows = tenants.map((t) => ({
    recipient_name: `${t.first_name} ${t.last_name}`,
    address1: t.address1,
    address2: t.address2 || "",
    city: t.city,
    state: t.state,
    zip: t.zip,
    tenant_id: t.id,
    interval_days: t.interval_days,
    last_ship_date: t.last_ship_date || "",
  }));

  const csv = stringify(rows, { header: true });
  fs.writeFileSync(filepath, csv, "utf8");

  const run = db.transaction(() => {
    const batchInfo = insertBatch.run({ row_count: tenants.length, filename });
    const batchId = batchInfo.lastInsertRowid;
    for (const t of tenants) {
      insertOrder.run({ tenant_id: t.id, batch_id: batchId });
    }
    return batchId;
  });

  const batchId = run();

  return { filename, filepath, rowCount: tenants.length, batchId, tenants };
}

/**
 * Return all past export batches (most recent first).
 */
function listBatches() {
  return db
    .prepare(
      `SELECT id, exported_at, row_count, filename
       FROM export_batches ORDER BY exported_at DESC`
    )
    .all();
}

module.exports = { runExport, listBatches };
