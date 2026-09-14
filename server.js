"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL.");
  process.exit(1);
}

const useSSL = !/localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      plate TEXT NOT NULL,
      current_mileage NUMERIC(10,1) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('own','company')),
      vehicle TEXT DEFAULT '',
      weekly_rest_day INTEGER,
      extra_rest_dates JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Vehicle assignment (added after initial launch) — kept as ALTERs so existing
  // production data is never touched, only extended.
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_id TEXT REFERENCES vehicles(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_assigned_mileage NUMERIC(10,1);`);
  await pool.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_assigned_date DATE;`);
  // Vehicle photo (added after initial launch) — stored as a data URL (base64),
  // already resized/compressed client-side before upload, so no external file
  // storage service is needed.
  await pool.query(`ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS photo TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS charges (
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      date DATE NOT NULL,
      time TIME NOT NULL,
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Conciliación semanal (added after initial launch) — marca qué cargas ya
  // se registraron en el sistema de contabilidad de la empresa.
  await pool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS reconciled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE charges ADD COLUMN IF NOT EXISTS reconciled_by TEXT DEFAULT '';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS charge_history (
      id SERIAL PRIMARY KEY,
      charge_id TEXT NOT NULL REFERENCES charges(id) ON DELETE CASCADE,
      edited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      edited_by TEXT DEFAULT '',
      before_amount NUMERIC(12,2),
      before_date DATE,
      before_time TIME,
      before_note TEXT,
      after_amount NUMERIC(12,2),
      after_date DATE,
      after_time TIME,
      after_note TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_charges_driver ON charges(driver_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_charges_date ON charges(date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_history_charge ON charge_history(charge_id);`);
}

const app = express();
// Raised from Express's 100kb default so a compressed vehicle photo (a data
// URL, sent inline as JSON) fits comfortably.
app.use(express.json({ limit: "8mb" }));

// Serve the frontend regardless of whether index.html ended up in /public
// (correct layout) or at the repo root (can happen with GitHub's web upload).
const publicDir = path.join(__dirname, "public");
const publicIndexPath = path.join(publicDir, "index.html");
const rootIndexPath = path.join(__dirname, "index.html");

if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get("/", (req, res) => {
  if (fs.existsSync(publicIndexPath)) return res.sendFile(publicIndexPath);
  if (fs.existsSync(rootIndexPath)) return res.sendFile(rootIndexPath);
  res.status(404).send("No se encontró index.html. Verifica que el archivo esté en el repositorio.");
});

function uid(prefix) {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function rowToDriver(r) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone || "",
    type: r.type,
    vehicle: r.vehicle || "",
    weeklyRestDay: r.weekly_rest_day === null || r.weekly_rest_day === undefined ? null : Number(r.weekly_rest_day),
    extraRestDates: r.extra_rest_dates || [],
    vehicleId: r.vehicle_id || null,
    vehicleAssignedMileage: r.vehicle_assigned_mileage === null || r.vehicle_assigned_mileage === undefined ? null : Number(r.vehicle_assigned_mileage),
    vehicleAssignedDate: r.vehicle_assigned_date ? toDateStr(r.vehicle_assigned_date) : null,
  };
}

function rowToVehicle(r) {
  return {
    id: r.id,
    brand: r.brand,
    model: r.model,
    year: r.year === null || r.year === undefined ? null : Number(r.year),
    plate: r.plate,
    currentMileage: Number(r.current_mileage),
    photo: r.photo || null,
    createdAt: r.created_at,
  };
}

function rowToCharge(r) {
  return {
    id: r.id,
    driverId: r.driver_id,
    amount: Number(r.amount),
    date: toDateStr(r.date),
    time: toTimeStr(r.time),
    note: r.note || "",
    createdBy: r.created_by || "",
    createdAt: r.created_at,
    reconciled: !!r.reconciled,
    reconciledAt: r.reconciled_at || null,
    reconciledBy: r.reconciled_by || "",
  };
}

function toDateStr(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}
function toTimeStr(t) {
  if (!t) return "";
  return String(t).slice(0, 5);
}

// ---------- Vehicles (Autos) ----------
app.get("/api/vehicles", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM vehicles ORDER BY created_at ASC");
  res.json(rows.map(rowToVehicle));
});

function validatePhoto(photo) {
  if (photo === null || photo === undefined || photo === "") return { ok: true, value: null };
  if (typeof photo !== "string" || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) {
    return { ok: false };
  }
  if (photo.length > 6 * 1024 * 1024) return { ok: false }; // ~6MB of base64 text is already very generous for a compressed photo
  return { ok: true, value: photo };
}

