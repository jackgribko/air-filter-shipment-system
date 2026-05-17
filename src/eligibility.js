"use strict";

const db = require("./db");

// ---------------------------------------------------------------------------
// Rider normalization
//
// We treat a rider as an "air filter delivery" rider if its label (case-insensitive)
// contains both "airfilter" and "delivery". This matches both fixture variants:
//   "Free Airfilters Delivery"   → airfilter + delivery ✓
//   "Airfilters Delivery ($4)"   → airfilter + delivery ✓
//
// The riders column uses PostgreSQL-style array literals: {A,B,C}
// We strip the braces and split on commas.
// ---------------------------------------------------------------------------

function isAirFilterRider(label) {
  const l = label.toLowerCase();
  return l.includes("airfilter") && l.includes("delivery");
}

function parseRiders(ridersStr) {
  if (!ridersStr) return [];
  // strip surrounding { }
  const inner = ridersStr.trim().replace(/^\{/, "").replace(/\}$/, "");
  if (!inner || inner === "NULL") return [];
  return inner.split(",").map((s) => s.trim());
}

function hasAirFilterRider(ridersStr) {
  return parseRiders(ridersStr).some(isAirFilterRider);
}

// ---------------------------------------------------------------------------
// Most-recent shipment event for a tenant, considering:
//   • historical_shipments  (pre-existing data)
//   • shipments             (confirmed imports)
//   • shipment_orders       (pending exports not yet confirmed)
//
// historical_shipments and shipments are capped at @as_of so future-dated
// data doesn't affect a historical eligibility query. shipment_orders are
// NOT capped: they represent active commitments to ship and must always
// block re-export, even if @as_of is in the past relative to the order date.
// ---------------------------------------------------------------------------

const mostRecentShipmentStmt = db.prepare(`
  SELECT MAX(event_date) AS last_ship_date
  FROM (
    SELECT ship_date AS event_date FROM historical_shipments
      WHERE tenant_id = @tenant_id AND ship_date <= @as_of
    UNION ALL
    SELECT ship_date AS event_date FROM shipments
      WHERE tenant_id = @tenant_id AND ship_date <= @as_of
    UNION ALL
    SELECT date(ordered_at) AS event_date FROM shipment_orders
      WHERE tenant_id = @tenant_id
  )
`);

// Property interval for a tenant: if a tenant belongs to multiple properties
// (data anomaly in properties.json) we take the MINIMUM interval, which is the
// most conservative (shortest wait before re-shipment). This prevents us from
// over-shipping relative to any property's policy.
const propertyIntervalStmt = db.prepare(`
  SELECT MIN(p.shipment_interval_days) AS interval_days
  FROM tenant_properties tp
  JOIN properties p ON p.id = tp.property_id
  WHERE tp.tenant_id = @tenant_id
`);

// Tenants with an eligible active Renters Kit enrollment.
// We return all such tenants and filter in JS so rider parsing happens once.
const eligibleEnrollmentsStmt = db.prepare(`
  SELECT DISTINCT
    t.id, t.first_name, t.last_name,
    t.address1, t.address2, t.city, t.state, t.zip,
    e.riders
  FROM tenants t
  JOIN enrollments e ON e.tenant_id = t.id
  WHERE e.active = 1
    AND e.product = 'Renters Kit'
`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns an array of eligible tenant records as of the given date string
 * (YYYY-MM-DD). Each record includes the tenant's fields plus:
 *   • interval_days         – their property's shipment interval
 *   • last_ship_date        – most recent shipment date (or null)
 *   • days_since_shipment   – integer days since last shipment (or null)
 */
function getEligibleTenants(asOf) {
  const candidates = eligibleEnrollmentsStmt.all();
  const eligible = [];

  for (const row of candidates) {
    if (!hasAirFilterRider(row.riders)) continue;

    const propRow = propertyIntervalStmt.get({ tenant_id: row.id });
    if (!propRow || propRow.interval_days === null) {
      // Tenant has no property assignment — skip with no fallback.
      // We cannot determine their shipment interval, so we cannot safely
      // determine eligibility. These are flagged in startup logs.
      continue;
    }
    const intervalDays = propRow.interval_days;

    const shipRow = mostRecentShipmentStmt.get({ tenant_id: row.id, as_of: asOf });
    const lastShipDate = shipRow?.last_ship_date ?? null;

    let daysSince = null;
    if (lastShipDate) {
      const msPerDay = 86400000;
      daysSince = Math.floor(
        (new Date(asOf) - new Date(lastShipDate)) / msPerDay
      );
    }

    const eligible_ = lastShipDate === null || daysSince >= intervalDays;
    if (!eligible_) continue;

    eligible.push({
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      address1: row.address1,
      address2: row.address2 || "",
      city: row.city,
      state: row.state,
      zip: row.zip,
      interval_days: intervalDays,
      last_ship_date: lastShipDate,
      days_since_shipment: daysSince,
    });
  }

  return eligible;
}

module.exports = { getEligibleTenants, hasAirFilterRider, parseRiders };
