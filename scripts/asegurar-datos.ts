// Antes de `npm run dev`: si no hay datos en src/data/, los descarga (sin clave usa solo Open-Meteo).
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

if (!existsSync("src/data/municipios.json") || !existsSync("src/data/meta.json")) {
  console.log("No hay datos en src/data/. Descargando…");
  execSync("npm run fetch:data", { stdio: "inherit" });
}
