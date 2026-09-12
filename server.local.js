"use strict";
/*
 * Control de Flotilla — servidor LOCAL de pruebas.
 * Igual que server.js (misma API que usa el frontend), pero en vez de
 * conectarse a Postgres, guarda todo en un archivo JSON en esta misma
 * carpeta (local-data.json). No necesita internet ni una base de datos
 * instalada. Ideal para probar cambios sin tocar los datos reales.
 *
 * Para correrlo:  npm run local
 * Luego abre:      http://localhost:3000
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "local-data.json");

function emptyData() {
  return { drivers: [], charges: [], history: [], vehicles: [] };
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return emptyData();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const charges = (Array.isArray(parsed.charges) ? parsed.charges : []).map((c) => ({
      reconciled: false,
      reconciledAt: null,
      reconciledBy: "",
      ...c,
    }));
    return {
      drivers: Array.isArray(parsed.drivers) ? parsed.drivers : [],
      charges: charges,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : [],
    };
  } catch (e) {
    console.error("No se pudo leer local-data.json, empezando de cero.", e.message);
    return emptyData();
  }
}

let data = loadData();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function uid(prefix) {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

const app = express();
// Raised from Express's 100kb default so a compressed vehicle photo (a data
// URL, sent inline as JSON) fits comfortably — matches server.js.
app.use(express.json({ limit: "8mb" }));

// Servir el frontend, sin importar si index.html quedó en /public o en la raíz.
const publicDir = path.join(__dirname, "public");
const publicIndexPath = path.join(publicDir, "index.html");
const rootIndexPath = path.join(__dirname, "index.html");

if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

app.get("/", (req, res) => {
  if (fs.existsSync(publicIndexPath)) return res.sendFile(publicIndexPath);
  if (fs.existsSync(rootIndexPath)) return res.sendFile(rootIndexPath);
  res.status(404).send("No se encontró index.html.");
});

// ---------- Autos ----------
app.get("/api/vehicles", (req, res) => {
  res.json(data.vehicles);
});

function validatePhoto(photo) {
  if (photo === null || photo === undefined || photo === "") return { ok: true, value: null };
  if (typeof photo !== "string" || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) {
    return { ok: false };
  }
  if (photo.length > 6 * 1024 * 1024) return { ok: false };
  return { ok: true, value: photo };
}

app.post("/api/vehicles", (req, res) => {
  const b = req.body || {};
  if (!b.brand || !String(b.brand).trim()) return res.status(400).json({ error: "La marca es obligatoria." });
  if (!b.model || !String(b.model).trim()) return res.status(400).json({ error: "El modelo es obligatorio." });
  if (!b.plate || !String(b.plate).trim()) return res.status(400).json({ error: "El número de placa es obligatorio." });
  const currentMileage = b.currentMileage === null || b.currentMileage === undefined || b.currentMileage === "" ? 0 : Number(b.currentMileage);
  if (isNaN(currentMileage) || currentMileage < 0) return res.status(400).json({ error: "Las millas actuales no son válidas." });
  const photoCheck = validatePhoto(b.photo);
  if (!photoCheck.ok) return res.status(400).json({ error: "La foto no es válida. Usa JPG, PNG o WEBP." });
  const vehicle = {
    id: uid("veh"),
    brand: String(b.brand).trim(),
    model: String(b.model).trim(),
    year: b.year === null || b.year === undefined || b.year === "" ? null : Number(b.year),
    plate: String(b.plate).trim(),
    currentMileage,
    photo: photoCheck.value,
    createdAt: new Date().toISOString(),
  };
  data.vehicles.push(vehicle);
  save();
  res.status(201).json(vehicle);
});

app.put("/api/vehicles/:id", (req, res) => {
  const b = req.body || {};
  const vehicle = data.vehicles.find((v) => v.id === req.params.id);
  if (!vehicle) return res.status(404).json({ error: "Auto no encontrado." });
  const currentMileage = b.currentMileage === null || b.currentMileage === undefined || b.currentMileage === "" ? vehicle.currentMileage : Number(b.currentMileage);
  if (isNaN(currentMileage) || currentMileage < 0) return res.status(400).json({ error: "Las millas actuales no son válidas." });
  const photoCheck = validatePhoto(b.photo !== undefined ? b.photo : vehicle.photo);
  if (!photoCheck.ok) return res.status(400).json({ error: "La foto no es válida. Usa JPG, PNG o WEBP." });
  vehicle.brand = b.brand || vehicle.brand;
  vehicle.model = b.model || vehicle.model;
  vehicle.year = b.year === null || b.year === undefined || b.year === "" ? null : Number(b.year);
  vehicle.plate = b.plate || vehicle.plate;
  vehicle.currentMileage = currentMileage;
  vehicle.photo = photoCheck.value;
  save();
  res.json(vehicle);
});

app.delete("/api/vehicles/:id", (req, res) => {
  data.vehicles = data.vehicles.filter((v) => v.id !== req.params.id);
  // Same as production: ON DELETE SET NULL — a driver's assignment clears rather than breaking.
  data.drivers.forEach((d) => {
    if (d.vehicleId === req.params.id) {
      d.vehicleId = null;
      d.vehicleAssignedMileage = null;
      d.vehicleAssignedDate = null;
    }
  });
  save();
  res.status(204).end();
});

// ---------- Conductores ----------
app.get("/api/drivers", (req, res) => {
  res.json(data.drivers);
});

app.post("/api/drivers", (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (b.type !== "own" && b.type !== "company") return res.status(400).json({ error: "Tipo de conductor inválido." });
  const vehicleId = b.vehicleId || null;
  if (vehicleId && !data.vehicles.find((v) => v.id === vehicleId)) {
    return res.status(400).json({ error: "El auto seleccionado no existe." });
  }
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  const driver = {
    id: uid("drv"),
    name: String(b.name).trim(),
    phone: b.phone || "",
    type: b.type,
    vehicle: b.vehicle || "",
    weeklyRestDay,
    extraRestDates: [],
    vehicleId,
    vehicleAssignedMileage: vehicleId && b.vehicleAssignedMileage !== undefined && b.vehicleAssignedMileage !== null && b.vehicleAssignedMileage !== "" ? Number(b.vehicleAssignedMileage) : null,
    vehicleAssignedDate: vehicleId && b.vehicleAssignedDate ? b.vehicleAssignedDate : null,
  };
  data.drivers.push(driver);
  save();
  res.status(201).json(driver);
});

app.put("/api/drivers/:id", (req, res) => {
  const b = req.body || {};
  const driver = data.drivers.find((d) => d.id === req.params.id);
  if (!driver) return res.status(404).json({ error: "Conductor no encontrado." });
  const weeklyRestDay = b.weeklyRestDay === null || b.weeklyRestDay === undefined || b.weeklyRestDay === "" ? null : Number(b.weeklyRestDay);
  const vehicleId = b.vehicleId !== undefined ? (b.vehicleId || null) : driver.vehicleId || null;
  if (vehicleId && !data.vehicles.find((v) => v.id === vehicleId)) {
    return res.status(400).json({ error: "El auto seleccionado no existe." });
  }
  driver.name = b.name || driver.name;
  driver.phone = b.phone || "";
  driver.type = b.type || driver.type;
  driver.vehicle = b.vehicle || "";
  driver.weeklyRestDay = weeklyRestDay;
  driver.vehicleId = vehicleId;
  driver.vehicleAssignedMileage = !vehicleId
    ? null
    : b.vehicleAssignedMileage !== undefined
      ? (b.vehicleAssignedMileage === null || b.vehicleAssignedMileage === "" ? null : Number(b.vehicleAssignedMileage))
      : driver.vehicleAssignedMileage || null;
  driver.vehicleAssignedDate = !vehicleId
    ? null
    : b.vehicleAssignedDate !== undefined
      ? (b.vehicleAssignedDate || null)
      : driver.vehicleAssignedDate || null;
  save();
  res.json(driver);
});

app.delete("/api/drivers/:id", (req, res) => {
  const removedChargeIds = data.charges.filter((c) => c.driverId === req.params.id).map((c) => c.id);
  data.drivers = data.drivers.filter((d) => d.id !== req.params.id);
  data.charges = data.charges.filter((c) => c.driverId !== req.params.id);
  data.history = data.history.filter((h) => removedChargeIds.indexOf(h.chargeId) === -1);
  save();
  res.status(204).end();
});

app.post("/api/drivers/:id/rest-dates", (req, res) => {
  const date = (req.body || {}).date;
  if (!date) return res.status(400).json({ error: "Falta la fecha." });
  const driver = data.drivers.find((d) => d.id === req.params.id);
  if (!driver) return res.status(404).json({ error: "Conductor no encontrado." });
  if (driver.extraRestDates.indexOf(date) === -1) driver.extraRestDates.push(date);
  save();
  res.json({ extraRestDates: driver.extraRestDates });
});

app.delete("/api/drivers/:id/rest-dates/:date", (req, res) => {
  const driver = data.drivers.find((d) => d.id === req.params.id);
  if (!driver) return res.status(404).json({ error: "Conductor no encontrado." });
  driver.extraRestDates = driver.extraRestDates.filter((d) => d !== req.params.date);
  save();
  res.json({ extraRestDates: driver.extraRestDates });
});

// ---------- Cargas ----------
app.get("/api/charges", (req, res) => {
  const driverId = req.query.driverId;
  let list = driverId ? data.charges.filter((c) => c.driverId === driverId) : data.charges.slice();
  list = list.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  res.json(list);
});

app.post("/api/charges", (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (!b.driverId || isNaN(amount) || amount <= 0 || !b.date || !b.time) {
    return res.status(400).json({ error: "Completa conductor, monto, fecha y hora." });
  }
  const driver = data.drivers.find((d) => d.id === b.driverId);
  if (!driver) return res.status(404).json({ error: "Conductor no encontrado." });
  if (driver.type !== "company") return res.status(400).json({ error: "Solo se pueden registrar cargas a conductores con auto de la empresa." });
  const charge = {
    id: uid("chg"),
    driverId: b.driverId,
    amount,
    date: b.date,
    time: b.time,
    note: b.note || "",
    createdBy: b.actor || "",
    createdAt: new Date().toISOString(),
    reconciled: false,
    reconciledAt: null,
    reconciledBy: "",
  };
  data.charges.push(charge);
  save();
  res.status(201).json(charge);
});

app.put("/api/charges/:id", (req, res) => {
  const b = req.body || {};
  const amount = parseFloat(b.amount);
  if (isNaN(amount) || amount <= 0 || !b.date || !b.time) {
    return res.status(400).json({ error: "Revisa el monto, fecha y hora." });
  }
  const charge = data.charges.find((c) => c.id === req.params.id);
  if (!charge) return res.status(404).json({ error: "Carga no encontrada." });
  const note = b.note || "";
  const changed = charge.amount !== amount || charge.date !== b.date || charge.time !== b.time || charge.note !== note;
  if (changed) {
    data.history.push({
      editedAt: new Date().toISOString(),
      editedBy: b.actor || "",
      driverId: charge.driverId,
      chargeId: charge.id,
      before: { amount: charge.amount, date: charge.date, time: charge.time, note: charge.note },
      after: { amount, date: b.date, time: b.time, note },
    });
  }
  charge.amount = amount;
  charge.date = b.date;
  charge.time = b.time;
  charge.note = note;
  save();
  res.json(charge);
});

app.delete("/api/charges/:id", (req, res) => {
  data.charges = data.charges.filter((c) => c.id !== req.params.id);
  data.history = data.history.filter((h) => h.chargeId !== req.params.id);
  save();
  res.status(204).end();
});

app.put("/api/charges/:id/reconcile", (req, res) => {
  const b = req.body || {};
  const reconciled = !!b.reconciled;
  const charge = data.charges.find((c) => c.id === req.params.id);
  if (!charge) return res.status(404).json({ error: "Carga no encontrada." });
  charge.reconciled = reconciled;
  charge.reconciledAt = reconciled ? new Date().toISOString() : null;
  charge.reconciledBy = reconciled ? (b.actor || "") : "";
  save();
  res.json(charge);
});

// ---------- Historial ----------
app.get("/api/history", (req, res) => {
  const list = data.history
    .slice()
    .sort((a, b) => (b.editedAt || "").localeCompare(a.editedAt || ""))
    .slice(0, 500);
  res.json(list);
});

app.get("/api/health", (req, res) => res.json({ ok: true, mode: "local" }));

app.listen(PORT, () => {
  console.log("Control de Flotilla (MODO LOCAL) escuchando en el puerto " + PORT);
  console.log("Tus datos de prueba se guardan en: " + DATA_FILE);
  console.log("Abre http://localhost:" + PORT + " en tu navegador.");
});
