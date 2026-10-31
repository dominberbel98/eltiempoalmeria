// scripts/fuentes/ria.ts
// Red de Información Agroclimática de Andalucía (RIA, IFAPA): estaciones de Almería -> src/data/agro.json.
// API pública sin clave (Swagger en https://www.juntadeandalucia.es/agriculturaypesca/ifapa/riaws/swagger-ui.html).
// Solo hay datos diarios y mensuales; el día D aparece en D+1 hacia las 09:30 hora de Madrid, con cargas
// irregulares (domingos y lunes muchas veces no hay) y reescribiendo días anteriores, por eso se piden siempre
// los últimos 400 días. Nunca se usa datosdiarios/.../true: da HTTP 500 en todo el rango si un día no tiene
// radiación o humedad. Se usa datosdiarios/forceEt0 (et0 = null en esos días).
// TTL 3 h; si falta el día de ayer pasadas las 08:30 UTC se sondea con una petición pequeña en cada ejecución.
// Nunca lanza: ante un fallo conserva el agro.json anterior (o los datos anteriores de la estación que falle).

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos";

const BASE = "https://www.juntadeandalucia.es/agriculturaypesca/ifapa/riaws";
const PROVINCIA = 4; // Almería
const DIAS_HISTORICO = 400;
const DIAS_GUARDADOS = 30;
const TTL_MS = 3 * 3600_000;
const MINUTO_UTC_PUBLICACION = 8 * 60 + 30; // 08:30 UTC
const TIMEOUT_MS = 20_000;
const ESPERAS_REINTENTO = [2_000, 5_000];
const PAUSA_MS = 200;
const AVISO_ALTITUD_M = 300;
const AVISO_DISTANCIA_KM = 20;
const USER_AGENT = "eltiempoalmeria.es (+https://eltiempoalmeria.es)";

export const ATRIBUCION_RIA =
  "Datos agroclimáticos: Red de Información Agroclimática de Andalucía (RIA), IFAPA, Junta de Andalucía. Información obtenida del Portal IFAPA.";

// ---------------------------------------------------------------------------------------------
// Contrato de src/data/agro.json
// ---------------------------------------------------------------------------------------------

export type EstadoEstacion = "ok" | "retrasada" | "sin-datos";

/** Un día medido. Unidades: °C, %, m/s (mástil de 2 m), grados, MJ/m²·día, mm, mm/día. null = sin dato válido. */
export type DiaRia = {
  fecha: string; // "YYYY-MM-DD"
  tMax: number | null;
  tMin: number | null;
  tMed: number | null;
  hrMed: number | null;
  hrMin: number | null;
  hrMax: number | null;
  viento: number | null; // velocidad media diaria, m/s
  vientoMax: number | null; // velocidad máxima diaria (racha), m/s
  dirViento: number | null;
  radiacion: number | null;
  precip: number | null;
  et0: number | null; // Penman-Monteith calculada por el servicio RIA (forceEt0)
};

/** Acumulados que terminan en `referencia` (último día con datos de la red), ventanas de 7 y 30 días. */
export type AcumuladosRia = {
  referencia: string | null;
  diasConDatos_7d: number;
  diasConDatos_30d: number;
  diasConEt0_7d: number;
  diasConEt0_30d: number;
  diasConPrecip_7d: number;
  diasConPrecip_30d: number;
  et0_7d: number | null;
  et0_30d: number | null;
  precip_7d: number | null;
  precip_30d: number | null;
  balance_7d: number | null; // precip_7d − et0_7d
  balance_30d: number | null;
  tMax_7d: number | null; // máxima absoluta
  tMax_30d: number | null;
  tMin_7d: number | null; // mínima absoluta
  tMin_30d: number | null;
  vientoMax_7d: number | null; // racha máxima, m/s
  vientoMax_30d: number | null;
  diasHelada_7d: number; // tMin ≤ 0 °C
  diasHelada_30d: number;
  diasCalor_7d: number; // tMax ≥ 35 °C
  diasCalor_30d: number;
  gradosDia10_30d: number | null; // Σ max(0, tMed − 10)
  et0_mes: number | null; // mes de `referencia`, hasta `referencia`
  precip_mes: number | null;
  diasConEt0_mes: number;
  et0_anioHidro: number | null; // desde el 1 de octubre
  precip_anioHidro: number | null;
  diasConEt0_anioHidro: number;
  diasConPrecip_anioHidro: number;
};

export type MesRia = {
  anyo: number;
  mes: number; // 1-12
  numDias: number | null; // días que cubre el dato mensual de IFAPA (más completo que los diarios)
  tMed: number | null;
  tMax: number | null;
  tMin: number | null;
  hrMed: number | null;
  viento: number | null; // m/s
  vientoMax: number | null; // m/s
  precip: number | null;
  radiacion: number | null;
  et0: number | null; // suma de la et0 diaria (el mensual de IFAPA no la trae)
  diasConEt0: number;
  parcial: boolean; // la et0 no cubre todos los días del mes (o del mes en curso hasta la referencia)
  fuente: "mensual" | "diario"; // de dónde salen tMed..radiacion
};

