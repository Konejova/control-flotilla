"use strict";
/*
 * Copia una foto (snapshot) de los datos de PRODUCCIÓN hacia tu archivo
 * local-data.json, para que puedas probar cambios con datos reales sin
 * tocar la base de datos real ni afectar a los usuarios de producción.
 *
 * Qué hace:
 *   1. Descarga conductores, autos, cargas e historial desde
 *      https://control-flotilla.onrender.com (tu app en producción).
 *   2. Guarda una copia de seguridad de tu local-data.json actual
 *      (por si ya tenías datos de prueba que quieras conservar).
 *   3. Sobrescribe local-data.json con los datos de producción.
 *
 * Esto es una FOTO de un momento — no queda conectado a producción ni se
 * actualiza solo. Puedes volver a correr este script cuando quieras
 * refrescar tus datos locales con lo último de producción.
 *
 * Para correrlo:  node copiar-produccion-a-local.js
 * (o haz doble clic en copiar-produccion.bat)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://control-flotilla.onrender.com";
const DATA_FILE = path.join(__dirname, "local-data.json");

function getJson(url, opts, attempt) {
  opts = opts || {};
  attempt = attempt || 1;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 90000 }, (res) => {
      if (res.statusCode === 404 && opts.allowMissing) {
        res.resume();
        console.log("  (" + url + " no existe todavía en producción — probablemente aún no publicas/despliegas esa parte. Se deja vacío.)");
        return resolve([]);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode + " al pedir " + url));
      }
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Respuesta inválida de " + url + ": " + e.message));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tiempo de espera agotado pidiendo " + url)));
    req.on("error", (err) => {
      // El servicio gratuito de Render "duerme" tras 15 min sin uso y tarda
      // ~1 minuto en despertar. Reintenta una vez más antes de rendirte.
      if (attempt < 2) {
        console.log("  Sin respuesta todavía (el servidor puede estar despertando). Reintentando en 15s...");
        setTimeout(() => getJson(url, opts, attempt + 1).then(resolve, reject), 15000);
      } else {
        reject(err);
      }
    });
  });
}

async function main() {
  console.log("============================================");
  console.log("  Copiando datos de PRODUCCIÓN a tu entorno local");
  console.log("============================================");
  console.log("Conectando con " + BASE_URL + " ...");
  console.log("(La primera petición puede tardar hasta 1 minuto si el servidor estaba dormido.)");

  const [drivers, charges, history, vehicles] = await Promise.all([
    getJson(BASE_URL + "/api/drivers"),
    getJson(BASE_URL + "/api/charges"),
    getJson(BASE_URL + "/api/history"),
    // /api/vehicles es una función nueva (Autos). Si production todavía no
    // tiene esa actualización publicada, no existe esta ruta — no es un
    // error, simplemente todavía no hay autos que copiar.
    getJson(BASE_URL + "/api/vehicles", { allowMissing: true }),
  ]);

  console.log("Descargado: " + drivers.length + " conductores, " + vehicles.length + " autos, " + charges.length + " cargas, " + history.length + " registros de historial.");

  if (fs.existsSync(DATA_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(__dirname, "local-data.backup-" + stamp + ".json");
    fs.copyFileSync(DATA_FILE, backupFile);
    console.log("Copia de seguridad de tus datos locales anteriores guardada en: " + path.basename(backupFile));
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify({ drivers, charges, history, vehicles }, null, 2), "utf8");
  console.log("");
  console.log("Listo. local-data.json ahora tiene una copia de los datos de producción.");
  console.log("Corre 'npm run local' y abre http://localhost:3000 para probar con estos datos.");
}

main().catch((err) => {
  console.error("");
  console.error("No se pudo completar la copia: " + err.message);
  console.error("Verifica tu conexión a internet e inténtalo de nuevo.");
  process.exitCode = 1;
});
