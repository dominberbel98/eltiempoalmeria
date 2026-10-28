// scripts/fetch-weather.ts
// Descarga datos de AEMET y Open-Meteo para los 103 municipios de Almería y los guarda en src/data/.
// Uso: AEMET_API_KEY=xxx npx tsx scripts/fetch-weather.ts
// Sin clave (solo en local, nunca en CI) descarga solo Open-Meteo para poder trabajar en la web.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const AEMET = "https://opendata.aemet.es/opendata/api";
const KEY = process.env.AEMET_API_KEY;
if (!KEY && process.env.CI) throw new Error("Falta la variable de entorno AEMET_API_KEY");
if (!KEY) console.warn("AVISO: sin AEMET_API_KEY. Modo local: solo Open-Meteo, todos los municipios marcados como fallo AEMET.");

// Lista de respaldo (código INE, nombre, coordenadas) por si el maestro de AEMET no está disponible
const SEMILLA = path.resolve("scripts/municipios-almeria.json");

const OUT = path.resolve("src/data");
const PREFIJO_PROVINCIA = "04"; // Almería
const DELAY_MS = 1300; // ~45 peticiones/min para no chocar con el límite de AEMET
const MAX_FALLOS = 0.2; // si falla más del 20 % de municipios, abortar (se queda online la versión anterior)

// Caja aproximada de la provincia para filtrar estaciones (refinar luego con el polígono provincial)
const BBOX = { latMin: 36.65, latMax: 37.95, lonMin: -3.2, lonMax: -1.6 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  for (let intento = 1; intento <= 5; intento++) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      await sleep(intento * 5_000);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`  ${res.status} en ${url}, reintento ${intento}`);
      await sleep(intento * 15_000);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const charset =
      /charset=([^;]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.trim().toLowerCase() ?? "utf-8";
    const bytes = await res.arrayBuffer();
    // AEMET declara ISO-8859-15 pero a menudo envía UTF-8: se prueba UTF-8 estricto y, si no lo es, el charset declarado
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder(charset).decode(bytes);
    }
  }
  throw new Error(`Demasiados reintentos: ${url}`);
}

// AEMET responde en dos pasos: { estado, datos } -> GET datos. Algunos endpoints maestros devuelven el array directamente.
async function aemet<T>(endpoint: string): Promise<T> {
  const primera = JSON.parse(await getText(`${AEMET}${endpoint}`, { api_key: KEY! }));
  await sleep(DELAY_MS);
  if (Array.isArray(primera)) return primera as T;
  if (primera.estado !== 200 || !primera.datos) {
    throw new Error(`AEMET ${endpoint}: ${primera.estado} ${primera.descripcion ?? ""}`);
  }
  const datos = JSON.parse(await getText(primera.datos));
  await sleep(DELAY_MS);
  return datos as T;
}

const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// El maestro de AEMET puede traer artículos pospuestos ("Ejido, El" o "Ejido (El)")
const nombreNatural = (s: string) =>
  s.trim().replace(/^(.+?),\s*(El|La|Los|Las)$|^(.+?)\s*\((El|La|Los|Las)\)$/, (_, a, b, c, d) => `${b ?? d} ${a ?? c}`);

type MunicipioMaestro = {
  id: string; // "id04013"
  nombre: string;
  latitud_dec: string;
  longitud_dec: string;
  altitud: string;
};

type Municipio = { id: string; nombre: string; slug: string; lat: number; lon: number; altitud: number };

