// Lectura de src/data/observaciones.json (observación convencional de AEMET, ya filtrada a la provincia de Almería
// por scripts/fuentes/observaciones.ts, que acumula las 24 últimas horas) y preparación de la página /observaciones/.
// Solo se ejecuta en el build. Los valores que faltan son null (nunca 0).
//
// Variables de AEMET (metadatos de /observacion/convencional/todas). `fint` es el fin del periodo, en UTC:
//   ta, tamax, tamin  temperatura instantánea y máxima/mínima de la hora anterior (°C); tpr punto de rocío (°C)
//   hr                humedad relativa instantánea (%)
//   vv, dv            viento medio de los 10 min anteriores (m/s) y su dirección (grados, de donde viene)
//   vmax, dmax        racha máxima (3 s) de la hora anterior (m/s) y su dirección (grados)
//   prec              precipitación de la hora anterior (mm = l/m²)
//   pres, pres_nmar   presión instantánea en la estación y reducida al nivel del mar (hPa)
//   vis (km), inso (horas de sol en la hora anterior), ts/tss5cm (temperatura del suelo, °C): solo en algunas.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getMeta, getMunicipios, type Municipio } from "./datos";
import { leerTerminos, puntoEnMulti } from "./geozonas";
import { ZONA } from "./tiempo";

const RUTA = path.resolve("src/data/observaciones.json");
const KMH = 3.6; // AEMET da el viento en m/s

/** Minutos a partir de los que el último dato de una estación se da por atrasado: AEMET publica con ~1 h de retraso
 * y se descarga cada ~1 h, así que lo normal es entre 60 y 130 min. */
export const MINUTOS_ATRASO = 180;

/** Registro tal como lo da AEMET (solo los campos que se usan; los demás se conservan en el JSON). */
export type ObsAemet = {
  idema: string;
  ubi: string;
  lat: number;
  lon: number;
  alt: number;
  fint: string; // "2026-10-31T10:00:00+0000"
  ta?: number;
  tamax?: number;
  tamin?: number;
  tpr?: number;
  hr?: number;
  vv?: number;
  dv?: number;
  vmax?: number;
  dmax?: number;
  prec?: number;
  pres?: number;
  pres_nmar?: number;
  vis?: number;
  inso?: number;
};

/** Una lectura horaria, en unidades de la web (km/h, hora local). */
export type Lectura = {
  fint: string; // ISO UTC normalizado "2026-10-31T10:00:00.000Z": fin del periodo de observación
  hora: string; // hora local de Madrid "2026-10-31T11:00" (mismo formato que src/lib/tiempo.ts)
  temp: number | null; // °C
  tempMax: number | null; // °C, máxima de la hora anterior
  tempMin: number | null; // °C, mínima de la hora anterior
  rocio: number | null; // °C
  hum: number | null; // %
  viento: number | null; // km/h, media de 10 min (1 decimal)
  dir: number | null; // grados, de donde viene; null en calma o sin dato
  racha: number | null; // km/h, máxima de la hora anterior (1 decimal)
  dirRacha: number | null; // grados
  prec: number | null; // mm en la hora anterior
  pres: number | null; // hPa en la estación
  presMar: number | null; // hPa reducida al nivel del mar
  vis: number | null; // km
};

export type MunicipioCorto = Pick<Municipio, "id" | "nombre" | "slug">;
/** Valor con la hora de la lectura (local de Madrid) en que se dio. */
export type ValorHora = { valor: number; hora: string; fint: string };

export type Estacion = {
  idema: string; // indicativo AEMET, "6325O"
  nombre: string; // nombre legible ("Almería, aeropuerto")
  ubi: string; // nombre original de AEMET (en mayúsculas)
  lat: number;
  lon: number;
  alt: number; // m
  municipio: MunicipioCorto | null; // término en el que está (o el más cercano, para los faros de la costa)
  serie: Lectura[]; // ascendente por hora, como mucho 24
  ultima: Lectura | null;
  horas: number; // lecturas de la serie
  edadMin: number; // minutos desde el fin del periodo de la última lectura (Infinity sin lecturas)
  atrasada: boolean; // edadMin > MINUTOS_ATRASO
  tempMax24: ValorHora | null; // con tamax (o ta si falta)
  tempMin24: ValorHora | null; // con tamin (o ta si falta)
  rachaMax24: (ValorHora & { dir: number | null }) | null;
  prec24: number | null; // mm sumados en la serie (null si ninguna lectura trae precipitación)
  horasPrec: number; // lecturas con precipitación: si es < 24, prec24 no cubre las 24 h
  presTendencia3h: number | null; // hPa: presión de la última lectura menos la de 3 h antes
};

