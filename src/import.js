"use strict";

const fs = require("fs");
const { parse } = require("csv-parse/sync");
const db = require("./db");

// ---------------------------------------------------------------------------
// Scoring constants
//
// Confidence threshold: a row is auto-matched only when a single candidate
// scores above this value. We require at minimum a full-name match (50 pts)
// plus one address component. A name-only match is not sufficient because
// common names could collide across tenants.
// ---------------------------------------------------------------------------
const SCORE_NAME    = 50;
const SCORE_ADDR1   = 30;
const SCORE_CITY    = 10;
const SCORE_STATE   =  5;
const SCORE_ZIP     =  5;
const CONFIDENCE_THRESHOLD = 80; // name + at least address1

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normAddr(s) {
  return (s || "").toLowerCase().replace(/[.,#]/g, "").replace(/\s+/g, " ").trim();
}

function formatDate(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const dd   = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Filter size parsing (LxWxD, supports fractions like 16-1/2)
// ---------------------------------------------------------------------------

function parseDim(token) {
  const t = (token || "").trim();
  const plain = t.match(/^(\d+(?:\.\d+)?)$/);
  if (plain) return parseFloat(plain[1]);
  const mixed = t.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (mixed) {
    const den = parseInt(mixed[3], 10);
    if (den === 0) return null;
    return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / den;
  }
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const den = parseInt(frac[2], 10);
    if (den === 0) return null;
    return parseInt(frac[1], 10) / den;
  }
  return null;
}

function parseSizeToken(token) {
  const raw = token.trim();
  const parts = raw.replace(/X/g, "x").split("x");
  if (parts.length < 2 || parts.length > 3) {
    return { raw, ok: false, error: `expected 2-3 dims, got ${parts.length}` };
  }
  const l = parseDim(parts[0]);
  const w = parseDim(parts[1]);
  const d = parts[2] ? parseDim(parts[2]) : null;
  if (l === null) return { raw, ok: false, error: `bad length: ${parts[0]}` };
  if (w === null) return { raw, ok: false, error: `bad width: ${parts[1]}` };
  if (parts[2] && d === null) return { raw, ok: false, error: `bad depth: ${parts[2]}` };
  return { raw, ok: true, length: l, width: w, depth: d, error: null };
}

function parseSizesFromCell(cell) {
  if (!cell || !cell.trim()) return [];
  return cell.trim().split(/\s+/).filter(Boolean).map(parseSizeToken);
}

// ---------------------------------------------------------------------------
// Tenant index (built once per import run)
// ---------------------------------------------------------------------------

function buildTenantIndex() {
  const tenants = db.prepare("SELECT * FROM tenants").all();
  const byName  = new Map();
  for (const t of tenants) {
    const key = norm(`${t.first_name} ${t.last_name}`);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(t);
  }
  return { tenants, byName };
}

function scoreCandidate(row, tenant) {
  let score = 0;
  if (norm(`${tenant.first_name} ${tenant.last_name}`) === row.name) score += SCORE_NAME;
  if (normAddr(tenant.address1) === row.address1)                     score += SCORE_ADDR1;
  if (norm(tenant.city) === row.city)                                 score += SCORE_CITY;
  if (norm(tenant.state) === row.state)                               score += SCORE_STATE;
  if (norm(tenant.zip) === row.zip)                                   score += SCORE_ZIP;
  return score;
}

function findBestMatch(row, byName) {
  const candidates = byName.get(row.name) || [];
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((t) => ({ tenant: t, score: scoreCandidate(row, t) }))
    .filter((s) => s.score >= CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Only auto-match if the top score is unambiguously best (no tie)
  if (scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].tenant;
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
    (raw_name, raw_custom_field_1, address1, address2, city, state, zip, ship_date, tracking_number)
  VALUES
    (@raw_name, @raw_custom_field_1, @address1, @address2, @city, @state, @zip, @ship_date, @tracking_number)
`);

const insertSize = db.prepare(`
  INSERT INTO filter_sizes
    (shipment_id, pending_import_id, raw_size, length_inches, width_inches, depth_inches, parsed_ok, parse_error)
  VALUES
    (@shipment_id, @pending_import_id, @raw_size, @length_inches, @width_inches, @depth_inches, @parsed_ok, @parse_error)
`);

const getShipmentByTracking = db.prepare(`
  SELECT id FROM shipments WHERE tracking_number = @tracking_number
`);
const getPendingByTracking = db.prepare(`
  SELECT id FROM pending_imports WHERE tracking_number = @tracking_number
`);

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

/**
 * Parse @csvPath and import rows into the database.
 * Returns a stats summary object.
 */
function runImport(csvPath) {
  const raw  = fs.readFileSync(csvPath, "utf8");
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  const { byName } = buildTenantIndex();

  const stats = { total: 0, matched: 0, unmatched: 0, duplicates: 0, invalid: 0 };
  stats.total = rows.length;

  const run = db.transaction(() => {
    for (const rawRow of rows) {
      const tracking = rawRow.shipment_id?.trim();
      if (!tracking || !rawRow.name) {
        stats.invalid++;
        continue;
      }

      const row = {
        name:     norm(rawRow.name),
        address1: normAddr(rawRow.address1),
        address2: normAddr(rawRow.address2),
        city:     norm(rawRow.city),
        state:    norm(rawRow.state),
        zip:      norm(rawRow.zip),
        ship_date: formatDate(rawRow.ship_date),
      };

      const tenant = findBestMatch(row, byName);
      const sizes  = parseSizesFromCell(rawRow.custom_field_1);

      if (tenant) {
        const info = insertShipment.run({
          tenant_id:       tenant.id,
          ship_date:       row.ship_date,
          tracking_number: tracking,
        });

        if (info.changes === 0) {
          stats.duplicates++;
          continue;
        }
        stats.matched++;

        const shipment = getShipmentByTracking.get({ tracking_number: tracking });
        for (const sz of sizes) {
          insertSize.run({
            shipment_id:       shipment.id,
            pending_import_id: null,
            raw_size:          sz.raw,
            length_inches:     sz.length ?? null,
            width_inches:      sz.width  ?? null,
            depth_inches:      sz.depth  ?? null,
            parsed_ok:         sz.ok ? 1 : 0,
            parse_error:       sz.error ?? null,
          });
        }
      } else {
        const info = insertPending.run({
          raw_name:          rawRow.name,
          raw_custom_field_1: rawRow.custom_field_1 || null,
          address1:          rawRow.address1 || null,
          address2:          rawRow.address2 || null,
          city:              rawRow.city     || null,
          state:             rawRow.state    || null,
          zip:               rawRow.zip      || null,
          ship_date:         row.ship_date,
          tracking_number:   tracking,
        });

        if (info.changes === 0) {
          stats.duplicates++;
          continue;
        }
        stats.unmatched++;

        const pending = getPendingByTracking.get({ tracking_number: tracking });
        for (const sz of sizes) {
          insertSize.run({
            shipment_id:       null,
            pending_import_id: pending.id,
            raw_size:          sz.raw,
            length_inches:     sz.length ?? null,
            width_inches:      sz.width  ?? null,
            depth_inches:      sz.depth  ?? null,
            parsed_ok:         sz.ok ? 1 : 0,
            parse_error:       sz.error ?? null,
          });
        }
      }
    }
  });

  run();
  return stats;
}

// ---------------------------------------------------------------------------
// Review queue helpers
// ---------------------------------------------------------------------------

function getPendingReviews() {
  return db.prepare(`
    SELECT * FROM pending_imports
    WHERE status = 'pending' AND dismissed = 0
    ORDER BY id
  `).all();
}

function getTenantCandidates(pendingId) {
  const pi = db.prepare(`SELECT * FROM pending_imports WHERE id = ?`).get(pendingId);
  if (!pi) return { pending: null, candidates: [] };

  // Find candidates: match on last name fragment or partial address
  const nameParts = pi.raw_name.trim().toLowerCase().split(/\s+/);
  const lastName = nameParts[nameParts.length - 1] || "";

  const candidates = db.prepare(`
    SELECT * FROM tenants
    WHERE lower(last_name) LIKE @last
       OR lower(address1)  LIKE @addr
    LIMIT 20
  `).all({
    last: `%${lastName}%`,
    addr: `%${(pi.address1 || "").toLowerCase().split(" ")[0]}%`,
  });

  return { pending: pi, candidates };
}

const confirmMatch = db.prepare(`
  UPDATE pending_imports
  SET status = 'matched', matched_tenant_id = @tenant_id, reviewed_at = datetime('now')
  WHERE id = @id
`);

const dismissRow = db.prepare(`
  UPDATE pending_imports
  SET dismissed = 1, reviewed_at = datetime('now')
  WHERE id = @id
`);

function resolveMatch(pendingId, tenantId) {
  // Create a confirmed shipment from the pending row
  const pi = db.prepare(`SELECT * FROM pending_imports WHERE id = ?`).get(pendingId);
  if (!pi) throw new Error(`Pending import ${pendingId} not found`);

  const run = db.transaction(() => {
    confirmMatch.run({ id: pendingId, tenant_id: tenantId });

    const info = insertShipment.run({
      tenant_id:       tenantId,
      ship_date:       pi.ship_date,
      tracking_number: pi.tracking_number,
    });

    if (info.changes > 0) {
      const shipment = getShipmentByTracking.get({ tracking_number: pi.tracking_number });
      // Move any filter sizes from pending to confirmed shipment
      db.prepare(`
        UPDATE filter_sizes SET shipment_id = @ship_id, pending_import_id = NULL
        WHERE pending_import_id = @pending_id
      `).run({ ship_id: shipment.id, pending_id: pendingId });
    }
  });

  run();
}

function dismissPending(pendingId) {
  dismissRow.run({ id: pendingId });
}

module.exports = {
  runImport,
  getPendingReviews,
  getTenantCandidates,
  resolveMatch,
  dismissPending,
};
