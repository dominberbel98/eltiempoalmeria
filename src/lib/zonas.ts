// Zonas de predicción dentro de cada municipio (Open-Meteo, una por celda del modelo). Solo se ejecuta en el build.
// Definiciones: scripts/zonas-almeria.json (versionado). Datos: src/data/zonas/{municipio}.json (scripts/fuentes/zonas.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  celdasVoronoi,
  escalaLon,
  geoMulti,
  indiceMasCercano,
  mascara,
  terminoMunicipio,
  type ColeccionCeldas,
  type GeoMultiPolygon,
} from "./geozonas";
import { horaLocal } from "./tiempo";

export type TipoZona = "capital" | "nucleo" | "terreno";

export type ZonaDef = {
  id: string; // codine del núcleo o "T{municipio}-{n}"
  municipio: string;
  nombre: string;
  tipo: TipoZona;
  lat: number;
  lon: number;
  altitud: number; // la que se pasa a Open-Meteo en elevation
  celda: { lat: number; lon: number };
  poblacion: number | null;
  nucleos: string[]; // codines de los núcleos que el buscador lleva a esta zona
};

export type Serie = (number | null)[];
export type SerieZona = { temp: Serie; hr: Serie; precip: Serie; prob: Serie; wc: Serie; viento: Serie; dir: Serie; racha: Serie; cape: Serie; nieve: Serie };

export type ArchivoZonas = {
  municipio: string;
  actualizado: string;
  pasada: string | null;
  horas: string[];
  ultimaHoraDetalle: string;
  zonas: { id: string; serie: SerieZona }[];
};

export type Tormenta = "no" | "posible" | "prevista";

export type DiaZona = {
  fecha: string; // "2026-10-31"
  min: number | null;
  max: number | null;
  racha: number | null;
  lluvia: number | null; // mm
  probMax: number | null; // %
  tormenta: Tormenta;
  helada: boolean;
  horasHelada: number;
  calor: boolean; // máxima ≥ 35 °C
  nieve: number | null; // cm
};

export type HorasZona = { temp: Serie; precip: Serie; prob: Serie; viento: Serie; dir: Serie; racha: Serie; wc: Serie; cape: Serie };

export type ZonaEndpoint = {
  id: string;
  nombre: string;
  tipo: TipoZona;
  altitud: number;
  poblacion: number | null;
  lat: number;
  lon: number;
  horas: HorasZona;
  dias: DiaZona[];
};

/**
 * Núcleo de población que el buscador lleva a una zona cuyo polígono del mapa no lo contiene: comparte celda del
 * modelo con esa zona (misma previsión), pero en el mapa cae en la celda de otra (zonaMapa).
 */
export type NucleoDesplazado = { id: string; nombre: string; lat: number; lon: number; zona: string; zonaMapa: string };

/** Formato de /zonas/{slug}.json */
export type EndpointZonas = {
  municipio: { id: string; slug: string; nombre: string };
  actualizado: string | null;
  pasada: string | null;
  horas: string[];
  dias: string[];
  /** Si dias[0] es hoy y solo se resumen las horas que quedan: la primera de ellas ("17:00"). Si no, null. */
  desdeHoy: string | null;
  nucleos: NucleoDesplazado[];
  contorno: GeoMultiPolygon;
  mascara: GeoMultiPolygon;
  celdas: ColeccionCeldas;
  zonas: ZonaEndpoint[];
};

export const MIN_HORAS_DIA = 18;
/** Hoy se resume con las horas que quedan si son al menos estas (tormenta, lluvia, rachas y helada de esta tarde o esta noche). */
export const MIN_HORAS_HOY = 6;
export const MAX_DIAS = 5;
export const MAX_HORAS = 78;
/** ICON-EU es horario hasta +78 h desde el inicio de la pasada; después, cada 3 h (Open-Meteo interpola). */
export const HORAS_DETALLE_ICON = 78;
const CAPE_TORMENTA = 800; // J/kg
const PROB_TORMENTA = 30; // %
const UMBRAL_CALOR = 35; // °C

const RUTA_DEFS = path.resolve("scripts/zonas-almeria.json");
const DIR_DATOS = path.resolve("src/data/zonas");

// ---------- Lectura ----------

let cacheDefs: ZonaDef[] | null = null;