export type ExtremoProvincia = ValorHora & { estacion: { idema: string; nombre: string }; dir?: number | null };

export type ResumenObservaciones = {
  actualizado: string | null; // descarga (meta.fuentes.observaciones.actualizado)
  ultimoDato: string | null; // fint ISO UTC más reciente de todas las estaciones
  edadMin: number; // minutos desde ultimoDato
  estaciones: number;
  conDatoReciente: number; // estaciones con la última lectura de hace ≤ MINUTOS_ATRASO
  horasCubiertas: number; // horas entre la primera y la última lectura de la provincia (+1), como mucho 24
  tempMax: ExtremoProvincia | null; // máxima de 24 h
  tempMin: ExtremoProvincia | null; // mínima de 24 h
  rachaMax: ExtremoProvincia | null; // km/h
  precMax: ExtremoProvincia | null; // mm acumulados en la serie de la estación (hora de su última lectura); null si no ha llovido
  tempAhoraMax: ExtremoProvincia | null; // temperatura más alta de las últimas lecturas recientes
  tempAhoraMin: ExtremoProvincia | null;
};

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

let cache: { mtime: number; datos: ObsAemet[] } | null = null;

/** Registros de observaciones.json; [] si no existe o no se puede leer (la página debe decir "sin datos"). */
export function getObservaciones(): ObsAemet[] {
  if (!existsSync(RUTA)) return [];
  try {
    const mtime = statSync(RUTA).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.datos;
    const datos = JSON.parse(readFileSync(RUTA, "utf8")) as unknown;
    const lista = Array.isArray(datos) ? (datos as ObsAemet[]).filter((o) => o && typeof o.idema === "string" && Number.isFinite(msFint(o.fint))) : [];
    cache = { mtime, datos: lista };
    return lista;
  } catch {
    return [];
  }
}

/** Instante (ms) de un `fint` de AEMET ("2026-10-31T10:00:00+0000"; admite también "Z" o sin zona = UTC). */
export function msFint(fint: string | null | undefined): number {
  if (!fint) return Number.NaN;
  const s = String(fint).trim().replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(s) ? s : s + "Z");
}

/** Hora local de Madrid "2026-10-31T11:00" de un instante. */
export function horaMadrid(ms: number): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------------------------

const num = (v: unknown, min: number, max: number): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null; // fuera de rango = dato erróneo
};
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
const aKmh = (ms: number | null) => (ms == null ? null : r1(ms * KMH));

export function aLectura(o: ObsAemet): Lectura {
  const ms = msFint(o.fint);
  const viento = aKmh(num(o.vv, 0, 100));
  const dir = num(o.dv, 0, 360);
  const racha = aKmh(num(o.vmax, 0, 120));
  return {
    fint: new Date(ms).toISOString(),
    hora: horaMadrid(ms),
    temp: num(o.ta, -40, 60),
    tempMax: num(o.tamax, -40, 60),
    tempMin: num(o.tamin, -40, 60),
    rocio: num(o.tpr, -60, 40),
    hum: num(o.hr, 0, 100),
    viento,
    dir: viento === 0 ? null : dir,
    racha,
    dirRacha: racha === 0 ? null : num(o.dmax, 0, 360),
    prec: num(o.prec, 0, 500),
    pres: num(o.pres, 500, 1100),
    presMar: num(o.pres_nmar, 900, 1100),
    vis: num(o.vis, 0, 100),
  };
}

// Nombres legibles de las estaciones de la provincia (AEMET los da en mayúsculas, a veces con el paraje).
const NOMBRES: Record<string, string> = {
  "5060X": "Topares",
  "6277C": "Adra, faro",
  "6291B": "El Ejido",
  "6293X": "Faro de Sabinar",
  "6299I": "Laguna Seca, Sierra Nevada",
  "6302X": "Abla",
  "6307C": "Laujar, Sierra Nevada",
  "6307X": "Laujar de Andarax",
  "6312E": "Rágol, Sierra Nevada",
  "6325O": "Almería, aeropuerto",
  "6329X": "Cabo de Gata, faro",
  "6332Y": "Carboneras, faro de Mesa Roldán",
  "6335O": "Nacimiento, Sierra Nevada",
  "6340X": "Garrucha",
  "6364X": "Albox",
  "6367X": "Huércal-Overa",
};

