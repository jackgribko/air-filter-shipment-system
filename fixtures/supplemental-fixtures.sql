CREATE TABLE IF NOT EXISTS historical_shipments (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  recipient_name TEXT NOT NULL,
  address1 TEXT NOT NULL,
  address2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  ship_date TEXT NOT NULL,
  tracking_number TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  notes TEXT
);

INSERT OR REPLACE INTO tenants
  (id, first_name, last_name, address1, address2, city, state, zip)
VALUES
  (900001, 'Casey', 'Morgan', '1188 Maple Loop', 'Apt. 4B', 'Springfield', 'IL', '62704'),
  (900002, 'Casey', 'Morgan', '1188 Maple Loop', 'Apt. 4B', 'Springfield', 'IL', '62704');

INSERT OR REPLACE INTO enrollments
  (id, active, tenant_id, product, riders)
VALUES
  (900101, 0, 900001, 'Renters Kit', '{Airfilters Delivery ($4)}'),
  (900102, 1, 900002, 'Renters Kit', '{Airfilters Delivery ($4)}');

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 1, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278118642', 'shipstation_import', NULL
FROM tenants WHERE id = 145581;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 2, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278172667', 'shipstation_import', NULL
FROM tenants WHERE id = 145306;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 3, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278172740', 'shipstation_import', NULL
FROM tenants WHERE id = 135466;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
VALUES
  (4, 135452, 'German Gerhold', '999 Former Willow Drive', 'Apt. 8', 'Elyseshire', 'AZ', '62006-6690', '2026-02-24', 'se-244405678', 'legacy_import', NULL);

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 5, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2025-12-15', 'se-216900005', 'manual_seed', NULL
FROM tenants WHERE id = 135437;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 6, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-01-10', 'se-216900006', 'manual_seed', NULL
FROM tenants WHERE id = 135438;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 7, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-30', 'se-269400007', 'shipstation_import', NULL
FROM tenants WHERE id = 135439;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 8, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-30', 'se-269400008', 'shipstation_import', NULL
FROM tenants WHERE id = 135440;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 9, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-01-15', 'se-216900009', 'manual_seed', NULL
FROM tenants WHERE id = 135441;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 10, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-09', 'se-278100010', 'manual_seed', NULL
FROM tenants WHERE id = 135443;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 11, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-02-01', 'se-230100011', 'manual_seed', NULL
FROM tenants WHERE id = 135444;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 12, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2025-10-15', 'se-190100012', 'manual_seed', NULL
FROM tenants WHERE id = 135445;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 13, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-05', 'se-278100013', 'shipstation_import', NULL
FROM tenants WHERE id = 135446;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 14, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-05-15', 'se-290100014', 'scheduled_order', NULL
FROM tenants WHERE id = 135448;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 15, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-15', 'se-260100015', 'manual_seed', NULL
FROM tenants WHERE id = 135449;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 16, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-01-05', 'se-216900016', 'manual_seed', NULL
FROM tenants WHERE id = 135450;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 17, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-30', 'se-269400017', 'shipstation_import', NULL
FROM tenants WHERE id = 135451;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 18, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-02-15', 'se-240100018', 'manual_seed', NULL
FROM tenants WHERE id = 135453;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 19, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278100019', 'shipstation_import', NULL
FROM tenants WHERE id = 135455;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 20, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2025-12-01', 'se-210100020', 'manual_seed', NULL
FROM tenants WHERE id = 135456;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 21, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-01', 'se-278100021', 'shipstation_import', NULL
FROM tenants WHERE id = 135457;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 22, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-30', 'se-269400022', 'shipstation_import', NULL
FROM tenants WHERE id = 135458;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 23, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-01-15', 'se-216900023', 'manual_seed', NULL
FROM tenants WHERE id = 135459;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 24, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278100024', 'shipstation_import', NULL
FROM tenants WHERE id = 135460;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 25, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2025-11-20', 'se-200100025', 'manual_seed', NULL
FROM tenants WHERE id = 135461;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 26, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278100026', 'shipstation_import', NULL
FROM tenants WHERE id = 135462;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 27, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-02-24', 'se-244400027', 'shipstation_import', NULL
FROM tenants WHERE id = 135463;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 28, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-03-30', 'se-269400028', 'shipstation_import', NULL
FROM tenants WHERE id = 135464;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 29, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-01-15', 'se-216900029', 'manual_seed', NULL
FROM tenants WHERE id = 135465;

INSERT OR REPLACE INTO historical_shipments
  (id, tenant_id, recipient_name, address1, address2, city, state, zip, ship_date, tracking_number, source, notes)
SELECT 30, id, first_name || ' ' || last_name, address1, address2, city, state, zip, '2026-04-10', 'se-278100030', 'shipstation_import', NULL
FROM tenants WHERE id = 136022;
