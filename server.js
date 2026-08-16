"use strict";

const express = require("express");
const path = require("path");
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
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

// ---------- Drivers ----------
app.get("/api/drivers", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM drivers ORDER BY created_at ASC");
  res.json(rows.map(rowToDriver));
});

app.post("/api/drivers", async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (b.type !== "own" && b.type !== "company") return res.status(400).json({ error: "Tipo de conductor inválido." });
  const id = uid("drv");
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  await pool.query(
    `INSERT INTO drivers (id, name, phone, type, vehicle, weekly_rest_day, extra_rest_dates) VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb)`,
    [id, String(b.name).trim(), b.phone || "", b.type, b.vehicle || "", weeklyRestDay]
  );
  const { rows } = await pool.query("SELECT * FROM drivers WHERE id=$1", [id]);
  res.status(201).json(rowToDriver(rows[0]));
});

app.put("/api/drivers/:id", async (req, res) => {
  const b = req.body || {};
  const { rows: existing } = await pool.query("SELECT * FROM drivers WHERE id=$1", [req.params.id]);
  if (!existing.length) return res.status(404).json({ error: "Conductor no encontrado." });
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  await pool.query(
    `UPDATE drivers SET name=$1, phone=$2, type=$3, vehicle=$4, weekly_rest_day=$5 WHERE id=$6`,
    [b.name || existing[0].name, b.phone || "", b.type || existing[0].type, b.vehicle || "", weeklyRestDay, req.params.id]
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