export function getZonasDef(): ZonaDef[] {
  if (cacheDefs) return cacheDefs;
  try {
    const lista = JSON.parse(readFileSync(RUTA_DEFS, "utf8")) as ZonaDef[];
    cacheDefs = Array.isArray(lista) ? lista : [];
  } catch {
    cacheDefs = [];
  }
  return cacheDefs;
}

export function zonasDeMunicipio(municipioId: string): ZonaDef[] {
  return getZonasDef().filter((z) => z.municipio === municipioId);
}

/** El municipio tiene vista por zonas (al menos 2 zonas). */
export function tieneVistaZonas(municipioId: string): boolean {
  return zonasDeMunicipio(municipioId).length >= 2;
}

/** codine de núcleo → id de zona (para el buscador). */
export function indiceNucleos(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const z of getZonasDef()) for (const n of z.nucleos) mapa.set(n, z.id);
  return mapa;
}

const cacheArchivos = new Map<string, ArchivoZonas | null>();

export function getArchivoZonas(municipioId: string): ArchivoZonas | null {
  if (cacheArchivos.has(municipioId)) return cacheArchivos.get(municipioId)!;
  let archivo: ArchivoZonas | null = null;
  const ruta = path.join(DIR_DATOS, `${municipioId}.json`);
  if (existsSync(ruta)) {
    try {
      const j = JSON.parse(readFileSync(ruta, "utf8")) as ArchivoZonas;
      if (Array.isArray(j?.horas) && Array.isArray(j?.zonas) && typeof j.ultimaHoraDetalle === "string") archivo = j;
    } catch {
      archivo = null;
    }
  }
  cacheArchivos.set(municipioId, archivo);
  return archivo;
}

// ---------- Resúmenes diarios ----------

const valido = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = (n: number) => Math.round(n);

function resumirDia(fecha: string, s: SerieZona | undefined, indices: number[]): DiaZona {
  const vals = (serie: Serie | undefined) => indices.map((i) => serie?.[i]).filter(valido);
  const temps = vals(s?.temp);
  const rachas = vals(s?.racha);
  const lluvias = vals(s?.precip);
  const probs = vals(s?.prob);
  const nieves = vals(s?.nieve);
  let tormenta: Tormenta = "no";
  for (const i of indices) {
    const wc = s?.wc[i];
    if (valido(wc) && wc >= 95) {
      tormenta = "prevista";
      break;
    }
    const cape = s?.cape[i];
    const prob = s?.prob[i];
    if (valido(cape) && valido(prob) && cape >= CAPE_TORMENTA && prob >= PROB_TORMENTA) tormenta = "posible";
  }
  const min = temps.length ? r1(Math.min(...temps)) : null;
  const max = temps.length ? r1(Math.max(...temps)) : null;
  const horasHelada = temps.filter((t) => t <= 0).length;
  return {
    fecha,
    min,
    max,
    racha: rachas.length ? r0(Math.max(...rachas)) : null,
    lluvia: lluvias.length ? r1(lluvias.reduce((a, b) => a + b, 0)) : null,
    probMax: probs.length ? r0(Math.max(...probs)) : null,
    tormenta,
    helada: horasHelada > 0,
    horasHelada,
    calor: max != null && max >= UMBRAL_CALOR,
    nieve: nieves.length ? r1(nieves.reduce((a, b) => a + b, 0)) : null,
  };
}

export type ResumenDiario = {
  dias: string[];
  porZona: Map<string, DiaZona[]>;
  /** Si dias[0] es hoy resumido solo con las horas que quedan: la primera ("17:00"). Si no, null. */
  desdeHoy: string | null;
};

/**
 * Días con al menos MIN_HORAS_DIA horas de detalle (hasta ultimaHoraDetalle), desde hoy y como mucho MAX_DIAS,
 * y su resumen por zona. Con `hoyParcial`, si hoy no llega a MIN_HORAS_DIA (la serie empieza a la hora de la descarga)
 * pero le quedan al menos MIN_HORAS_HOY, hoy se resume con las horas que quedan desde `ahora` (desdeHoy). Sirve para
 * tormenta, lluvia, rachas y helada de esta tarde o esta noche; la mínima y la máxima de ese resumen no son las del día.
 */