app.post("/api/vehicles", async (req, res) => {
  const b = req.body || {};
  if (!b.brand || !String(b.brand).trim()) return res.status(400).json({ error: "La marca es obligatoria." });
  if (!b.model || !String(b.model).trim()) return res.status(400).json({ error: "El modelo es obligatorio." });
  if (!b.plate || !String(b.plate).trim()) return res.status(400).json({ error: "El número de placa es obligatorio." });
  const year = b.year === null || b.year === undefined || b.year === "" ? null : Number(b.year);
  const currentMileage = b.currentMileage === null || b.currentMileage === undefined || b.currentMileage === "" ? 0 : Number(b.currentMileage);
  if (isNaN(currentMileage) || currentMileage < 0) return res.status(400).json({ error: "Las millas actuales no son válidas." });
  const photoCheck = validatePhoto(b.photo);
  if (!photoCheck.ok) return res.status(400).json({ error: "La foto no es válida. Usa JPG, PNG o WEBP." });
  const id = uid("veh");
  await pool.query(
    `INSERT INTO vehicles (id, brand, model, year, plate, current_mileage, photo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, String(b.brand).trim(), String(b.model).trim(), year, String(b.plate).trim(), currentMileage, photoCheck.value]
  );
  const { rows } = await pool.query("SELECT * FROM vehicles WHERE id=$1", [id]);
  res.status(201).json(rowToVehicle(rows[0]));
});

app.put("/api/vehicles/:id", async (req, res) => {
  const b = req.body || {};
  const { rows: existing } = await pool.query("SELECT * FROM vehicles WHERE id=$1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Auto no encontrado." });
  const year = b.year === null || b.year === undefined || b.year === "" ? null : Number(b.year);
  const currentMileage = b.currentMileage === null || b.currentMileage === undefined || b.currentMileage === ""
    ? Number(existing[0].current_mileage) : Number(b.currentMileage);
  if (isNaN(currentMileage) || currentMileage < 0) return res.status(400).json({ error: "Las millas actuales no son válidas." });
  const photoCheck = validatePhoto(b.photo !== undefined ? b.photo : existing[0].photo);
  if (!photoCheck.ok) return res.status(400).json({ error: "La foto no es válida. Usa JPG, PNG o WEBP." });
  await pool.query(
    `UPDATE vehicles SET brand=$1, model=$2, year=$3, plate=$4, current_mileage=$5, photo=$6 WHERE id=$7`,
    [b.brand || existing[0].brand, b.model || existing[0].model, year, b.plate || existing[0].plate, currentMileage, photoCheck.value, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM vehicles WHERE id=$1", [req.params.id]);
  res.json(rowToVehicle(rows[0]));
});

app.delete("/api/vehicles/:id", async (req, res) => {
  await pool.query("DELETE FROM vehicles WHERE id=$1", [req.params.id]);
  res.status(204).end();
});

// ---------- Drivers ----------
app.get("/api/drivers", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM drivers ORDER BY created_at ASC");
  res.json(rows.map(rowToDriver));
});

app.post("/api/drivers", async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (b.type !== "own" && b.type !== "company") return res.status(400).json({ error: "Tipo de conductor inválido." });
  const vehicleId = b.vehicleId || null;
  if (vehicleId) {
    const { rows: vRows } = await pool.query("SELECT id FROM vehicles WHERE id=$1", [vehicleId]);
    if (!vRows.length) return res.status(400).json({ error: "El auto seleccionado no existe." });
  }
  const vehicleAssignedMileage = vehicleId && b.vehicleAssignedMileage !== undefined && b.vehicleAssignedMileage !== null && b.vehicleAssignedMileage !== ""
    ? Number(b.vehicleAssignedMileage) : null;
  const vehicleAssignedDate = vehicleId && b.vehicleAssignedDate ? b.vehicleAssignedDate : null;
  const id = uid("drv");
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  await pool.query(
    `INSERT INTO drivers (id, name, phone, type, vehicle, weekly_rest_day, extra_rest_dates, vehicle_id, vehicle_assigned_mileage, vehicle_assigned_date)
     VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,$7,$8,$9)`,
    [id, String(b.name).trim(), b.phone || "", b.type, b.vehicle || "", weeklyRestDay, vehicleId, vehicleAssignedMileage, vehicleAssignedDate]
  );
  const { rows } = await pool.query("SELECT * FROM drivers WHERE id=$1", [id]);
  res.status(201).json(rowToDriver(rows[0]));
});

app.put("/api/drivers/:id", async (req, res) => {
  const b = req.body || {};
  const { rows: existing } = await pool.query("SELECT * FROM drivers WHERE id=$1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Conductor no encontrado." });
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  const vehicleId = b.vehicleId !== undefined ? (b.vehicleId || null) : existing[0].vehicle_id;
  if (vehicleId) {
    const { rows: vRows } = await pool.query("SELECT id FROM vehicles WHERE id=$1", [vehicleId]);
    if (!vRows.length) return res.status(400).json({ error: "El auto seleccionado no existe." });
  }
  const vehicleAssignedMileage = !vehicleId
    ? null
    : b.vehicleAssignedMileage !== undefined
      ? (b.vehicleAssignedMileage === null || b.vehicleAssignedMileage === "" ? null : Number(b.vehicleAssignedMileage))
      : existing[0].vehicle_assigned_mileage;
  const vehicleAssignedDate = !vehicleId
    ? null
    : b.vehicleAssignedDate !== undefined
      ? (b.vehicleAssignedDate || null)
      : existing[0].vehicle_assigned_date;
  await pool.query(
    `UPDATE drivers SET name=$1, phone=$2, type=$3, vehicle=$4, weekly_rest_day=$5, vehicle_id=$6, vehicle_assigned_mileage=$7, vehicle_assigned_date=$8 WHERE id=$9`,
    [b.name || existing[0].name, b.phone || "", b.type || existing[0].type, b.vehicle || "", weeklyRestDay, vehicleId, vehicleAssignedMileage, vehicleAssignedDate, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM drivers WHERE id=$1", [req.params.id]);
  res.json(rowToDriver(rows[0]));
});

app.delete("/api/drivers/:id", async (req, res) => {
  await pool.query("DELETE FROM drivers WHERE id=$1", [req.params.id]);
  res.status(204).end();
});

app.post("/api/drivers/:id/rest-dates", async (req, res) => {
  const date = (req.body || {}).date;
  if (!date) return res.status(400).json({ error: "Falta la fecha." });
  const { rows } = await pool.query("SELECT extra_rest_dates FROM drivers WHERE id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Conductor no encontrado." });
  const list = rows[0].extra_rest_dates || [];
  if (list.indexOf(date) === -1) list.push(date);
  await pool.query("UPDATE drivers SET extra_rest_dates=$1::jsonb WHERE id=$2", [JSON.stringify(list), req.params.id]);
  res.json({ extraRestDates: list });
});

app.delete("/api/drivers/:id/rest-dates/:date", async (req, res) => {
  const { rows } = await pool.query("SELECT extra_rest_dates FROM drivers WHERE id=$1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Conductor no encontrado." });
  const list = (rows[0].extra_rest_dates || []).filter((d) => d !== req.params.date);
  await pool.query("UPDATE drivers SET extra_rest_dates=$1::jsonb WHERE id=$2", [JSON.stringify(list), req.params.id]);
  res.json({ extraRestDates: list });
});

// ---------- Charges ----------
app.get("/api/charges", async (req, res) => {
  const driverId = req.query.driverId;
  const { rows } = driverId
    ? await pool.query("SELECT * FROM charges WHERE driver_id=$1 ORDER BY date DESC, time DESC", [driverId])
    : await pool.query("SELECT * FROM charges ORDER BY date DESC, time DESC");
  res.json(rows.map(rowToCharge));
});

app.post("/api/charges", async (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!b.driverId || isNaN(amount) || amount <= 0 || !b.date || !b.time) {
    return res.status(400).json({ error: "Completa conductor, monto, fecha y hora." });
  }
  const { rows: driverRows } = await pool.query("SELECT type FROM drivers WHERE id=$1", [b.driverId]);
  if (!driverRows.length) return res.status(404).json({ error: "Conductor no encontrado." });
  if (driverRows[0].type !== "company") return res.status(400).json({ error: "Solo se pueden registrar cargas a conductores con auto de la empresa." });
  const id = uid("chg");
  await pool.query(
    `INSERT INTO charges (id, driver_id, amount, date, time, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, b.driverId, amount, b.date, b.time, b.note || "", b.actor || ""]
  );
  const { rows } = await pool.query("SELECT * FROM charges WHERE id=$1", [id]);
  res.status(201).json(rowToCharge(rows[0]));
});