const MENORES = new Set(["de", "del", "la", "las", "los", "el", "y"]);
/** "ROQUETAS DE MAR-FARO SABINAR" -> "Roquetas de Mar, Faro Sabinar" (para estaciones nuevas sin nombre fijado). */
export function nombreLegible(ubi: string): string {
  const limpio = ubi
    .replace(/\(.*?\)/g, " ")
    .replace(/\s+PARQUE NACIONAL\s+/i, ", ")
    .replace(/\s*[-/]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("es");
  return limpio
    .split(" ")
    .map((p, i) => (i > 0 && MENORES.has(p) ? p : p.charAt(0).toLocaleUpperCase("es") + p.slice(1)))
    .join(" ");
}

const distanciaKm = (lat1: number, lon1: number, lat2: number, lon2: number) =>
  Math.hypot((lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)), lat2 - lat1) * 111.32;

/** Municipio cuyo término contiene la estación; si ninguno (faros en la costa), el de cabecera más cercana. */
function municipioDe(lat: number, lon: number): MunicipioCorto | null {
  let municipios: Municipio[];
  try {
    municipios = getMunicipios();
  } catch {
    return null;
  }
  const terminos = leerTerminos();
  const dentro = municipios.find((m) => {
    const t = terminos.get(m.id);
    return t ? puntoEnMulti(lon, lat, t) : false;
  });
  const m = dentro ?? [...municipios].sort((a, b) => distanciaKm(lat, lon, a.lat, a.lon) - distanciaKm(lat, lon, b.lat, b.lon))[0];
  return m ? { id: m.id, nombre: m.nombre, slug: m.slug } : null;
}

// ---------------------------------------------------------------------------------------------
// Estaciones
// ---------------------------------------------------------------------------------------------

function extremo(serie: Lectura[], valor: (l: Lectura) => number | null, mayor: boolean): ValorHora | null {
  let mejor: ValorHora | null = null;
  for (const l of serie) {
    const v = valor(l);
    if (v == null) continue;
    if (!mejor || (mayor ? v > mejor.valor : v < mejor.valor)) mejor = { valor: v, hora: l.hora, fint: l.fint };
  }
  return mejor;
}

/**
 * Estaciones de la provincia con su serie de 24 h y su último dato, ordenadas por nombre.
 * `ahora` sirve para la antigüedad del dato.
 */