export function resumenDiario(archivo: ArchivoZonas, ahora = new Date(), { hoyParcial = false } = {}): ResumenDiario {
  const desde = horaLocal(ahora);
  const hoy = desde.slice(0, 10);
  const indicesPorDia = new Map<string, number[]>();
  archivo.horas.forEach((t, i) => {
    if (t > archivo.ultimaHoraDetalle) return;
    const f = t.slice(0, 10);
    if (!indicesPorDia.has(f)) indicesPorDia.set(f, []);
    indicesPorDia.get(f)!.push(i);
  });
  let desdeHoy: string | null = null;
  const hoyIdx = indicesPorDia.get(hoy) ?? [];
  if (hoyParcial && hoyIdx.length < MIN_HORAS_DIA) {
    const quedan = hoyIdx.filter((i) => archivo.horas[i] >= desde);
    if (quedan.length >= MIN_HORAS_HOY) {
      indicesPorDia.set(hoy, quedan);
      desdeHoy = archivo.horas[quedan[0]].slice(11, 16);
    }
  }
  const dias = [...indicesPorDia.entries()]
    .filter(([f, idx]) => f >= hoy && (idx.length >= MIN_HORAS_DIA || (f === hoy && desdeHoy != null)))
    .map(([f]) => f)
    .sort()
    .slice(0, MAX_DIAS);
  if (dias[0] !== hoy) desdeHoy = null;
  const series = new Map(archivo.zonas.map((z) => [z.id, z.serie]));
  const porZona = new Map<string, DiaZona[]>();
  for (const z of zonasDeMunicipio(archivo.municipio)) {
    porZona.set(z.id, dias.map((f) => resumirDia(f, series.get(z.id), indicesPorDia.get(f)!)));
  }
  return { dias, porZona, desdeHoy };
}

// ---------- Frases de diferencias ----------

