"use strict";

const path    = require("path");
const fs      = require("fs");
const express = require("express");
const multer  = require("multer");

const { getEligibleTenants }              = require("./eligibility");
const { runExport, listBatches }          = require("./export");
const { runImport, getPendingReviews,
        getTenantCandidates, resolveMatch,
        dismissPending }                   = require("./import");

const app    = express();
const upload = multer({ dest: "/tmp/air-filter-uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve(__dirname, "../views/static")));

const ELIGIBILITY_DATE = "2026-04-24";
const VIEWS = path.resolve(__dirname, "../views");

function view(res, file, vars = {}) {
  let html = fs.readFileSync(path.join(VIEWS, file), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    html = html.replaceAll(`{{${k}}}`, v);
  }
  res.send(html);
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  const eligible = getEligibleTenants(ELIGIBILITY_DATE);
  const batches  = listBatches();
  const pending  = getPendingReviews();

  const rows = eligible.map((t) =>
    `<tr>
      <td>${t.id}</td>
      <td>${t.first_name} ${t.last_name}</td>
      <td>${t.address1}${t.address2 ? ", " + t.address2 : ""}, ${t.city}, ${t.state} ${t.zip}</td>
      <td>${t.interval_days}d</td>
      <td>${t.last_ship_date || "<em>never</em>"}</td>
      <td>${t.days_since_shipment !== null ? t.days_since_shipment + "d ago" : "—"}</td>
    </tr>`
  ).join("");

  const batchRows = batches.map((b) =>
    `<tr>
      <td>${b.id}</td>
      <td>${b.exported_at}</td>
      <td>${b.row_count}</td>
      <td>${b.filename ? `<a href="/exports/${b.filename}">${b.filename}</a>` : "—"}</td>
    </tr>`
  ).join("");

  view(res, "dashboard.html", {
    ELIGIBILITY_DATE,
    ELIGIBLE_COUNT:  eligible.length,
    ELIGIBLE_ROWS:   rows || "<tr><td colspan='6'>No eligible tenants</td></tr>",
    BATCH_ROWS:      batchRows || "<tr><td colspan='4'>No exports yet</td></tr>",
    PENDING_COUNT:   pending.length,
  });
});

// ---------------------------------------------------------------------------
// API: eligibility
// ---------------------------------------------------------------------------

app.get("/api/eligible", (req, res) => {
  const asOf = req.query.as_of || ELIGIBILITY_DATE;
  res.json(getEligibleTenants(asOf));
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

app.post("/export", (req, res) => {
  const asOf = req.body.as_of || ELIGIBILITY_DATE;
  const result = runExport(asOf);
  if (result.rowCount === 0) {
    return res.redirect("/?msg=no_eligible");
  }
  res.redirect(`/?msg=exported&count=${result.rowCount}&file=${encodeURIComponent(result.filename)}`);
});

app.get("/exports/:filename", (req, res) => {
  const file = path.resolve(__dirname, "../exports", req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  res.download(file);
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

app.post("/import", upload.single("csv"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  try {
    const stats = runImport(req.file.path);
    fs.unlinkSync(req.file.path);
    res.redirect(
      `/review?msg=imported` +
      `&matched=${stats.matched}&unmatched=${stats.unmatched}` +
      `&dupes=${stats.duplicates}&invalid=${stats.invalid}`
    );
  } catch (err) {
    res.status(500).send(`Import failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Manual review UI
// ---------------------------------------------------------------------------

app.get("/review", (req, res) => {
  const pending = getPendingReviews();

  const banner = req.query.msg === "imported"
    ? `<div class="banner success">Import complete — matched: ${req.query.matched}, unmatched: ${req.query.unmatched}, duplicates: ${req.query.dupes}, invalid: ${req.query.invalid}</div>`
    : "";

  const cards = pending.map((p) => {
    const { candidates } = getTenantCandidates(p.id);
    const opts = candidates.map((t) =>
      `<option value="${t.id}">${t.first_name} ${t.last_name} — ${t.address1}, ${t.city}, ${t.state} ${t.zip}</option>`
    ).join("");

    return `
    <div class="card">
      <div class="card-header">
        <span class="badge">Pending #${p.id}</span>
        <span>${p.tracking_number}</span>
      </div>
      <div class="card-body">
        <div class="col">
          <h3>Unmatched Row</h3>
          <dl>
            <dt>Name</dt><dd>${p.raw_name}</dd>
            <dt>Address</dt><dd>${[p.address1, p.address2, p.city, p.state, p.zip].filter(Boolean).join(", ")}</dd>
            <dt>Ship Date</dt><dd>${p.ship_date || "—"}</dd>
            <dt>Filter Sizes</dt><dd>${p.raw_custom_field_1 || "—"}</dd>
          </dl>
        </div>
        <div class="col">
          <h3>Confirm Match</h3>
          <form method="POST" action="/review/${p.id}/match">
            <select name="tenant_id">
              <option value="">— select a tenant —</option>
              ${opts}
            </select>
            <div class="actions">
              <button type="submit" class="btn-primary">Confirm Match</button>
              <a href="/review/${p.id}/dismiss" class="btn-danger" onclick="return confirm('Dismiss this row?')">Dismiss</a>
            </div>
          </form>
        </div>
      </div>
    </div>`;
  }).join("");

  view(res, "review.html", {
    BANNER:        banner,
    PENDING_COUNT: pending.length,
    CARDS:         cards || "<p>No pending rows. All clear!</p>",
  });
});

app.post("/review/:id/match", (req, res) => {
  const pendingId  = parseInt(req.params.id, 10);
  const tenantId   = parseInt(req.body.tenant_id, 10);
  if (!tenantId) return res.redirect("/review?msg=no_tenant");
  try {
    resolveMatch(pendingId, tenantId);
    res.redirect("/review?msg=matched");
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.get("/review/:id/dismiss", (req, res) => {
  dismissPending(parseInt(req.params.id, 10));
  res.redirect("/review?msg=dismissed");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Air Filter Shipment System running at http://localhost:${PORT}`);
  console.log(`Eligibility date: ${ELIGIBILITY_DATE}`);
});