export type EstacionRia = {
  codigo: string;
  nombre: string; // para mostrar
  nombreRia: string; // tal cual la RIA
  municipioId: string | null; // código INE del municipio donde está
  lat: number;
  lon: number;
  altitud: number;
  bajoPlastico: boolean;
  estado: EstadoEstacion;
  ultimoDia: string | null;
  retrasoDias: number | null; // días entre hoy (Madrid) y ultimoDia
  ultimaModificacion: string | null; // fechaUtlMod más reciente (ISO con offset)
  conservada?: boolean; // true si esta vez falló la descarga y son los datos de la vez anterior
  ultimo: DiaRia | null;
  dias: DiaRia[]; // últimos 30 días hasta ultimoDia, en orden
  acumulados: AcumuladosRia;
  mensual: MesRia[]; // últimos 13 meses
};

export type ReferenciaMunicipio = {
  estacion: string; // estación activa más cercana (haversine)
  distanciaKm: number;
  difAltitud: number; // altitud del municipio − altitud de la estación, m
  aviso: boolean; // |difAltitud| > 300 m o distancia > 20 km: no es representativa
  estacionConDatos?: string; // si la más cercana está sin datos, la más cercana que sí tiene
  distanciaConDatosKm?: number;
  difAltitudConDatos?: number;
};