const fmtT = (n: number) => `${Math.round(n) < 0 ? "−" : ""}${Math.abs(Math.round(n))} °C`;
/** Con un decimal cerca de 0 °C ("−0,5 °C"), sin decimales si es entero. */
const fmtT1 = (n: number) => {
  const v = Math.round(n * 10) / 10;
  if (Math.abs(v) >= 1 || v === 0) return fmtT(v);
  return `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
};
const fmtMm = (n: number) => `${n >= 10 ? Math.round(n) : n.toLocaleString("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: n % 1 ? 1 : 0 })} mm`;

/** "el sábado 31" */
export function fechaEnFrase(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return `el ${d.toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

const mayuscula = (s: string) => s.charAt(0).toLocaleUpperCase("es") + s.slice(1);
const ARTICULO: Record<string, string> = { sierra: "la", costa: "la", interior: "el", alrededores: "los", vega: "la", valle: "el", llano: "el" };

/** Nombre de la zona dentro de una frase: "San José", "la sierra al noroeste", "la costa al sur". */
export function nombreEnFrase(z: ZonaDef, todas: ZonaDef[] = []): string {
  if (z.tipo !== "terreno") return z.nombre;
  const base = (x: ZonaDef) => x.nombre.replace(/\s*\([^)]*\)\s*$/, "");
  const ambiguo = todas.some((o) => o.id !== z.id && o.tipo === "terreno" && base(o) === base(z));
  const texto = ambiguo ? z.nombre : base(z);
  const [primera, ...resto] = texto.split(" ");
  const p = primera.toLocaleLowerCase("es");
  return [ARTICULO[p] ?? "la", p, ...resto].join(" ");
}

/** "A", "A y B", "A, B y 3 zonas más" */
function lista(nombres: string[], max = 2): string {
  if (nombres.length <= max) return nombres.length <= 1 ? (nombres[0] ?? "") : `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}`;
  const resto = nombres.length - max;
  return `${nombres.slice(0, max).join(", ")} y ${resto === 1 ? "otra zona" : `otras ${resto} zonas`}`;
}

/** Como lista(), pero si son el resto exacto de zonas y más de 2, "el resto del término". */
function listaResto(nombres: string[], esResto: boolean): string {
  return esResto && nombres.length > 2 ? "el resto del término" : lista(nombres);
}

type Candidata = { tipo: string; dia: number; puntos: number; frase: string };
const PESO_DIA = [1, 1, 0.9, 0.8, 0.7];
const ORDEN_TIPO = ["helada", "min", "max", "racha", "lluvia", "tormenta"];

/**
 * Cuándo, para las frases: "el sábado 31" o, si hoy solo cuenta desde una hora, "hoy", "esta tarde y esta noche"
 * o "esta noche". `de`: "del sábado 31", "de hoy", "de esta noche".
 */
function cuandoEnFrase(fecha: string, desdeHoy: string | null): { cuando: string; de: string } {
  if (desdeHoy == null) {
    const cuando = fechaEnFrase(fecha);
    return { cuando, de: cuando.replace(/^el /, "del ") };
  }
  const h = Number(desdeHoy.slice(0, 2));
  const cuando = h < 13 ? "hoy" : h < 20 ? "esta tarde y esta noche" : "esta noche";
  return { cuando, de: `de ${cuando}` };
}

function candidatasDelDia(defs: ZonaDef[], dias: DiaZona[][], j: number, fecha: string, desdeHoy: string | null = null): Candidata[] {
  const salida: Candidata[] = [];
  const nombre = (k: number) => nombreEnFrase(defs[k], defs);
  const zonas = defs.map((_, k) => k).filter((k) => dias[k]?.[j]);
  const d = (k: number) => dias[k][j];
  const { cuando, de } = cuandoEnFrase(fecha, desdeHoy);
  const Cuando = mayuscula(cuando);
  // Hoy desde una hora: la mínima y la máxima de las horas que quedan no son las del día; no se comparan
  const parcial = desdeHoy != null;
  const extremos = (campo: "min" | "max" | "racha") => {
    const con = zonas.filter((k) => valido(d(k)[campo]));
    if (con.length < 2) return null;
    const lo = con.reduce((a, b) => (d(b)[campo]! < d(a)[campo]! ? b : a));
    const hi = con.reduce((a, b) => (d(b)[campo]! > d(a)[campo]! ? b : a));
    return { lo, hi, rango: d(hi)[campo]! - d(lo)[campo]! };
  };

  // Puntuación: los contrastes de helada, tormenta y lluvia pesan más que los rangos de temperatura,
  // que casi siempre existen entre la sierra y el pueblo.
  // Heladas en unas zonas y no en otras
  const conHelada = zonas.filter((k) => d(k).helada);
  const sinHelada = zonas.filter((k) => !d(k).helada && valido(d(k).min));
  if (conHelada.length && sinHelada.length) {
    const orden = [...conHelada].sort((a, b) => d(a).min! - d(b).min!);
    const resto = [...sinHelada].sort((a, b) => d(b).min! - d(a).min!);
    salida.push({
      tipo: "helada",
      dia: j,
      puntos: 4 + Math.min(1, Math.max(...conHelada.map((k) => d(k).horasHelada)) / 10),
      frase: `${Cuando} helará en ${lista(orden.map((k) => `${nombre(k)} (${fmtT1(d(k).min!)})`))}, pero no en ${listaResto(resto.map(nombre), resto.length + conHelada.length === zonas.length)}.`,
    });
  }
  // Tormenta en unas zonas y no en otras
  const prevista = zonas.filter((k) => d(k).tormenta === "prevista");
  const posible = zonas.filter((k) => d(k).tormenta === "posible");
  const sin = zonas.filter((k) => d(k).tormenta === "no");
  if ((prevista.length || posible.length) && sin.length) {
    const resto = listaResto(sin.map(nombre), true);
    const frase = prevista.length
      ? `${Cuando} se prevén tormentas en ${lista(prevista.map(nombre))}${posible.length ? ` y podría haberlas en ${lista(posible.map(nombre))}` : ""}; en ${resto}, no.`
      : `${Cuando} podría haber tormenta en ${lista(posible.map(nombre))}, pero no en ${resto}.`;
    salida.push({ tipo: "tormenta", dia: j, puntos: prevista.length ? 3.8 : 3.2, frase });
  }
  // Lluvia en unas zonas (≥1 mm) y casi nada en otras (<0,2 mm)
  const mojadas = zonas.filter((k) => valido(d(k).lluvia) && d(k).lluvia! >= 1).sort((a, b) => d(b).lluvia! - d(a).lluvia!);
  const secas = zonas.filter((k) => valido(d(k).lluvia) && d(k).lluvia! < 0.2);
  if (mojadas.length && secas.length) {
    salida.push({
      tipo: "lluvia",
      dia: j,
      puntos: 3 + Math.min(1, d(mojadas[0]).lluvia! / 10),
      frase: `${Cuando} solo lloverá en parte del término: ${lista(mojadas.map((k) => `${fmtMm(d(k).lluvia!)} en ${nombre(k)}`))}; en ${listaResto(secas.map(nombre), mojadas.length + secas.length === zonas.length)}, nada o casi nada.`,
    });
  }
  // Rango de mínimas y de máximas (≥3 °C)
  for (const campo of parcial ? [] : (["min", "max"] as const)) {
    const e = extremos(campo);
    if (e && e.rango >= 3 && Math.round(d(e.hi)[campo]!) !== Math.round(d(e.lo)[campo]!)) {
      salida.push({
        tipo: campo,
        dia: j,
        puntos: Math.min(2.5, 1 + (e.rango - 3) / 4),
        frase: `${Cuando} la ${campo === "min" ? "mínima" : "máxima"} irá de ${fmtT(d(e.lo)[campo]!)} en ${nombre(e.lo)} a ${fmtT(d(e.hi)[campo]!)} en ${nombre(e.hi)}.`,
      });
    }
  }
  // Rachas máximas (≥15 km/h de diferencia)
  const e = extremos("racha");
  if (e && e.rango >= 15) {
    salida.push({
      tipo: "racha",
      dia: j,
      puntos: Math.min(2.5, 1 + (e.rango - 15) / 10),
      frase: `Las rachas más fuertes ${de}, ${d(e.hi).racha} km/h, serán en ${nombre(e.hi)}; en ${nombre(e.lo)}, ${d(e.lo).racha} km/h.`,
    });
  }
  return salida;
}

/**
 * Hasta 3 frases sobre las diferencias relevantes entre zonas del municipio en los próximos días.
 * [] si el municipio tiene menos de 2 zonas, si no hay datos o si el tiempo será parecido en todo el término.
 */
export function diferencias(municipioId: string, ahora = new Date()): string[] {
  const defs = zonasDeMunicipio(municipioId);
  const archivo = getArchivoZonas(municipioId);
  if (defs.length < 2 || !archivo) return [];
  const { dias, porZona, desdeHoy } = resumenDiario(archivo, ahora, { hoyParcial: true });
  const tabla = defs.map((z) => porZona.get(z.id) ?? []);
  // La mejor ocasión de cada tipo de diferencia (más marcada y más cercana)
  const mejores = new Map<string, Candidata & { valor: number }>();
  dias.forEach((fecha, j) => {
    for (const c of candidatasDelDia(defs, tabla, j, fecha, j === 0 ? desdeHoy : null)) {
      const valor = c.puntos * (PESO_DIA[j] ?? 0.6);
      const actual = mejores.get(c.tipo);
      if (!actual || valor > actual.valor) mejores.set(c.tipo, { ...c, valor });
    }
  });
  // La helada ya cuenta la diferencia de mínimas de ese día
  const helada = mejores.get("helada");
  if (helada && mejores.get("min")?.dia === helada.dia) mejores.delete("min");
  return [...mejores.values()]
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 3)
    .sort((a, b) => a.dia - b.dia || ORDEN_TIPO.indexOf(a.tipo) - ORDEN_TIPO.indexOf(b.tipo))
    .map((c) => c.frase);
}

// ---------- Endpoint /zonas/{slug}.json ----------

const redondeo = {
  temp: (v: number) => r1(v),
  precip: (v: number) => r1(v),
  prob: r0,
  viento: r0,
  dir: r0,
  racha: r0,
  wc: r0,
  cape: (v: number) => Math.round(v / 10) * 10,
} satisfies Record<keyof HorasZona, (v: number) => number>;

/**
 * Objeto completo de /zonas/{slug}.json: contorno del término, máscara, celdas de Voronoi y, por zona,
 * las horas (desde la hora actual hasta ultimaHoraDetalle, máx. 78) y el resumen de los días con detalle.
 * Sin datos de zonas devuelve la geometría con horas y días vacíos. null si el municipio no tiene zonas o término.
 */
export function construirZonasEndpoint(municipio: { id: string; slug: string; nombre: string }, ahora = new Date()): EndpointZonas | null {
  const defs = zonasDeMunicipio(municipio.id);
  const termino = terminoMunicipio(municipio.id);
  if (!defs.length || !termino) return null;
  const archivo = getArchivoZonas(municipio.id);
  const desde = horaLocal(ahora);
  // Horas con detalle horario real: hasta ultimaHoraDetalle y como mucho la pasada + 78 h (después ICON-EU va cada 3 h)
  const finPasada = archivo?.pasada ? Date.parse(archivo.pasada) + HORAS_DETALLE_ICON * 3_600_000 : Number.NaN;
  const hasta = archivo
    ? Number.isFinite(finPasada)
      ? [archivo.ultimaHoraDetalle, horaLocal(new Date(finPasada))].sort()[0]
      : archivo.ultimaHoraDetalle
    : "";
  const indices: number[] = [];
  archivo?.horas.forEach((t, i) => {
    if (t >= desde && t <= hasta && indices.length < MAX_HORAS) indices.push(i);
  });
  const resumen: ResumenDiario = archivo
    ? resumenDiario(archivo, ahora, { hoyParcial: true })
    : { dias: [], porZona: new Map<string, DiaZona[]>(), desdeHoy: null };
  const series = new Map((archivo?.zonas ?? []).map((z) => [z.id, z.serie]));
  return {
    municipio: { id: municipio.id, slug: municipio.slug, nombre: municipio.nombre },
    actualizado: archivo?.actualizado ?? null,
    pasada: archivo?.pasada ?? null,
    horas: indices.map((i) => archivo!.horas[i]),
    dias: resumen.dias,
    desdeHoy: resumen.desdeHoy,
    nucleos: nucleosDesplazados(municipio.id),
    contorno: geoMulti(termino),
    mascara: geoMulti(mascara(termino)),
    celdas: celdasVoronoi(termino, defs),
    zonas: defs.map((z) => {
      const s = series.get(z.id);
      const horas = Object.fromEntries(
        (Object.keys(redondeo) as (keyof HorasZona)[]).map((k) => [
          k,
          indices.map((i) => {
            const v = s?.[k]?.[i];
            return valido(v) ? redondeo[k](v) : null;
          }),
        ])
      ) as HorasZona;
      return {
        id: z.id,
        nombre: z.nombre,
        tipo: z.tipo,
        altitud: z.altitud,
        poblacion: z.poblacion,
        lat: z.lat,
        lon: z.lon,
        horas,
        dias: resumen.porZona.get(z.id) ?? [],
      };
    }),
  };
}

// ---------- Núcleos que el buscador lleva a una zona de otra celda del mapa ----------

type NucleoDef = { id: string; municipio: string; nombre: string; lat: number; lon: number };
let cacheNucleos: NucleoDef[] | null = null;

function getNucleos(): NucleoDef[] {
  if (cacheNucleos) return cacheNucleos;
  try {
    const lista = JSON.parse(readFileSync(path.resolve("scripts/nucleos-almeria.json"), "utf8")) as NucleoDef[];
    cacheNucleos = Array.isArray(lista) ? lista : [];
  } catch {
    cacheNucleos = [];
  }
  return cacheNucleos;
}

const cacheDesplazados = new Map<string, NucleoDesplazado[]>();

/**
 * Núcleos del municipio que el buscador lleva a una zona (la de su celda del modelo, con la misma previsión) cuyo
 * polígono del mapa no los contiene: en el mapa caen en la celda de Voronoi de otra zona. La vista por zonas lo explica
 * y marca el núcleo cuando se llega desde el buscador (?nucleo=).
 */
export function nucleosDesplazados(municipioId: string): NucleoDesplazado[] {
  const enCache = cacheDesplazados.get(municipioId);
  if (enCache) return enCache;
  const defs = zonasDeMunicipio(municipioId);
  const termino = defs.length >= 2 ? terminoMunicipio(municipioId) : null;
  const salida: NucleoDesplazado[] = [];
  if (termino) {
    const k = escalaLon(termino);
    const zonaDe = new Map(defs.flatMap((z) => z.nucleos.map((n) => [n, z.id] as const)));
    for (const n of getNucleos()) {
      if (n.municipio !== municipioId) continue;
      const zona = zonaDe.get(n.id);
      if (!zona || zona === n.id) continue;
      const zonaMapa = defs[indiceMasCercano(n.lon, n.lat, defs, k)]?.id;
      if (zonaMapa && zonaMapa !== zona) salida.push({ id: n.id, nombre: n.nombre, lat: n.lat, lon: n.lon, zona, zonaMapa });
    }
  }
  cacheDesplazados.set(municipioId, salida);
  return salida;
}
