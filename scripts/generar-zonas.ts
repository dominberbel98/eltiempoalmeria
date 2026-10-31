// scripts/generar-zonas.ts
// Genera scripts/zonas-almeria.json (versionado): zonas de predicción por municipio, UNA POR CELDA DISTINTA
// del modelo que usa Open-Meteo en Almería (best_match = ICON-EU en malla nativa, ~6,5 km, cell_selection=land).
// Se ejecuta a mano, no en CI (al regenerar núcleos o si cambia el modelo de best_match):
//   npx tsx scripts/generar-zonas.ts [--cache celdas.json] [--reusar provincia.json ...] [--sin-red]
//   --cache   fichero JSON donde se guardan las celdas ya consultadas (para repetir sin gastar cupo)
//   --reusar  respuestas guardadas de Open-Meteo con la forma { pts: [[lat, lon, …]], arr: [{ lat|latitude, lon|longitude, el|elevation }] }
//             pedidas con best_match, cell_selection=land y sin elevation (DEM): sirven para los puntos de malla que coincidan
//   --sin-red falla si falta alguna celda en lugar de consultarla
//
// Criterio por municipio (tope de 8 zonas):
//   1. La capital (núcleo capital del IGN, no el punto de municipios-almeria.json).
//   2. Núcleos de al menos 100 hab que no sean polígonos industriales (PIND), por población, si su celda aún no la usa
//      otra zona del municipio o si difieren al menos 150 m de altitud de todas las zonas de esa celda.
//   3. Puntos de terreno de una malla de 0,025° dentro del término (sin Alborán ni partes diminutas) para las celdas
//      aún no cubiertas, priorizando la cota alta y la costa; después las celdas más extensas.
// La celda se averigua con Open-Meteo (1 variable, en serie, ≤550 ubicaciones por petición y 61 s entre peticiones).
// La altitud guardada es la que se pasa después en `elevation`: con otra altitud la API podría elegir otra celda.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { escalaLon, indiceMasCercano, leerTerminos, puntoEnMulti, type MultiPoligono, type Poligono } from "../src/lib/geozonas.ts";
import type { Nucleo } from "./generar-nucleos.ts";

const RAIZ = path.resolve(import.meta.dirname, "..");
const SALIDA = path.join(RAIZ, "scripts", "zonas-almeria.json");
const OM = "https://api.open-meteo.com/v1/forecast";

const TOPE_ZONAS = 8;
const MIN_POBLACION = 100;
const DESNIVEL_MISMA_CELDA = 150; // m
const PASO_MALLA = 0.025; // grados
const ORIGEN_MALLA: [number, number] = [36.69, -3.17]; // lat, lon (alineado con la malla de 0,03° de la investigación)
const MIN_PUNTOS_TERRENO = 2; // celdas de terreno con menos puntos de malla dentro del término apenas lo tocan
const DESNIVEL_COTA_ALTA = 200; // m por encima de la zona más alta para reservar hueco a la cota alta
const COTA_MAX_COSTA = 150; // m: un acantilado a 400 m junto al mar no es "costa" a efectos del tiempo
const DESNIVEL_SIERRA = 250; // m sobre la capital para llamar "Sierra" a una zona de terreno
const COTA_SIERRA = 1400; // m: por encima siempre es "Sierra" (los altiplanos a 1.100 m son "Interior")
const UBICACIONES_POR_PETICION = 550;
const ESPERA_MS = 61_000;

const args = process.argv.slice(2);
const valores = (nombre: string) => args.flatMap((a, i) => (a === `--${nombre}` && args[i + 1] ? [args[i + 1]] : []));
const CACHE = valores("cache")[0];
const SIN_RED = args.includes("--sin-red");

export type Zona = {
  id: string;
  municipio: string;
  nombre: string;
  tipo: "capital" | "nucleo" | "terreno";
  lat: number;
  lon: number;
  altitud: number;
  celda: { lat: number; lon: number };
  poblacion: number | null;
  nucleos: string[];
};