export function getEstaciones(ahora: Date = new Date()): Estacion[] {
  const grupos = new Map<string, ObsAemet[]>();
  for (const o of getObservaciones()) {
    const g = grupos.get(o.idema);
    if (g) g.push(o);
    else grupos.set(o.idema, [o]);
  }
  const estaciones: Estacion[] = [];
  for (const [idema, registros] of grupos) {
    // Una lectura por hora (si se repite, la última del archivo) y como mucho las 24 más recientes
    const porHora = new Map<number, ObsAemet>();
    for (const o of registros) porHora.set(msFint(o.fint), o);
    const ordenadas = [...porHora.entries()].sort((a, b) => a[0] - b[0]);
    const ultimaMs = ordenadas.at(-1)?.[0] ?? Number.NaN;
    const serie = ordenadas.filter(([ms]) => ms > ultimaMs - 24 * 3_600_000).map(([, o]) => aLectura(o));
    const base = ordenadas.at(-1)![1];
    const ultima = serie.at(-1) ?? null;
    const conPrec = serie.filter((l) => l.prec != null);
    const rachaMax = extremo(serie, (l) => l.racha, true);
    const hace3h = ultima ? serie.find((l) => Date.parse(l.fint) === Date.parse(ultima.fint) - 3 * 3_600_000) : undefined;
    const edadMin = ultima ? (ahora.getTime() - Date.parse(ultima.fint)) / 60_000 : Number.POSITIVE_INFINITY;
    estaciones.push({
      idema,
      nombre: NOMBRES[idema] ?? nombreLegible(base.ubi ?? idema),
      ubi: base.ubi ?? idema,
      lat: base.lat,
      lon: base.lon,
      alt: base.alt,
      municipio: municipioDe(base.lat, base.lon),
      serie,
      ultima,
      horas: serie.length,
      edadMin,
      atrasada: edadMin > MINUTOS_ATRASO,
      tempMax24: extremo(serie, (l) => l.tempMax ?? l.temp, true),
      tempMin24: extremo(serie, (l) => l.tempMin ?? l.temp, false),
      rachaMax24: rachaMax ? { ...rachaMax, dir: serie.find((l) => l.fint === rachaMax.fint)?.dirRacha ?? null } : null,
      prec24: conPrec.length ? r1(conPrec.reduce((s, l) => s + (l.prec ?? 0), 0)) : null,
      horasPrec: conPrec.length,
      presTendencia3h: ultima?.pres != null && hace3h?.pres != null ? r1(ultima.pres - hace3h.pres) : null,
    });
  }
  return estaciones.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** Estación por indicativo AEMET. */
export const getEstacion = (idema: string, ahora: Date = new Date()) => getEstaciones(ahora).find((e) => e.idema === idema);

/** Estaciones dentro del término de un municipio (o asignadas a él por cercanía). */
export const estacionesDeMunicipio = (id: string, estaciones: Estacion[] = getEstaciones()) => estaciones.filter((e) => e.municipio?.id === id);

// ---------------------------------------------------------------------------------------------
// Resumen de la provincia
// ---------------------------------------------------------------------------------------------

function extremoProvincia(
  estaciones: Estacion[],
  valor: (e: Estacion) => (ValorHora & { dir?: number | null }) | null,
  mayor: boolean
): ExtremoProvincia | null {
  let mejor: ExtremoProvincia | null = null;
  for (const e of estaciones) {
    const v = valor(e);
    if (!v) continue;
    if (!mejor || (mayor ? v.valor > mejor.valor : v.valor < mejor.valor)) mejor = { ...v, estacion: { idema: e.idema, nombre: e.nombre } };
  }
  return mejor;
}

/** Máximos y mínimos de la provincia en 24 h y antigüedad del dato. */
export function resumenObservaciones(estaciones: Estacion[] = getEstaciones(), ahora: Date = new Date()): ResumenObservaciones {
  const fints = estaciones.flatMap((e) => e.serie.map((l) => Date.parse(l.fint)));
  const ultimoMs = fints.length ? Math.max(...fints) : Number.NaN;
  const primeroMs = fints.length ? Math.min(...fints) : Number.NaN;
  const recientes = estaciones.filter((e) => !e.atrasada);
  const tempUltima = (e: Estacion): ValorHora | null =>
    e.ultima?.temp != null ? { valor: e.ultima.temp, hora: e.ultima.hora, fint: e.ultima.fint } : null;
  return {
    actualizado: getMeta().fuentes.observaciones?.actualizado ?? null,
    ultimoDato: Number.isFinite(ultimoMs) ? new Date(ultimoMs).toISOString() : null,
    edadMin: Number.isFinite(ultimoMs) ? (ahora.getTime() - ultimoMs) / 60_000 : Number.POSITIVE_INFINITY,
    estaciones: estaciones.length,
    conDatoReciente: recientes.length,
    horasCubiertas: Number.isFinite(ultimoMs) ? Math.min(24, Math.round((ultimoMs - primeroMs) / 3_600_000) + 1) : 0,
    tempMax: extremoProvincia(estaciones, (e) => e.tempMax24, true),
    tempMin: extremoProvincia(estaciones, (e) => e.tempMin24, false),
    rachaMax: extremoProvincia(estaciones, (e) => e.rachaMax24, true),
    precMax: extremoProvincia(
      estaciones,
      (e) => (e.prec24 != null && e.prec24 > 0 && e.ultima ? { valor: e.prec24, hora: e.ultima.hora, fint: e.ultima.fint } : null),
      true
    ),
    tempAhoraMax: extremoProvincia(recientes, tempUltima, true),
    tempAhoraMin: extremoProvincia(recientes, tempUltima, false),
  };
}

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------

/** "hace 25 min", "hace 1 h", "hace 2 h 10 min", "hace más de un día"; "sin datos" si no hay lectura. */
export function textoAntiguedad(minutos: number): string {
  if (!Number.isFinite(minutos)) return "sin datos";
  const m = Math.max(0, Math.round(minutos));
  if (m < 60) return `hace ${m} min`;
  if (m >= 1440) return "hace más de un día";
  const h = Math.floor(m / 60);
  const resto = m % 60;
  return resto ? `hace ${h} h ${resto} min` : `hace ${h} h`;
}

/** Hora local "11:00" de una lectura. */
export const horaCorta = (l: Pick<Lectura, "hora"> | null | undefined) => (l ? l.hora.slice(11, 16) : "—");
