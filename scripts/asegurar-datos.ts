// Antes de `npm run dev`: si no hay datos en src/data/, los descarga (sin clave solo Open-Meteo y fuentes sin clave).
// Si ya hay datos no hace nada: para refrescarlos, `npm run fetch:data` (respeta los TTL de cada fuente).
import { existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const hayMunicipios = existsSync("src/data/municipios") && readdirSync("src/data/municipios").some((f) => f.endsWith(".json"));
if (!existsSync("src/data/municipios.json") || !existsSync("src/data/meta.json") || !hayMunicipios) {
  console.log("No hay datos en src/data/. Descargando…");
  execSync("npm run fetch:data", { stdio: "inherit" });
}