export type AgroJson = {
  updatedAt: string; // ISO UTC de la descarga
  hoy: string; // fecha de Madrid usada para estados y retrasos
  fuente: { nombre: string; url: string; licencia: string; atribucion: string };
  ultimaCargaRia: string | null;
  ultimoDiaDisponible: string | null;
  fallos: { codigo: string; motivo: string }[];
  estaciones: EstacionRia[];
  municipios: Record<string, ReferenciaMunicipio>;
};

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIA_MS = 86_400_000;
const fechaMadrid = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const sumarDias = (f: string, n: number) => new Date(Date.parse(`${f}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (desde: string, hasta: string) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
const diasDelMes = (anyo: number, mes: number) => new Date(Date.UTC(anyo, mes, 0)).getUTCDate();
const redondear = (v: number | null, d: number) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Valor numérico dentro de [min, max] o null. Nunca convierte null en 0. */
function valido(v: unknown, min: number, max: number): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** "364714000N" (DDMMSSsss) o "025932000W" (DDDMMSSsss) -> grados decimales */
export function coordenadaRia(s: unknown): number | null {
  const m = /^(\d+)([NSEW])$/i.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = m[1];
  const g = d.length - 7; // dígitos de los grados
  if (g < 1) return null;
  const grados = +d.slice(0, g) + +d.slice(g, g + 2) / 60 + (+d.slice(g + 2, g + 4) + +d.slice(g + 4) / 1000) / 3600;
  return /[SW]/i.test(m[2]) ? -grados : grados;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** "2026-10-28T09:31:00.000+0100" -> "2026-10-28T09:31:00.000+01:00" */
const isoOffset = (s: unknown) => (typeof s === "string" && s ? s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2") : null);

// Municipio de cada estación (cruce punto en polígono verificado en la investigación). Las nuevas se asignan al más cercano.
const MUNICIPIO_ESTACION: Record<string, string> = {
  "1": "04903",
  "2": "04013",
  "3": "04066",
  "4": "04088",
  "5": "04045",
  "6": "04035",
  "7": "04053",
  "8": "04035",
  "9": "04092",
  "10": "04003",
  "11": "04066",
  "12": "04092",
};
const NOMBRE_MOSTRAR: Record<string, string> = {
  "6": "Virgen de Fátima (Cuevas del Almanzora)",
  "8": "Cuevas del Almanzora",
};

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

type Respuesta = { status: number; json: unknown; texto: string };

/** GET con timeout y 2 reintentos (2 y 5 s) ante 5xx o error de red. Lee texto y parsea aparte:
 *  los errores llegan en texto plano aunque la cabecera diga application/json. */
/** tipo "red": sin respuesta (caída, DNS, timeout); "servidor": 5xx; "formato": 200 con cuerpo no JSON */
class ErrorRia extends Error {
  constructor(
    mensaje: string,
    readonly tipo: "red" | "servidor" | "formato"
  ) {
    super(mensaje);
  }
}
const esErrorRed = (e: unknown) => e instanceof ErrorRia && e.tipo === "red";

async function get(url: string, cuenta: { n: number }): Promise<Respuesta> {
  let ultimo: ErrorRia | null = null;
  for (let intento = 0; intento <= ESPERAS_REINTENTO.length; intento++) {
    if (intento > 0) await sleep(ESPERAS_REINTENTO[intento - 1]);
    let r: Response;
    let texto: string;
    try {
      cuenta.n++;
      r = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      texto = await r.text();
    } catch (e) {
      ultimo = new ErrorRia(`sin respuesta (${(e as Error).name}: ${(e as Error).message})`, "red");
      continue;
    }
    if (r.status >= 500) {
      ultimo = new ErrorRia(`HTTP ${r.status}: ${texto.slice(0, 120)}`, "servidor");
      continue;
    }
    let json: unknown = null;
    if (r.ok) {
      try {
        json = JSON.parse(texto);
      } catch {
        throw new ErrorRia(`respuesta no JSON: ${texto.slice(0, 120)}`, "formato");
      }
    }
    return { status: r.status, json, texto };
  }
  throw ultimo ?? new ErrorRia("sin respuesta", "red");
}

// ---------------------------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------------------------

type DiaApi = Record<string, unknown>;
type MesApi = Record<string, unknown>;
type EstacionApi = {
  codigoEstacion?: unknown;
  nombre?: unknown;
  activa?: unknown;
  visible?: unknown;
  bajoplastico?: unknown;
  latitud?: unknown;
  longitud?: unknown;
  altitud?: unknown;
};

function normalizarDia(d: DiaApi): DiaRia | null {
  const fecha = typeof d.fecha === "string" && /^\d{4}-\d{2}-\d{2}/.test(d.fecha) ? d.fecha.slice(0, 10) : null;
  if (!fecha) return null;
  const T = (v: unknown) => redondear(valido(v, -15, 50), 1);
  const HR = (v: unknown) => redondear(valido(v, 0, 100), 1);
  const V = (v: unknown) => redondear(valido(v, 0, 60), 2);
  return {
    fecha,
    tMax: T(d.tempMax),
    tMin: T(d.tempMin),
    tMed: T(d.tempMedia),
    hrMed: HR(d.humedadMedia),
    hrMin: HR(d.humedadMin),
    hrMax: HR(d.humedadMax),
    viento: V(d.velViento),
    vientoMax: V(d.velVientoMax),
    dirViento: redondear(valido(d.dirViento, 0, 360), 0),
    radiacion: redondear(valido(d.radiacion, 0, 35), 1),
    precip: redondear(valido(d.precipitacion, 0, 400), 1),
    et0: redondear(valido(d.et0, 0, 15), 2),
  };
}

const tieneDatos = (d: DiaRia) =>
  [d.tMax, d.tMin, d.tMed, d.hrMed, d.viento, d.radiacion, d.precip, d.et0].some((v) => v !== null);

// ---------------------------------------------------------------------------------------------
// Cálculos
// ---------------------------------------------------------------------------------------------

function agregado(dias: DiaRia[], campo: keyof Omit<DiaRia, "fecha">, modo: "suma" | "max" | "min") {
  const vals = dias.map((d) => d[campo]).filter((v): v is number => v !== null);
  if (!vals.length) return { valor: null as number | null, n: 0 };
  const valor = modo === "suma" ? vals.reduce((a, b) => a + b, 0) : modo === "max" ? Math.max(...vals) : Math.min(...vals);
  return { valor, n: vals.length };
}

export function calcularAcumulados(serie: DiaRia[], referencia: string | null): AcumuladosRia {
  const vacio = (n: number) => ({ valor: null as number | null, n });
  const ventana = (n: number) => (referencia ? serie.filter((d) => d.fecha > sumarDias(referencia, -n) && d.fecha <= referencia) : []);
  const v7 = ventana(7);
  const v30 = ventana(30);
  const mesIni = referencia ? `${referencia.slice(0, 7)}-01` : null;
  const vMes = referencia && mesIni ? serie.filter((d) => d.fecha >= mesIni && d.fecha <= referencia) : [];
  let hidroIni: string | null = null;
  if (referencia) {
    const anyo = +referencia.slice(0, 4);
    hidroIni = +referencia.slice(5, 7) >= 10 ? `${anyo}-10-01` : `${anyo - 1}-10-01`;
  }
  const vHidro = referencia && hidroIni ? serie.filter((d) => d.fecha >= hidroIni && d.fecha <= referencia) : [];
  const s = (v: DiaRia[], c: keyof Omit<DiaRia, "fecha">) => (v.length ? agregado(v, c, "suma") : vacio(0));
  const et7 = s(v7, "et0");
  const et30 = s(v30, "et0");
  const p7 = s(v7, "precip");
  const p30 = s(v30, "precip");
  const balance = (p: number | null, e: number | null) => (p === null || e === null ? null : redondear(p - e, 1));
  const gd = v30.filter((d) => d.tMed !== null);
  return {
    referencia,
    diasConDatos_7d: v7.filter(tieneDatos).length,
    diasConDatos_30d: v30.filter(tieneDatos).length,
    diasConEt0_7d: et7.n,
    diasConEt0_30d: et30.n,
    diasConPrecip_7d: p7.n,
    diasConPrecip_30d: p30.n,
    et0_7d: redondear(et7.valor, 1),
    et0_30d: redondear(et30.valor, 1),
    precip_7d: redondear(p7.valor, 1),
    precip_30d: redondear(p30.valor, 1),
    balance_7d: balance(redondear(p7.valor, 1), redondear(et7.valor, 1)),
    balance_30d: balance(redondear(p30.valor, 1), redondear(et30.valor, 1)),
    tMax_7d: agregado(v7, "tMax", "max").valor,
    tMax_30d: agregado(v30, "tMax", "max").valor,
    tMin_7d: agregado(v7, "tMin", "min").valor,
    tMin_30d: agregado(v30, "tMin", "min").valor,
    vientoMax_7d: agregado(v7, "vientoMax", "max").valor,
    vientoMax_30d: agregado(v30, "vientoMax", "max").valor,
    diasHelada_7d: v7.filter((d) => d.tMin !== null && d.tMin <= 0).length,
    diasHelada_30d: v30.filter((d) => d.tMin !== null && d.tMin <= 0).length,
    diasCalor_7d: v7.filter((d) => d.tMax !== null && d.tMax >= 35).length,
    diasCalor_30d: v30.filter((d) => d.tMax !== null && d.tMax >= 35).length,
    gradosDia10_30d: gd.length ? redondear(gd.reduce((a, d) => a + Math.max(0, (d.tMed as number) - 10), 0), 1) : null,
    et0_mes: redondear(s(vMes, "et0").valor, 1),
    precip_mes: redondear(s(vMes, "precip").valor, 1),
    diasConEt0_mes: s(vMes, "et0").n,
    et0_anioHidro: redondear(s(vHidro, "et0").valor, 1),
    precip_anioHidro: redondear(s(vHidro, "precip").valor, 1),
    diasConEt0_anioHidro: s(vHidro, "et0").n,
    diasConPrecip_anioHidro: s(vHidro, "precip").n,
  };
}

/** Últimos 13 meses: valores del mensual de IFAPA (si lo hay) y ET0 sumando los diarios de forceEt0. */
function calcularMensual(serie: DiaRia[], mensualApi: MesApi[] | null, referencia: string | null): MesRia[] {
  if (!referencia) return [];
  const [ra, rm] = [+referencia.slice(0, 4), +referencia.slice(5, 7)];
  const meses: { anyo: number; mes: number }[] = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(Date.UTC(ra, rm - 1 - i, 1));
    meses.push({ anyo: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 });
  }
  const api = new Map<string, MesApi>();
  for (const m of mensualApi ?? []) {
    const a = valido(m.anyo, 2000, 2100);
    const me = valido(m.mes, 1, 12);
    if (a !== null && me !== null) api.set(`${a}-${me}`, m);
  }
  return meses.map(({ anyo, mes }) => {
    const pref = `${anyo}-${String(mes).padStart(2, "0")}`;
    const dias = serie.filter((d) => d.fecha.startsWith(pref) && d.fecha <= referencia);
    const et = agregado(dias, "et0", "suma");
    const esperados = anyo === ra && mes === rm ? +referencia.slice(8, 10) : diasDelMes(anyo, mes);
    const m = api.get(`${anyo}-${mes}`);
    const base = {
      anyo,
      mes,
      et0: redondear(et.valor, 1),
      diasConEt0: et.n,
      parcial: et.n < esperados,
    };
    if (m) {
      return {
        ...base,
        numDias: valido(m.numDias, 0, 31),
        tMed: redondear(valido(m.tempMedia, -15, 50), 1),
        tMax: redondear(valido(m.tempMax, -15, 50), 1),
        tMin: redondear(valido(m.tempMin, -15, 50), 1),
        hrMed: redondear(valido(m.humedadMedia, 0, 100), 1),
        viento: redondear(valido(m.velViento, 0, 60), 2),
        vientoMax: redondear(valido(m.velVientoMax, 0, 60), 2),
        precip: redondear(valido(m.precipitacion, 0, 3000), 1),
        radiacion: redondear(valido(m.radiacion, 0, 35), 1),
        fuente: "mensual" as const,
      };
    }
    const media = (c: keyof Omit<DiaRia, "fecha">) => {
      const a = agregado(dias, c, "suma");
      return a.n ? a.valor! / a.n : null;
    };
    return {
      ...base,
      numDias: dias.filter(tieneDatos).length || null,
      tMed: redondear(media("tMed"), 1),
      tMax: agregado(dias, "tMax", "max").valor,
      tMin: agregado(dias, "tMin", "min").valor,
      hrMed: redondear(media("hrMed"), 1),
      viento: redondear(media("viento"), 2),
      vientoMax: agregado(dias, "vientoMax", "max").valor,
      precip: redondear(agregado(dias, "precip", "suma").valor, 1),
      radiacion: redondear(media("radiacion"), 1),
      fuente: "diario" as const,
    };
  });
}

function estadoDe(ultimoDia: string | null, hoy: string): { estado: EstadoEstacion; retrasoDias: number | null } {
  if (!ultimoDia) return { estado: "sin-datos", retrasoDias: null };
  const r = diasEntre(ultimoDia, hoy);
  return { estado: r <= 2 ? "ok" : r <= 7 ? "retrasada" : "sin-datos", retrasoDias: r };
}

type MunicipioSemilla = { id: string; nombre: string; lat: number; lon: number; altitud: number };

function referencias(estaciones: EstacionRia[], municipios: MunicipioSemilla[]): Record<string, ReferenciaMunicipio> {
  const out: Record<string, ReferenciaMunicipio> = {};
  if (!estaciones.length) return out;
  const masCercana = (m: MunicipioSemilla, lista: EstacionRia[]) =>
    lista
      .map((e) => ({ e, d: haversineKm(m.lat, m.lon, e.lat, e.lon) }))
      .sort((a, b) => a.d - b.d)[0];
  const conDatos = estaciones.filter((e) => e.estado !== "sin-datos");
  for (const m of municipios) {
    const c = masCercana(m, estaciones);
    const difAltitud = Math.round(m.altitud - c.e.altitud);
    const ref: ReferenciaMunicipio = {
      estacion: c.e.codigo,
      distanciaKm: redondear(c.d, 1) as number,
      difAltitud,
      aviso: Math.abs(difAltitud) > AVISO_ALTITUD_M || c.d > AVISO_DISTANCIA_KM,
    };
    if (c.e.estado === "sin-datos" && conDatos.length) {
      const c2 = masCercana(m, conDatos);
      ref.estacionConDatos = c2.e.codigo;
      ref.distanciaConDatosKm = redondear(c2.d, 1) as number;
      ref.difAltitudConDatos = Math.round(m.altitud - c2.e.altitud);
    }
    out[m.id] = ref;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------------------------

// Respaldo si /estaciones/4 falla y no hay agro.json anterior (estaciones activas el 28-10-2026)
const ESTACIONES_RESPALDO: EstacionApi[] = [
  { codigoEstacion: "10", nombre: "Adra", activa: true, visible: true, bajoplastico: false, latitud: "364448000N", longitud: "025932000W", altitud: 2 },
  { codigoEstacion: "2", nombre: "Almería", activa: true, visible: true, bajoplastico: false, latitud: "365007000N", longitud: "022408000W", altitud: 5 },
  { codigoEstacion: "8", nombre: "Cuevas de Almanzora", activa: true, visible: true, bajoplastico: false, latitud: "371524000N", longitud: "014801000W", altitud: 28 },
  { codigoEstacion: "5", nombre: "Fiñana", activa: true, visible: true, bajoplastico: false, latitud: "370924000N", longitud: "025019000W", altitud: 958 },
  { codigoEstacion: "7", nombre: "Huércal-Overa", activa: true, visible: true, bajoplastico: false, latitud: "372444000N", longitud: "015303000W", altitud: 303 },
  { codigoEstacion: "1", nombre: "La Mojonera", activa: true, visible: true, bajoplastico: false, latitud: "364714000N", longitud: "024215000W", altitud: 137 },
  { codigoEstacion: "11", nombre: "Níjar", activa: true, visible: true, bajoplastico: false, latitud: "365702000N", longitud: "020929000W", altitud: 169 },
  { codigoEstacion: "4", nombre: "Tabernas", activa: true, visible: true, bajoplastico: false, latitud: "370528000N", longitud: "021808000W", altitud: 502 },
  { codigoEstacion: "12", nombre: "Tíjola", activa: true, visible: true, bajoplastico: false, latitud: "372242000N", longitud: "022734000W", altitud: 776 },
  { codigoEstacion: "6", nombre: "Virgen de Fátima-Cuevas de Almanzora", activa: true, visible: true, bajoplastico: false, latitud: "372320000N", longitud: "014613000W", altitud: 173 },
];

type MetaEstacion = { codigo: string; nombreRia: string; lat: number; lon: number; altitud: number; bajoPlastico: boolean };

function metaEstacion(e: EstacionApi): MetaEstacion | null {
  const codigo = String(e.codigoEstacion ?? "").trim();
  const lat = coordenadaRia(e.latitud);
  const lon = coordenadaRia(e.longitud);
  const altitud = valido(e.altitud, -50, 3500);
  if (!codigo || lat === null || lon === null || altitud === null) return null;
  return { codigo, nombreRia: String(e.nombre ?? codigo), lat, lon, altitud, bajoPlastico: e.bajoplastico === true };
}

async function leerJson<T>(ruta: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(ruta, "utf8")) as T;
  } catch {
    return null;
  }
}

async function escribirAtomico(ruta: string, datos: string): Promise<void> {
  const tmp = `${ruta}.tmp-${process.pid}`;
  await writeFile(tmp, datos);
  await rename(tmp, ruta);
}

function municipioMasCercano(lat: number, lon: number, municipios: MunicipioSemilla[]): string | null {
  let mejor: { id: string; d: number } | null = null;
  for (const m of municipios) {
    const d = haversineKm(lat, lon, m.lat, m.lon);
    if (!mejor || d < mejor.d) mejor = { id: m.id, d };
  }
  return mejor?.id ?? null;
}

/** Descarga completa: estaciones + 400 días por estación + mensuales. */
async function descargarTodo(
  ctx: Ctx,
  previo: AgroJson | null,
  municipios: MunicipioSemilla[],
  cuenta: { n: number }
): Promise<{ agro: AgroJson; descargadas: number }> {
  const ahora = ctx.ahora;
  const hoy = fechaMadrid(ahora);
  const desde = sumarDias(hoy, -DIAS_HISTORICO);
  const fallos: AgroJson["fallos"] = [];

  // 1. Estaciones activas y visibles
  let lista: MetaEstacion[] = [];
  let erroresSeguidos = 0; // cortacircuitos: con 2 fallos seguidos se deja de pedir (la RIA está caída)
  try {
    const r = await get(`${BASE}/estaciones/${PROVINCIA}`, cuenta);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`HTTP ${r.status}`);
    lista = (r.json as EstacionApi[])
      .filter((e) => e.activa === true && e.visible === true)
      .map(metaEstacion)
      .filter((m): m is MetaEstacion => m !== null);
    if (!lista.length) throw new Error("ninguna estación activa");
  } catch (e) {
    fallos.push({ codigo: "estaciones", motivo: `lista de estaciones: ${(e as Error).message}` });
    if (e instanceof ErrorRia && e.tipo !== "formato") erroresSeguidos = 1;
    lista = previo?.estaciones.length
      ? previo.estaciones.map((s) => ({ codigo: s.codigo, nombreRia: s.nombreRia, lat: s.lat, lon: s.lon, altitud: s.altitud, bajoPlastico: s.bajoPlastico }))
      : ESTACIONES_RESPALDO.map(metaEstacion).filter((m): m is MetaEstacion => m !== null);
  }
  lista.sort((a, b) => +a.codigo - +b.codigo);

  // 2. Datos por estación, en serie
  type Bruto = { m: MetaEstacion; serie: DiaRia[]; mensual: MesApi[] | null; ultimaModificacion: string | null; error: string | null; sinDatos: boolean };
  const brutos: Bruto[] = [];
  const conservadas: EstacionRia[] = [];
  const [anyo, mes] = [+hoy.slice(0, 4), +hoy.slice(5, 7)];
  for (const m of lista) {
    const b: Bruto = { m, serie: [], mensual: null, ultimaModificacion: null, error: null, sinDatos: false };
    const anterior = previo?.estaciones.find((s) => s.codigo === m.codigo);
    if (erroresSeguidos >= 2) {
      // La RIA no responde: no se insiste con el resto de estaciones
      b.error = "no se ha pedido: la RIA no responde";
      fallos.push({ codigo: m.codigo, motivo: b.error });
      if (anterior) conservadas.push({ ...anterior, ...estadoDe(anterior.ultimoDia, hoy), conservada: true });
      else brutos.push(b);
      continue;
    }
    await sleep(PAUSA_MS);
    try {
      const r = await get(`${BASE}/datosdiarios/forceEt0/${PROVINCIA}/${m.codigo}/${desde}/${hoy}`, cuenta).catch((e: unknown) => {
        if (!(e instanceof ErrorRia) || e.tipo !== "servidor") throw e;
        // 5xx persistente en forceEt0: se prueba sin ET0 (/false) y la ET0 queda en null
        ctx.log(`  ria: estación ${m.codigo}, forceEt0 falla (${e.message}); pruebo sin ET0`);
        fallos.push({ codigo: m.codigo, motivo: `forceEt0: ${e.message}; datos sin ET0` });
        return get(`${BASE}/datosdiarios/${PROVINCIA}/${m.codigo}/${desde}/${hoy}/false`, cuenta);
      });
      erroresSeguidos = 0;
      if (r.status === 404) b.sinDatos = true;
      else if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`HTTP ${r.status}: ${r.texto.slice(0, 120)}`);
      else {
        const porFecha = new Map<string, DiaRia>();
        for (const d of r.json as DiaApi[]) {
          const n = normalizarDia(d);
          if (n && n.fecha <= hoy) porFecha.set(n.fecha, n);
          const mod = isoOffset(d.fechaUtlMod);
          if (mod && (!b.ultimaModificacion || Date.parse(mod) > Date.parse(b.ultimaModificacion))) b.ultimaModificacion = mod;
        }
        b.serie = [...porFecha.values()].sort((x, y) => x.fecha.localeCompare(y.fecha));
      }
    } catch (e) {
      b.error = (e as Error).message;
      if (esErrorRed(e) || (e instanceof ErrorRia && e.tipo === "servidor")) erroresSeguidos++;
      fallos.push({ codigo: m.codigo, motivo: `datos diarios: ${b.error}` });
      if (anterior) {
        // Se conservan los datos anteriores de esta estación, con el estado recalculado a hoy
        conservadas.push({ ...anterior, ...estadoDe(anterior.ultimoDia, hoy), conservada: true });
        continue;
      }
    }

    // Mensuales (cubren días que faltan en los diarios): año anterior desde el mes actual y año actual hasta el mes actual
    if (b.serie.length) {
      try {
        const partes: MesApi[] = [];
        for (const url of [
          `${BASE}/datosmensuales/${PROVINCIA}/${m.codigo}/${anyo - 1}/${mes}/12`,
          `${BASE}/datosmensuales/${PROVINCIA}/${m.codigo}/${anyo}/1/${mes}`,
        ]) {
          await sleep(PAUSA_MS);
          const r = await get(url, cuenta);
          if (r.status === 200 && Array.isArray(r.json)) partes.push(...(r.json as MesApi[]));
          else if (r.status !== 404) throw new Error(`HTTP ${r.status}`);
        }
        b.mensual = partes;
      } catch (e) {
        fallos.push({ codigo: m.codigo, motivo: `datos mensuales: ${(e as Error).message}; se calculan con los diarios` });
      }
    }
    brutos.push(b);
  }

  // 3. Referencia común de los acumulados: último día con datos en alguna estación (normalmente ayer)
  const ultimoDe = (serie: DiaRia[]) => serie.filter(tieneDatos).at(-1)?.fecha ?? null;
  const ultimos = [...brutos.map((b) => ultimoDe(b.serie)), ...conservadas.map((e) => e.ultimoDia)].filter((f): f is string => !!f);
  const ultimoDiaDisponible = ultimos.length ? ultimos.sort().at(-1)! : null;

  const estaciones: EstacionRia[] = [...conservadas];
  for (const { m, serie, mensual, ultimaModificacion, error, sinDatos } of brutos) {
    const conDatos = serie.filter(tieneDatos);
    const ultimoDia = conDatos.at(-1)?.fecha ?? null;
    const est = estadoDe(ultimoDia, hoy);
    if (!error && (sinDatos || !ultimoDia)) fallos.push({ codigo: m.codigo, motivo: `la RIA no tiene datos de esta estación en los últimos ${DIAS_HISTORICO} días` });
    else if (est.estado === "sin-datos" && ultimoDia) fallos.push({ codigo: m.codigo, motivo: `último dato del ${ultimoDia}` });
    estaciones.push({
      codigo: m.codigo,
      nombre: NOMBRE_MOSTRAR[m.codigo] ?? m.nombreRia,
      nombreRia: m.nombreRia,
      municipioId: MUNICIPIO_ESTACION[m.codigo] ?? municipioMasCercano(m.lat, m.lon, municipios),
      lat: Math.round(m.lat * 1e5) / 1e5,
      lon: Math.round(m.lon * 1e5) / 1e5,
      altitud: m.altitud,
      bajoPlastico: m.bajoPlastico,
      ...est,
      ultimoDia,
      ultimaModificacion,
      ultimo: conDatos.at(-1) ?? null,
      dias: ultimoDia ? serie.filter((d) => d.fecha > sumarDias(ultimoDia, -DIAS_GUARDADOS) && d.fecha <= ultimoDia) : [],
      acumulados: calcularAcumulados(serie, ultimoDiaDisponible),
      mensual: calcularMensual(serie, mensual, ultimoDiaDisponible),
    });
  }
  estaciones.sort((a, b) => +a.codigo - +b.codigo);
  const cargas = estaciones.map((e) => e.ultimaModificacion).filter((f): f is string => !!f);
  const descargadas = brutos.filter((b) => !b.error).length;
  const agro: AgroJson = {
    updatedAt: ahora.toISOString(),
    hoy,
    fuente: {
      nombre: "Red de Información Agroclimática de Andalucía (RIA), IFAPA, Junta de Andalucía",
      url: "https://www.juntadeandalucia.es/agriculturaypesca/ifapa/riaweb/web/",
      licencia: "pendiente de confirmar con IFAPA (el servicio riaws no declara licencia)",
      atribucion: ATRIBUCION_RIA,
    },
    ultimaCargaRia: cargas.length ? cargas.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)! : null,
    ultimoDiaDisponible,
    fallos,
    estaciones,
    municipios: referencias(estaciones, municipios),
  };
  return { agro, descargadas };
}

// ---------------------------------------------------------------------------------------------
// Módulo
// ---------------------------------------------------------------------------------------------

export const actualizar: Fuente = async (ctx: Ctx): Promise<ResultadoFuente> => {
  const ruta = path.join(ctx.dirDatos, "agro.json");
  const cuenta = { n: 0 };
  try {
    const previo = await leerJson<AgroJson>(ruta);
    const metaPrevia: Record<string, any> = ctx.meta?.fuentes?.ria ?? {};
    const ahora = ctx.ahora;
    const ayer = sumarDias(fechaMadrid(ahora), -1);
    const actualizadoMs = typeof metaPrevia.actualizado === "string" ? Date.parse(metaPrevia.actualizado) : NaN;
    const caducado = !previo || !Number.isFinite(actualizadoMs) || ahora.getTime() - actualizadoMs >= TTL_MS;
    const ultimoDia: string | null = previo?.ultimoDiaDisponible ?? metaPrevia.ultimoDia ?? null;
    const faltaAyer = !ultimoDia || ultimoDia < ayer;
    const trasPublicacion = ahora.getUTCHours() * 60 + ahora.getUTCMinutes() >= MINUTO_UTC_PUBLICACION;

    if (!ctx.forzar && !caducado) {
      if (!(faltaAyer && trasPublicacion)) return { fuente: "ria", ok: true, cambiado: false, nota: "vigente" };
      // Falta ayer y ya debería estar: sonda barata (un día de una estación) antes de bajarlo todo
      const sonda = previo?.estaciones.find((e) => e.estado === "ok")?.codigo ?? "1";
      const r = await get(`${BASE}/datosdiarios/forceEt0/${PROVINCIA}/${sonda}/${ayer}/${ayer}`, cuenta).catch(() => null);
      const hay = r?.status === 200 && Array.isArray(r.json) && (r.json as DiaApi[]).some((d) => d.fecha === ayer);
      if (!hay) return { fuente: "ria", ok: true, cambiado: false, nota: `vigente; la RIA aún no ha publicado el ${ayer}` };
      ctx.log(`  ria: ya está el ${ayer}, actualizo`);
    }

    let municipios: MunicipioSemilla[] = [];
    try {
      municipios = JSON.parse(await readFile(path.join(ctx.dirRaiz, "scripts", "municipios-almeria.json"), "utf8"));
    } catch {
      ctx.log("  ria: no se pudo leer scripts/municipios-almeria.json; sin estación de referencia por municipio");
    }

    const { agro: nuevo, descargadas } = await descargarTodo(ctx, previo, municipios, cuenta);
    const frescas = nuevo.estaciones.filter((e) => e.ultimoDia && !e.conservada).length;
    const resumenFallos = () => nuevo.fallos.map((f) => `${f.codigo}: ${f.motivo}`).join("; ");
    if (!frescas && previo?.estaciones.some((e) => e.ultimoDia)) {
      // No ha llegado nada nuevo (RIA caída o sin datos): se conserva el archivo anterior tal cual
      ctx.log(`  ria: sin datos nuevos de ninguna estación (${resumenFallos()}); se conserva agro.json anterior`);
      return { fuente: "ria", ok: false, cambiado: false, nota: `sin datos nuevos de la RIA: ${resumenFallos()}`.slice(0, 500) };
    }
    await escribirAtomico(ruta, JSON.stringify(nuevo));
    const estados = nuevo.estaciones.map((e) => `${e.codigo}:${e.estado}${e.conservada ? "(anterior)" : ""}`).join(" ");
    ctx.log(`  ria: ${nuevo.estaciones.length} estaciones (${estados}), último día ${nuevo.ultimoDiaDisponible ?? "—"}, ${cuenta.n} peticiones`);
    if (!frescas) {
      // Primera vez y sin datos: queda un agro.json con los fallos para que la página diga que no hay datos
      return { fuente: "ria", ok: false, cambiado: true, nota: `sin datos de la RIA: ${resumenFallos()}`.slice(0, 500) };
    }
    const cambiado = !previo || previo.ultimaCargaRia !== nuevo.ultimaCargaRia || previo.ultimoDiaDisponible !== nuevo.ultimoDiaDisponible;
    return {
      fuente: "ria",
      ok: true,
      cambiado,
      nota: `${frescas}/${nuevo.estaciones.length} estaciones con datos nuevos (${descargadas} descargadas); ${nuevo.fallos.length} avisos`,
      metaFuente: { actualizado: nuevo.updatedAt, ultimoDia: nuevo.ultimoDiaDisponible },
    };
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    ctx.log(`  ria: fallo (${motivo}); se conserva agro.json anterior`);
    return { fuente: "ria", ok: false, cambiado: false, nota: motivo };
  }
};