async function main() {
  await mkdir(path.join(OUT, "municipios"), { recursive: true });

  // 1. Maestro de municipios
  console.log("Municipios…");
  let base: Omit<Municipio, "slug">[] = [];
  if (KEY) {
    try {
      const maestro = await aemet<MunicipioMaestro[]>("/maestro/municipios");
      base = maestro
        .map((m) => ({ ...m, id: m.id.replace(/^id/, "") }))
        .filter((m) => m.id.startsWith(PREFIJO_PROVINCIA))
        .map((m) => ({
          id: m.id,
          nombre: nombreNatural(m.nombre),
          lat: Number(m.latitud_dec),
          lon: Number(m.longitud_dec),
          altitud: Number(m.altitud),
        }));
    } catch (e) {
      console.warn(`  fallo maestro AEMET, uso la lista de respaldo: ${(e as Error).message}`);
    }
  }
  const semilla: Omit<Municipio, "slug">[] = JSON.parse(await readFile(SEMILLA, "utf8"));
  if (base.length < 100) base = semilla;
  // El maestro de AEMET no incluye algún municipio reciente (p. ej. Balanegra, 04904): se completa con la lista de respaldo
  const enMaestro = new Set(base.map((m) => m.id));
  base.push(...semilla.filter((m) => !enMaestro.has(m.id)));
  const municipios: Municipio[] = base
    .map((m) => ({ ...m, slug: slugify(m.nombre) }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  if (municipios.length < 100) throw new Error(`Solo ${municipios.length} municipios; revisa el maestro`);
  await writeFile(path.join(OUT, "municipios.json"), JSON.stringify(municipios));
  console.log(`  ${municipios.length} municipios`);

  // 2. Open-Meteo: una sola llamada con todas las coordenadas
  console.log("Open-Meteo…");
  const om = new URL("https://api.open-meteo.com/v1/forecast");
  om.searchParams.set("latitude", municipios.map((m) => m.lat).join(","));
  om.searchParams.set("longitude", municipios.map((m) => m.lon).join(","));
  om.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation_probability",
      "precipitation",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "uv_index",
    ].join(",")
  );
  om.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset"
  );
  om.searchParams.set("timezone", "Europe/Madrid");
  om.searchParams.set("forecast_days", "7");
  om.searchParams.set("wind_speed_unit", "kmh");
  const openMeteo: unknown[] = JSON.parse(await getText(om.toString()));

  // 3. AEMET por municipio
  const fallos: string[] = [];
  for (const [i, m] of municipios.entries()) {
    console.log(`[${i + 1}/${municipios.length}] ${m.nombre}`);
    let aemetDiaria: unknown = null;
    let aemetHoraria: unknown = null;
    if (!KEY) {
      fallos.push(m.id);
    } else try {
      [aemetDiaria] = await aemet<unknown[]>(`/prediccion/especifica/municipio/diaria/${m.id}`);
      [aemetHoraria] = await aemet<unknown[]>(`/prediccion/especifica/municipio/horaria/${m.id}`);
    } catch (e) {
      console.warn(`  fallo AEMET: ${(e as Error).message}`);
      fallos.push(m.id);
    }
    await writeFile(
      path.join(OUT, "municipios", `${m.id}.json`),
      JSON.stringify({ aemetDiaria, aemetHoraria, openMeteo: openMeteo[i] ?? null })
    );
  }
  if (KEY && fallos.length > municipios.length * MAX_FALLOS) {
    throw new Error(`Fallaron ${fallos.length} municipios en AEMET; abortando para no publicar datos incompletos`);
  }

  // 4. Observaciones de estaciones (últimas 24 h), filtradas a la provincia
  console.log("Observaciones…");
  type Obs = { idema: string; lat: number; lon: number };
  let observaciones: Obs[] = [];
  if (KEY) try {
    const todas = await aemet<Obs[]>("/observacion/convencional/todas");
    observaciones = todas.filter(
      (o) => o.lat >= BBOX.latMin && o.lat <= BBOX.latMax && o.lon >= BBOX.lonMin && o.lon <= BBOX.lonMax
    );
  } catch (e) {
    console.warn(`  fallo observaciones: ${(e as Error).message}`);
  }
  await writeFile(path.join(OUT, "observaciones.json"), JSON.stringify(observaciones));

  await writeFile(
    path.join(OUT, "meta.json"),
    JSON.stringify({ updatedAt: new Date().toISOString(), fallosAemet: fallos })
  );
  console.log(`Listo. Fallos AEMET: ${fallos.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