app.put("/api/charges/:id", async (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (isNaN(amount) || amount <= 0 || !b.date || !b.time) {
    return res.status(400).json({ error: "Revisa el monto, fecha y hora." });
  }
  const { rows: existingRows } = await pool.query("SELECT * FROM charges WHERE id=$1", [req.params.id]);
  if (!existingRows.length) return res.status(404).json({ error: "Carga no encontrada." });
  const before = existingRows[0];
  const beforeAmount = Number(before.amount);
  const beforeDate = toDateStr(before.date);
  const beforeTime = toTimeStr(before.time);
  const beforeNote = before.note || "";
  const note = b.note || "";
  const changed = beforeAmount !== amount || beforeDate !== b.date || beforeTime !== b.time || beforeNote !== note;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (changed) {
      await client.query(
        `INSERT INTO charge_history (charge_id, edited_by, before_amount, before_date, before_time, before_note, after_amount, after_date, after_time, after_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [req.params.id, b.actor || "", beforeAmount, beforeDate, beforeTime, beforeNote, amount, b.date, b.time, note]
      );
    }
    await client.query(`UPDATE charges SET amount=$1, date=$2, time=$3, note=$4 WHERE id=$5`, [amount, b.date, b.time, note, req.params.id]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query("SELECT * FROM charges WHERE id=$1", [req.params.id]);
  res.json(rowToCharge(rows[0]));
});

app.delete("/api/charges/:id", async (req, res) => {
  await pool.query("DELETE FROM charges WHERE id=$1", [req.params.id]);
  res.status(204).end();
});

app.put("/api/charges/:id/reconcile", async (req, res) => {
  const b = req.body || {};
  const reconciled = !!b.reconciled;
  const { rows: existing } = await pool.query("SELECT id FROM charges WHERE id=$1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Carga no encontrada." });
  await pool.query(
    `UPDATE charges SET reconciled=$1, reconciled_at=$2, reconciled_by=$3 WHERE id=$4`,
    [reconciled, reconciled ? new Date() : null, reconciled ? (b.actor || "") : "", req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM charges WHERE id=$1", [req.params.id]);
  res.json(rowToCharge(rows[0]));
});

// Conciliación masiva: recibe una lista de {id, reconciled} (por ejemplo,
// leída de un Excel exportado/editado/reimportado) y actualiza cada carga.
app.post("/api/charges/reconcile-bulk", async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: "No se enviaron cargas para conciliar." });
  const actor = b.actor || "";
  const results = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id) {
      results.push({ id: item && item.id, ok: false, error: "ID inválido" });
      continue;
    }
    const reconciled = !!item.reconciled;
    const { rows: existing } = await pool.query("SELECT id FROM charges WHERE id=$1", [item.id]);
    if (!existing.length) {
      results.push({ id: item.id, ok: false, error: "Carga no encontrada" });
      continue;
    }
    await pool.query(
      `UPDATE charges SET reconciled=$1, reconciled_at=$2, reconciled_by=$3 WHERE id=$4`,
      [reconciled, reconciled ? new Date() : null, reconciled ? actor : "", item.id]
    );
    results.push({ id: item.id, ok: true });
  }
  const okIds = results.filter((r) => r.ok).map((r) => r.id);
  let charges = [];
  if (okIds.length) {
    const { rows } = await pool.query("SELECT * FROM charges WHERE id = ANY($1::text[])", [okIds]);
    charges = rows.map(rowToCharge);
  }
  res.json({ updated: results, charges });
});

// ---------- History ----------
app.get("/api/history", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT h.*, c.driver_id AS driver_id
    FROM charge_history h
    JOIN charges c ON c.id = h.charge_id
    ORDER BY h.edited_at DESC
    LIMIT 500
  `);
  res.json(
    rows.map((r) => ({
      editedAt: r.edited_at,
      editedBy: r.edited_by || "",
      driverId: r.driver_id,
      chargeId: r.charge_id,
      before: { amount: Number(r.before_amount), date: toDateStr(r.before_date), time: toTimeStr(r.before_time), note: r.before_note || "" },
      after: { amount: Number(r.after_amount), date: toDateStr(r.after_date), time: toTimeStr(r.after_time), note: r.after_note || "" },
    }))
  );
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

migrate()
  .then(() => {
    app.listen(PORT, () => console.log("Control de Flotilla escuchando en el puerto " + PORT));
  })
  .catch((err) => {
    console.error("Error al migrar la base de datos:", err);
    process.exit(1);
  });
