# Air Filter Shipment System

A shipment management system for a renters insurance company that ships air filters to eligible tenants. Built as a Node.js/Express web application backed by SQLite.

## Screenshots

**Dashboard** — eligibility, export, import, and the eligible-tenants table on one page:

![Dashboard](docs/screenshots/01-dashboard.png)

**Manual review queue** — unmatched import rows with candidate tenants for one-click resolution:

![Review queue](docs/screenshots/02-review-queue.png)

---

## Setup & Running

**Prerequisites:** Node.js ≥ 18, `sqlite3` CLI (for fixture seeding only)

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Re-apply supplemental fixture data if you reset the database
npm run seed-fixtures

# 3. Start the server
npm start
# → http://localhost:3000
```

To reset the database to its original state (clears generated data, keeps tenants/enrollments/historical_shipments intact, removes generated export CSVs):

```bash
npm run reset
```

To run the test suite (smoke-tests for rider parsing, eligibility, import matching, and size parsing):

```bash
npm test
```

The database (`database.db`), property configuration (`properties.json`), and ShipStation CSV (`shipstation-export.csv`) are included in the repository.

### What the UI does

| Page | Description |
|------|-------------|
| `/` | Dashboard: shows eligible tenants, export history, and an import form |
| `POST /export` | Generates a CSV of eligible tenants and records the batch |
| `POST /import` | Uploads a ShipStation CSV and runs the import pipeline |
| `/review` | Manual review queue for unmatched import rows |
| `GET /api/eligible` | JSON list of eligible tenants (accepts `?as_of=YYYY-MM-DD`) |

---

## Requirements

### 1. Data Model

Tables added to the existing schema:

| Table | Purpose |
|-------|---------|
| `properties` | Property name and shipment interval; seeded from `properties.json` at startup |
| `tenant_properties` | Many-to-many tenant↔property join (handles multi-property anomalies) |
| `export_batches` | Records each CSV export run (timestamp, row count, filename) |
| `shipment_orders` | One row per tenant per batch; blocks re-export until interval elapses |
| `shipments` | Confirmed shipments created when import rows are matched |
| `pending_imports` | Unmatched import rows queued for manual review |
| `filter_sizes` | Parsed filter dimensions, linked to a shipment or pending import |

The existing `historical_shipments` table is preserved and queried alongside `shipments` and `shipment_orders` when computing eligibility.

### 2. Eligibility Engine

A tenant is eligible as of `2026-04-24` if:

1. They have at least one **active** enrollment with `product = 'Renters Kit'` and a rider whose label contains `"airfilter"` and `"delivery"` (case-insensitive). This matches both fixture variants:
   - `"Free Airfilters Delivery"` ✓
   - `"Airfilters Delivery ($4)"` ✓

2. Their most recent shipment event (across `historical_shipments`, `shipments`, and `shipment_orders`) is either absent or older than their property's `shipment_interval_days` as of the check date.

**Result:** 88 eligible tenants as of 2026-04-24.

### 3. Shipment Export

`POST /export` runs the eligibility engine, writes a CSV to `exports/`, and records the batch.

**Recording strategy:** A `shipment_orders` row is inserted for each exported tenant using the export timestamp as the order date. The eligibility engine treats this date as the tenant's most recent shipment event — so they won't be re-exported until `order_date + interval_days` passes, even before the physical shipment is confirmed. This is conservative by design: a shipment has been *ordered* and we shouldn't double-ship while waiting on a delivery confirmation we haven't yet received.

CSV columns: `recipient_name`, `address1`, `address2`, `city`, `state`, `zip`, `tenant_id`, `interval_days`, `last_ship_date`.

### 4. Shipment Import

`POST /import` accepts a multipart CSV upload and processes each row:

**Auto-matching:** Score each candidate tenant on:

| Field | Points |
|-------|--------|
| Full name (normalized) | 50 |
| Address line 1 | 30 |
| City | 10 |
| State | 5 |
| ZIP | 5 |

A row is auto-matched only when exactly one candidate scores ≥ 80 with no tie. This threshold requires at minimum a full-name match plus address confirmation — name alone is insufficient given the possibility of duplicate names across the tenant pool.

- **Matched rows** → inserted into `shipments`; filter sizes stored in `filter_sizes`.
- **Unmatched rows** → inserted into `pending_imports`; filter sizes stored and linked to the pending row. Appear in `/review`.
- **Filter sizes** (`custom_field_1`): parsed as space-separated `LxWxD` tokens (e.g. `16x20x1`, `16-1/2x20x1`). Parse failures are stored with `parsed_ok = 0` — the import is not blocked.

**Result on `shipstation-export.csv`:** 193 auto-matched, 2 flagged for manual review, 0 duplicates, 0 invalid.

**Manual review UI** (`/review`): displays each unmatched row alongside candidate tenants matched by last name / address fragment. **Candidates are ranked by the same scoring function used for auto-matching**, with the top score and the auto-match threshold shown above the dropdown — so a reviewer can see at a glance *why* a row was flagged (e.g. Casey Morgan scored 100 but tied with a duplicate; German Gerhold scored 70, below the 80 threshold, because his address changed). A reviewer confirms a match (creating a confirmed `shipments` record and migrating filter sizes) or dismisses the row.

---

## Assumptions & Tradeoffs

### Rider normalization

Both `"Free Airfilters Delivery"` and `"Airfilters Delivery ($4)"` are treated as air filter riders via a rule: label contains `"airfilter"` AND `"delivery"` (case-insensitive). This is intentionally broad — a new variant like `"Airfilters Delivery ($6)"` would still match without a code change. An exhaustive allowlist would be more explicit but would require updates whenever rider names are introduced.

### Property conflicts in `properties.json`

| Anomaly | Handling |
|---------|----------|
| `prop-riverbend` appears twice — "Riverbend" (90d) and "Riverbend Annex" (45d) | First occurrence wins; duplicate is logged and skipped on startup. The "Annex" row is treated as a data-entry error against the same property ID. |
| Tenant 145566 assigned to both Riverbend and Riverbend Annex | Only the first-inserted property assignment survives (Riverbend, 90d). The `MIN(interval_days)` query layer below would pick the shorter interval if both were inserted. |
| Tenant 135452 assigned to both Oak Terrace (60d) and Oak Overflow (120d) | Both rows are inserted into `tenant_properties`; eligibility uses `MIN(interval_days)` → 60d. Shorter = more conservative = avoids over-shipping. |
| **36 tenants in `tenants` table are not listed in any property** (32 of them have an active eligible enrollment) | A synthetic property `prop-unassigned-default` is created with a 90-day interval (the modal value across configured properties). These tenants are auto-assigned to it and surfaced in a startup warning. Without this fallback they would be silently excluded from eligibility — a major operational gap. |

### Export recording vs. delivery confirmation

We block re-export as soon as a batch is recorded, not when delivery is confirmed. If an order is cancelled or lost, an operator would need to clear the `shipment_orders` record (or a cancellation flow would be added). Waiting for confirmation would risk double-shipping during the gap.

### `historical_shipments` with a future date

One record has `ship_date = 2026-05-15`, which is after the eligibility date of `2026-04-24`. The eligibility query caps all look-ups at `ship_date <= as_of`, so this record is correctly excluded.

---

## Data Issues Found

| Issue | Impact | Handling |
|-------|--------|----------|
| Duplicate `prop-riverbend` ID in `properties.json` | Silent overwrite on naive upsert | Detected at startup; first occurrence wins, conflict logged |
| Tenant in two properties with different intervals | Ambiguous eligibility interval | `MIN(interval_days)` — conservative choice |
| 36 tenants in DB with no property assignment in JSON | Silent exclusion from eligibility (32 of them are otherwise eligible) | Default 90-day interval via synthetic property + startup warning |
| `historical_shipments` row with future date (2026-05-15) | Would incorrectly block eligibility | `ship_date <= as_of` filter in query |
| `riders` stored as PostgreSQL-style array literals `{A,B,C}` | Not queryable with SQLite JSON functions | Parsed in JS: strip `{}`, split on `,` |
| One CSV row size is text `"twenty-by-twenty"` | Would block the row if treated as fatal | Stored with `parsed_ok=0` and `parse_error`; rest of row imports normally |
| ShipStation `ship_date` is UTC ISO-8601 | Local-time conversion shifts the date for some timezones | `formatDate()` uses `getUTC*` components |
| ShipStation CSV has identical-data duplicates (Casey Morgan ×2) | Auto-matcher would pick arbitrarily | Tie detection: if top-scored candidates tie, the row goes to manual review |

---

## What I'd Improve With More Time

- **More tests** — current suite covers happy-path eligibility, rider parsing, size parsing, and the headline import numbers. I'd add integration tests for each API route, property-fallback coverage, and adversarial CSV inputs.
- **Authentication** — even a simple session-based login before this touches real tenant data
- **Batch cancellation** — allow voiding an export batch if shipments were not fulfilled
- **Confirmed-order linkage** — `shipment_orders.confirmed_shipment_id` exists on the schema but isn't yet populated on import-match. Once it is, the eligibility query could skip orders whose confirmed shipment is already counted, avoiding double-counting near the interval boundary.
- **Pagination** on the eligible-tenants table and review queue
- **Background import** — for large files the import should run async with a progress indicator rather than blocking the HTTP response
- **Property conflict resolution UI** — instead of silently picking first-occurrence, surface conflicts for human confirmation
- **Fuzzy name matching** in the auto-matcher — currently exact-on-normalized; Levenshtein/Jaro-Winkler would catch typos
- **Soft-deletes / audit log** — review queue dismissals are currently destructive; a real system would want a history of who-decided-what