type Celda = { lat: number; lon: number; elevation: number };
type Consulta = { clave: string; lat: number; lon: number; elevation?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const red = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const claveMalla = (lat: number, lon: number) => `g:${lat.toFixed(3)},${lon.toFixed(3)}`;
const claveNucleo = (n: Nucleo) => `n:${n.lat},${n.lon},${n.altitud}`;
const claveCelda = (c: Celda) => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;

// ---------- Consultas a Open-Meteo ----------

let peso = 0;
let peticiones = 0;
let ultimaPeticion = 0;

async function pedirLote(lote: Consulta[]): Promise<Celda[]> {
  const conAltitud = lote[0].elevation != null;
  const cuerpo = new URLSearchParams({
    latitude: lote.map((c) => c.lat).join(","),
    longitude: lote.map((c) => c.lon).join(","),
    hourly: "temperature_2m",
    models: "best_match",
    cell_selection: "land",
    forecast_hours: "1",
    timezone: "GMT",
  });
  if (conAltitud) cuerpo.set("elevation", lote.map((c) => c.elevation).join(","));
  for (let intento = 1; intento <= 3; intento++) {
    const espera = ultimaPeticion + ESPERA_MS - Date.now();
    if (ultimaPeticion && espera > 0) {
      console.log(`  espero ${Math.ceil(espera / 1000)} s (límite por minuto de Open-Meteo)…`);
      await sleep(espera);
    }
    ultimaPeticion = Date.now();
    peticiones++;
    const res = await fetch(OM, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: cuerpo.toString() });
    const texto = await res.text();
    if (res.status === 429) {
      const motivo = (() => {
        try {
          return String(JSON.parse(texto).reason ?? "");
        } catch {
          return texto.slice(0, 200);
        }
      })();
      if (/hour|day|daily|month/i.test(motivo)) throw new Error(`Open-Meteo: cupo agotado (${motivo}). No reintento.`);
      console.warn(`  429 por minuto, reintento ${intento}`);
      continue;
    }
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${texto.slice(0, 200)}`);
    peso += lote.length; // 1 variable horaria y 1 hora: peso 1 por ubicación
    const j = JSON.parse(texto) as { latitude: number; longitude: number; elevation: number } | { latitude: number; longitude: number; elevation: number }[];
    const lista = Array.isArray(j) ? j : [j];
    if (lista.length !== lote.length) throw new Error(`Open-Meteo devolvió ${lista.length} ubicaciones de ${lote.length}`);
    return lista.map((x) => ({ lat: x.latitude, lon: x.longitude, elevation: x.elevation }));
  }
  throw new Error("Open-Meteo: demasiados 429 seguidos");
}

async function consultarCeldas(consultas: Consulta[], cache: Record<string, Celda>) {
  const faltan = consultas.filter((c) => !cache[c.clave]);
  if (!faltan.length) return;
  if (SIN_RED) throw new Error(`Faltan ${faltan.length} celdas y se ha pedido --sin-red`);
  // Las consultas con y sin altitud no pueden ir en la misma petición (elevation es una lista completa o nada)
  for (const grupo of [faltan.filter((c) => c.elevation == null), faltan.filter((c) => c.elevation != null)]) {
    for (let i = 0; i < grupo.length; i += UBICACIONES_POR_PETICION) {
      const lote = grupo.slice(i, i + UBICACIONES_POR_PETICION);
      console.log(`  Open-Meteo: ${lote.length} ubicaciones ${lote[0].elevation != null ? "con" : "sin"} altitud…`);
      const celdas = await pedirLote(lote);
      lote.forEach((c, k) => (cache[c.clave] = celdas[k]));
      if (CACHE) await writeFile(CACHE, JSON.stringify(cache));
    }
  }
}

async function leerReutilizables(cache: Record<string, Celda>) {
  let n = 0;
  for (const ruta of valores("reusar")) {
    if (!existsSync(ruta)) continue;
    const j = JSON.parse(await readFile(ruta, "utf8")) as {
      pts: [number, number, ...unknown[]][];
      arr: { lat?: number; lon?: number; el?: number; latitude?: number; longitude?: number; elevation?: number }[];
    };
    j.pts.forEach(([lat, lon], i) => {
      const x = j.arr[i];
      const c = { lat: x?.lat ?? x?.latitude, lon: x?.lon ?? x?.longitude, elevation: x?.el ?? x?.elevation };
      if (c.lat == null || c.lon == null || c.elevation == null) return;
      const k = claveMalla(lat, lon);
      if (!cache[k]) {
        cache[k] = c as Celda;
        n++;
      }
    });
  }
  return n;
}

// ---------- Geometría auxiliar ----------

type GeoJsonPoligonos = { features: { geometry: { type: "Polygon"; coordinates: Poligono } | { type: "MultiPolygon"; coordinates: MultiPoligono } }[] };

function multis(gj: GeoJsonPoligonos): MultiPoligono[] {
  return gj.features.map((f) => (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates));
}

const RUMBOS = ["norte", "noreste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];

function rumboYDistancia(desde: { lat: number; lon: number }, hasta: { lat: number; lon: number }) {
  const k = Math.cos((desde.lat * Math.PI) / 180);
  const dx = (hasta.lon - desde.lon) * k;
  const dy = hasta.lat - desde.lat;
  const angulo = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return { rumbo: RUMBOS[Math.round(angulo / 45) % 8], km: Math.hypot(dx, dy) * 111.32 };
}

/** "1.000 m", "450 m", "40 m": redondeo a 50 m (a 10 m por debajo de 100 m) y punto de millar. */
function textoAltitud(m: number): string {
  const v = m < 100 ? Math.max(0, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
  const s = v >= 1000 ? `${Math.floor(v / 1000)}.${String(v % 1000).padStart(3, "0")}` : String(v);
  return `${s} m`;
}

/** Altitud de un nombre de zona de terreno: "Sierra al norte (1.150 m)" => 1150 (null si no lleva). */
const altitudDelNombre = (nombre: string) => {
  const m = /\(([\d.]+) m\)$/.exec(nombre);
  return m ? Number(m[1].replace(/\./g, "")) : null;
};

/**
 * Nombres de terreno que se confunden dentro del municipio: el mismo nombre ("Interior al noroeste (1.100 m)") o el
 * mismo rumbo con altitudes a ≤100 m ("Sierra al noroeste (1.700 m)" y "(1.650 m)"). A todas las zonas de ese rumbo se
 * les añade la distancia a la capital dentro del paréntesis: "Interior al noroeste (a 14 km, 1.100 m)". Va dentro del
 * paréntesis para que en las frases ("irá de 5 °C en el interior al noroeste (a 14 km, 1.100 m) a 9 °C en María")
 * no se lea como otra cifra.
 */
function desambiguarNombres(zonas: { nombre: string; tipo: string; lat: number; lon: number }[], capital: { lat: number; lon: number }): void {
  const base = (n: string) => n.replace(/\s*\([^)]*\)\s*$/, "").replace(/, a \d+ km$/, "");
  const grupos = new Map<string, typeof zonas>();
  for (const z of zonas) {
    if (z.tipo !== "terreno") continue;
    const b = base(z.nombre);
    grupos.set(b, [...(grupos.get(b) ?? []), z]);
  }
  for (const [b, grupo] of grupos) {
    if (grupo.length < 2) continue;
    const alt = grupo.map((z) => altitudDelNombre(z.nombre));
    const confusos = grupo.some((_, i) => grupo.some((__, j) => j > i && (alt[i] == null || alt[j] == null || Math.abs(alt[i]! - alt[j]!) <= 100)));
    if (!confusos) continue;
    for (const [i, z] of grupo.entries()) {
      const km = Math.round(rumboYDistancia(capital, z).km);
      z.nombre = alt[i] == null ? `${b} (a ${km} km)` : `${b} (a ${km} km, ${textoAltitud(alt[i]!)})`;
    }
  }
}

// ---------- Programa ----------

async function main() {
  const nucleos = JSON.parse(await readFile(path.join(RAIZ, "scripts", "nucleos-almeria.json"), "utf8")) as Nucleo[];
  const municipios = JSON.parse(await readFile(path.join(RAIZ, "scripts", "municipios-almeria.json"), "utf8")) as {
    id: string;
    nombre: string;
    lat: number;
    lon: number;
    altitud: number;
  }[];
  const terminos = leerTerminos(path.join(RAIZ, "public", "municipios.geojson"));
  const crudos = multis(JSON.parse(await readFile(path.join(RAIZ, "public", "municipios.geojson"), "utf8")) as GeoJsonPoligonos);
  const provincias = multis(JSON.parse(await readFile(path.join(RAIZ, "public", "provinces.geojson"), "utf8")) as GeoJsonPoligonos);

  // Mar = fuera de las cinco provincias del GeoJSON y fuera de todos los términos de Almería
  const esMar = (lat: number, lon: number) => !provincias.some((p) => puntoEnMulti(lon, lat, p)) && !crudos.some((p) => puntoEnMulti(lon, lat, p));
  // Costa: al menos 3 de 16 sondas a 2,5 km caen en el mar (equivale a estar a menos de unos 2 km de la orilla)
  const esCosta = (lat: number, lon: number) => {
    const k = Math.cos((lat * Math.PI) / 180);
    const r = 2.5 / 111.32;
    let mar = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      if (esMar(lat + r * Math.cos(a), lon + (r * Math.sin(a)) / k)) mar++;
    }
    return mar >= 3;
  };

  // Revisión de capitales: el núcleo capital del IGN frente al punto de municipios-almeria.json
  console.log("Capitales IGN a más de 1 km (o 100 m de desnivel) del punto del municipio:");
  for (const m of municipios) {
    const c = nucleos.find((n) => n.municipio === m.id && n.capital);
    if (!c) throw new Error(`Sin núcleo capital en ${m.nombre}`);
    const { km } = rumboYDistancia(m, c);
    if (km > 1 || Math.abs(c.altitud - m.altitud) > 100) {
      console.log(`  ${m.nombre}: capital IGN "${c.nombre}" a ${km.toFixed(2)} km, ${c.altitud} m frente a ${m.altitud} m. La zona capital usa el núcleo IGN.`);
    }
  }

  // Malla dentro de cada término normalizado
  const malla = new Map<string, { lat: number; lon: number }[]>();
  for (const [id, t] of terminos) {
    const pts: { lat: number; lon: number }[] = [];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of t) for (const [x, y] of p[0]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    const i0 = Math.ceil((y0 - ORIGEN_MALLA[0]) / PASO_MALLA - 1e-9);
    const j0 = Math.ceil((x0 - ORIGEN_MALLA[1]) / PASO_MALLA - 1e-9);
    for (let i = i0; ORIGEN_MALLA[0] + i * PASO_MALLA <= y1; i++) {
      for (let j = j0; ORIGEN_MALLA[1] + j * PASO_MALLA <= x1; j++) {
        const lat = red(ORIGEN_MALLA[0] + i * PASO_MALLA, 3);
        const lon = red(ORIGEN_MALLA[1] + j * PASO_MALLA, 3);
        if (puntoEnMulti(lon, lat, t)) pts.push({ lat, lon });
      }
    }
    malla.set(id, pts);
  }
  const totalMalla = [...malla.values()].reduce((s, p) => s + p.length, 0);

  const candidatos = nucleos.filter((n) => n.capital || (n.poblacion >= MIN_POBLACION && n.tipo !== "PIND"));
  console.log(`Malla de ${PASO_MALLA}°: ${totalMalla} puntos; candidatos de núcleo: ${candidatos.length}`);

  // Celdas: caché, resultados reutilizables y, para lo que falte, Open-Meteo
  const cache: Record<string, Celda> = CACHE && existsSync(CACHE) ? JSON.parse(await readFile(CACHE, "utf8")) : {};
  const reusadas = await leerReutilizables(cache);
  const consultas: Consulta[] = [
    ...[...malla.values()].flat().map((p) => ({ clave: claveMalla(p.lat, p.lon), lat: p.lat, lon: p.lon })),
    ...candidatos.map((n) => ({ clave: claveNucleo(n), lat: n.lat, lon: n.lon, elevation: n.altitud })),
  ];
  const yaEstaban = consultas.filter((c) => cache[c.clave]).length;
  console.log(`Celdas ya conocidas: ${yaEstaban} de ${consultas.length} (${reusadas} cargadas de --reusar)`);
  await consultarCeldas(consultas, cache);

  // Selección por municipio
  type Interna = Zona & { claveCelda: string; costa: boolean };
  const zonas: Interna[] = [];
  const resumen: { id: string; nombre: string; n: number; celdas: number; tipos: string }[] = [];
  for (const m of municipios) {
    const t = terminos.get(m.id);
    const propios = nucleos.filter((n) => n.municipio === m.id);
    const capital = propios.find((n) => n.capital)!;
    const aZona = (n: Nucleo, tipo: "capital" | "nucleo"): Interna => {
      const c = cache[claveNucleo(n)];
      return {
        id: n.id,
        municipio: m.id,
        nombre: n.nombre,
        tipo,
        lat: n.lat,
        lon: n.lon,
        altitud: Math.round(c.elevation),
        celda: { lat: red(c.lat, 5), lon: red(c.lon, 5) },
        poblacion: n.poblacion,
        nucleos: [],
        claveCelda: claveCelda(c),
        costa: c.elevation <= COTA_MAX_COSTA && esCosta(n.lat, n.lon),
      };
    };
    const elegidas: Interna[] = [aZona(capital, "capital")];
    // 2. Núcleos por población
    const deNucleo: Interna[] = [];
    for (const n of candidatos.filter((x) => x.municipio === m.id && !x.capital).sort((a, b) => b.poblacion - a.poblacion)) {
      const z = aZona(n, "nucleo");
      const mismaCelda = [...elegidas, ...deNucleo].filter((x) => x.claveCelda === z.claveCelda);
      if (mismaCelda.every((x) => Math.abs(x.altitud - z.altitud) >= DESNIVEL_MISMA_CELDA)) deNucleo.push(z);
    }
    // 3. Terreno: celdas de la malla aún no cubiertas
    const usadas = new Set([...elegidas, ...deNucleo].map((z) => z.claveCelda));
    const grupos = new Map<string, { lat: number; lon: number; elev: number; celda: Celda }[]>();
    for (const p of malla.get(m.id) ?? []) {
      const c = cache[claveMalla(p.lat, p.lon)];
      const k = claveCelda(c);
      if (usadas.has(k)) continue;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push({ ...p, elev: c.elevation, celda: c });
    }
    type Grupo = { clave: string; n: number; rep: { lat: number; lon: number; elev: number; celda: Celda }; alta: number; costa: boolean };
    const terreno: Grupo[] = [...grupos.entries()]
      .filter(([, pts]) => pts.length >= MIN_PUNTOS_TERRENO)
      .map(([clave, pts]) => {
        const cLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
        const cLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
        const k = Math.cos((cLat * Math.PI) / 180);
        const cerca = (lista: typeof pts) =>
          lista.reduce((a, b) => (((a.lon - cLon) * k) ** 2 + (a.lat - cLat) ** 2 <= ((b.lon - cLon) * k) ** 2 + (b.lat - cLat) ** 2 ? a : b));
        const costeros = pts.filter((p) => p.elev <= COTA_MAX_COSTA && esCosta(p.lat, p.lon));
        return { clave, n: pts.length, rep: costeros.length ? cerca(costeros) : cerca(pts), alta: Math.max(...pts.map((p) => p.elev)), costa: costeros.length > 0 };
      });
    // Reservas: la cota alta (si sobresale) y la costa (si ninguna zona de núcleo es costera)
    const reservas: Grupo[] = [];
    const masAlta = [...terreno].sort((a, b) => b.alta - a.alta)[0];
    const altMax = Math.max(...[...elegidas, ...deNucleo].map((z) => z.altitud));
    if (masAlta && !masAlta.costa && masAlta.alta >= altMax + DESNIVEL_COTA_ALTA) {
      // En la celda de la cota alta, el punto representativo es el más alto de la malla
      const pts = grupos.get(masAlta.clave)!;
      masAlta.rep = pts.reduce((a, b) => (b.elev > a.elev ? b : a));
      reservas.push(masAlta);
    }
    const hayCosta = [...elegidas, ...deNucleo].some((z) => z.costa);
    const costera = terreno.filter((g) => g.costa && !reservas.includes(g)).sort((a, b) => b.n - a.n)[0];
    if (!hayCosta && costera) reservas.push(costera);
    const resto = terreno.filter((g) => !reservas.includes(g)).sort((a, b) => b.n - a.n || b.alta - a.alta);
    elegidas.push(...deNucleo.slice(0, Math.max(0, TOPE_ZONAS - 1 - reservas.length)));
    const terrenoElegido = [...reservas, ...resto].slice(0, TOPE_ZONAS - elegidas.length);
    terrenoElegido.forEach((g, i) => {
      const { rumbo, km } = rumboYDistancia(capital, g.rep);
      const elev = Math.round(g.rep.elev);
      const sierra = elev >= capital.altitud + DESNIVEL_SIERRA || elev >= COTA_SIERRA;
      // Costa baja: "Costa al sur"; junto al mar pero en alto (sin llegar a sierra): "Costa al sur (300 m)"
      const nombre =
        km < 1.5
          ? `Alrededores de ${capital.nombre} (${textoAltitud(elev)})`
          : g.costa
            ? `Costa al ${rumbo}`
            : !sierra && esCosta(g.rep.lat, g.rep.lon)
              ? `Costa al ${rumbo} (${textoAltitud(elev)})`
              : `${sierra ? "Sierra" : "Interior"} al ${rumbo} (${textoAltitud(elev)})`;
      elegidas.push({
        id: `T${m.id}-${i + 1}`,
        municipio: m.id,
        nombre,
        tipo: "terreno",
        lat: g.rep.lat,
        lon: g.rep.lon,
        altitud: elev,
        celda: { lat: red(g.rep.celda.lat, 5), lon: red(g.rep.celda.lon, 5) },
        poblacion: null,
        nucleos: [],
        claveCelda: g.clave,
        costa: g.costa,
      });
    });
    desambiguarNombres(elegidas, capital);
    // Núcleos del buscador: el de la propia zona; si no, la zona de su celda (la de altitud más parecida); si no, Voronoi
    const k = t ? escalaLon(t) : Math.cos((m.lat * Math.PI) / 180);
    for (const n of propios) {
      let destino = elegidas.find((z) => z.id === n.id);
      const c = cache[claveNucleo(n)];
      if (!destino && c) {
        const mismas = elegidas.filter((z) => z.claveCelda === claveCelda(c));
        if (mismas.length) destino = mismas.reduce((a, b) => (Math.abs(a.altitud - n.altitud) <= Math.abs(b.altitud - n.altitud) ? a : b));
      }
      destino ??= elegidas[indiceMasCercano(n.lon, n.lat, elegidas, k)];
      destino.nucleos.push(n.id);
    }
    zonas.push(...elegidas);
    resumen.push({
      id: m.id,
      nombre: m.nombre,
      n: elegidas.length,
      celdas: new Set(elegidas.map((z) => z.claveCelda)).size,
      tipos: elegidas.map((z) => z.tipo[0]).join(""),
    });
  }

  const salida: Zona[] = zonas.map(({ claveCelda: _c, costa: _k, ...z }) => ({ ...z, nucleos: [...z.nucleos].sort() }));
  await writeFile(SALIDA, "[\n" + salida.map((z) => JSON.stringify(z)).join(",\n") + "\n]\n");

  const hist: Record<number, number> = {};
  for (const r of resumen) hist[r.n] = (hist[r.n] ?? 0) + 1;
  console.log(`\nEscrito ${path.relative(RAIZ, SALIDA)}: ${salida.length} zonas (${salida.filter((z) => z.tipo === "nucleo").length} núcleos, ${salida.filter((z) => z.tipo === "terreno").length} de terreno)`);
  console.log(`Zonas por municipio: ${JSON.stringify(hist)}`);
  console.log(`Open-Meteo: ${peticiones} peticiones, peso ${peso}`);
  for (const id of ["04066", "04013", "04902", "04079", "04029", "04098", "04062"]) {
    const r = resumen.find((x) => x.id === id)!;
    console.log(`  ${r.nombre} (${r.n}): ${salida.filter((z) => z.municipio === id).map((z) => `${z.nombre} [${z.altitud} m]`).join("; ")}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
