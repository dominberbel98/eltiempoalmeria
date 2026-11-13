// Mar: predicción costera de AEMET para el litoral de Almería y oleaje de Open-Meteo en 10 puntos de la costa
// (scripts/puntos-costa-almeria.json) → src/data/mar.json
//
// 1. AEMET /prediccion/maritima/costera/costa/47 ("Costa de Andalucía Oriental y Melilla"): boletín FQXX47 con
//    situación, aviso, tendencia y predicción por subzona. De ella se guardan las aguas costeras de Almería
//    (subzonas "Costa Sur de Almería" y "Costa Oriental de Almería") y las de la isla de Alborán (término de Almería).
//    AEMET la publica al menos dos veces al día con 24 h de validez. Ojo: `origen.elaborado` es el inicio de validez
//    (igual que `inicio`), no la hora de publicación: el 01-11-2026 la edición "elaborada" a las 12:00 UTC estaba en la
//    web desde las 10:47 UTC. La hora real de publicación (`publicado`) es el Last-Modified del XML público de la misma
//    edición (aemet.es/xml/maritima/FQXX47MM.xml, sin clave ni cupo: OpenData no manda Last-Modified) o, si no cuadra,
//    la hora de la descarga. Se comprueba cada 3 h y, cuando la edición guardada tiene 8 h o más (contadas desde la
//    publicación), cada hora hasta que llega la nueva. Unas 13 comprobaciones al día × 2 peticiones = ~26 peticiones
//    AEMET/día, más 1 GET al XML público por edición nueva (2-3 al día).
// 2. Open-Meteo, TTL 3 h, en serie y con todas las ubicaciones en una sola petición:
//    a) Marine API (best_match): altura, dirección y periodo de la ola, mar de fondo, mar de viento y temperatura del
//       agua. 8 variables × 75 h (4 días de peso) → peso 1 por punto → 10.
//    b) Forecast API (best_match, cell_selection=sea): viento medio, dirección y rachas sobre el mar en los mismos
//       puntos (los municipios costeros tienen el centroide tierra adentro, a veces a cientos de metros de altitud).
//       3 variables → peso 1 por punto → 10.
//    Total: 20 por descarga × 8 descargas al día = 160/día. 75 h para que, con el TTL de 3 h, al publicar sigan
//    quedando 72 h por delante.
// Nunca lanza: ante un fallo conserva el dato anterior de la parte que falla y devuelve ok=false.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ClienteAemet, escribirJson, existe, leerJson, mensajeError, minutosDesde, msElaborado, msIso, pedir, pedirOpenMeteo, pesoOpenMeteo, toArray } from "./comun";
import type { Fuente } from "./tipos";

// --- Parámetros ---

export const COSTA_AEMET = 47; // Costa de Andalucía Oriental y Melilla
export const ZONA_ALMERIA = 8010410; // Aguas costeras de Almería (subzonas 8010411 oriental y 8010412 sur)
export const ZONA_ALBORAN = 8012920; // Aguas costeras de la isla de Alborán
const ZONAS_GUARDADAS = [ZONA_ALMERIA, ZONA_ALBORAN];

const TTL_OM_MIN = 180;
const HORAS = 75;
const COSTERA_EDAD_NUEVA_H = 8; // a partir de aquí se espera la edición siguiente
const COSTERA_REINTENTO_MIN = 60;
const COSTERA_MAX_SIN_COMPROBAR_MIN = 180;
/** El mismo boletín en la web de AEMET (sin clave ni cupo), solo para leer su Last-Modified */
export const URL_XML_COSTERA = "https://www.aemet.es/xml/maritima/FQXX47MM.xml";

/** Variables de la Marine API y su nombre en mar.json */
export const VARIABLES_MAR = {
  wave_height: "ola", // m, altura significante total
  wave_direction: "olaDir", // °, de donde viene
  wave_period: "olaPeriodo", // s, periodo medio
  swell_wave_height: "fondo", // m, mar de fondo (primario)
  swell_wave_direction: "fondoDir", // °
  swell_wave_period: "fondoPeriodo", // s
  wind_wave_height: "olaViento", // m, mar de viento
  sea_surface_temperature: "agua", // °C
} as const;

/** Variables de la Forecast API (viento sobre el mar) y su nombre en mar.json */
export const VARIABLES_VIENTO = {
  wind_speed_10m: "viento", // km/h
  wind_direction_10m: "vientoDir", // °, de donde viene
  wind_gusts_10m: "racha", // km/h
} as const;

// --- Formato de src/data/mar.json ---

export type VariableMar = (typeof VARIABLES_MAR)[keyof typeof VARIABLES_MAR] | (typeof VARIABLES_VIENTO)[keyof typeof VARIABLES_VIENTO];
export type SerieMar = Record<VariableMar, (number | null)[]>;

export type PuntoCostaDef = { id: string; nombre: string; municipio: string; lat: number; lon: number; subzonaAemet: number };
export type PuntoMar = PuntoCostaDef & {
  /** Celda del modelo de oleaje que ha devuelto Open-Meteo */
  latModelo: number | null;
  lonModelo: number | null;
  serie: SerieMar;
};

export type TextoPeriodo = { texto: string; inicio: string | null; fin: string | null };
export type SubzonaCostera = { id: number; nombre: string; texto: string };
export type ZonaCostera = { id: number; nombre: string; subzonas: SubzonaCostera[] };
/** Boletín costero de AEMET, normalizado. Las fechas de AEMET, como vienen: UTC sin "Z" ("2026-10-31T12:00:00"). */
export type CosteraAemet = {
  id: string | null; // "FQXX47"
  nombre: string | null;
  /** `origen.elaborado` de AEMET: en la práctica es el inicio de validez (igual que `inicio`), no la publicación */
  elaborado: string;
  /** Publicación real (ISO UTC con Z): Last-Modified del XML público o, si no se pudo leer, la hora de la descarga */
  publicado?: string | null;
  /** De dónde sale `publicado`: "web" (Last-Modified) o "descarga" (primera descarga de esta edición) */
  publicadoOrigen?: "web" | "descarga" | null;
  inicio: string | null;
  fin: string | null;
  aviso: (TextoPeriodo & { nombre: string | null }) | null; // "No hay avisos" o el texto del aviso (toda Andalucía oriental)
  situacion: (TextoPeriodo & { analisis: string | null }) | null;
  tendencia: TextoPeriodo | null;
  zonas: ZonaCostera[]; // aguas costeras de Almería y de Alborán, en este orden
};

export type MarJson = {
  /** Descarga de Open-Meteo (ISO UTC) o null si nunca ha habido */
  actualizado: string | null;
  /** Horas locales "YYYY-MM-DDTHH:00" (Europe/Madrid), desde la hora de la descarga */
  horas: string[];
  puntos: PuntoMar[];
  costera: CosteraAemet | null;
  /** Última comprobación correcta del boletín costero (ISO UTC) */
  costeraComprobada: string | null;
};

// --- AEMET ---

type TextoAemet = { texto?: string; inicio?: string; fin?: string; id?: string | number; nombre?: string; analisis?: string };
type BoletinAemet = {
  id?: string;
  nombre?: string;
  origen?: { elaborado?: string; inicio?: string; fin?: string };
  aviso?: TextoAemet;
  situacion?: TextoAemet;
  tendencia?: TextoAemet;
  prediccion?: { inicio?: string; fin?: string; zona?: { id?: number | string; nombre?: string; subzona?: TextoAemet | TextoAemet[] }[] | { id?: number | string; nombre?: string; subzona?: TextoAemet | TextoAemet[] } };
};

/** Quita el guion blando (U+00AD) que AEMET mete en algunos títulos y normaliza los espacios. */
const limpiar = (s: unknown) =>
  String(s ?? "")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim();
const oNulo = (s: unknown) => limpiar(s) || null;
const periodo = (t: TextoAemet | undefined): TextoPeriodo | null =>
  t && limpiar(t.texto) ? { texto: limpiar(t.texto), inicio: oNulo(t.inicio), fin: oNulo(t.fin) } : null;

/** Normaliza el boletín costero y se queda con las aguas de Almería y Alborán. Lanza si no están. */
export function normalizarCostera(crudo: unknown): CosteraAemet {
  const b = toArray(crudo as BoletinAemet | BoletinAemet[])[0];
  if (!b || typeof b !== "object") throw new Error("boletín costero vacío");
  const elaborado = oNulo(b.origen?.elaborado);
  if (!elaborado || !Number.isFinite(msElaborado(elaborado))) throw new Error("boletín costero sin fecha de elaboración");
  const zonas: ZonaCostera[] = [];
  for (const idZona of ZONAS_GUARDADAS) {
    const z = toArray(b.prediccion?.zona).find((x) => Number(x.id) === idZona);
    if (!z) continue;
    const subzonas = toArray(z.subzona)
      .map((s) => ({ id: Number(s.id), nombre: limpiar(s.nombre), texto: limpiar(s.texto) }))
      .filter((s) => s.texto);
    if (subzonas.length) zonas.push({ id: idZona, nombre: limpiar(z.nombre), subzonas });
  }
  if (!zonas.some((z) => z.id === ZONA_ALMERIA)) throw new Error("el boletín costero no trae las aguas costeras de Almería");
  const aviso = periodo(b.aviso);
  const situacion = periodo(b.situacion);
  return {
    id: oNulo(b.id),
    nombre: oNulo(b.nombre),
    elaborado,
    inicio: oNulo(b.prediccion?.inicio ?? b.origen?.inicio),
    fin: oNulo(b.prediccion?.fin ?? b.origen?.fin),
    aviso: aviso ? { ...aviso, nombre: oNulo(b.aviso?.nombre) } : null,
    situacion: situacion ? { ...situacion, analisis: oNulo(b.situacion?.analisis) } : null,
    tendencia: periodo(b.tendencia),
    zonas,
  };
}

/**
 * Hora de publicación del boletín: Last-Modified del XML público si trae la misma edición (mismo `elaborado`) y no es
 * futura; si no, null. Una sola petición, sin reintentos: es un dato secundario.
 */
async function publicadoEnWeb(elaborado: string, ahora: Date, log: (m: string) => void): Promise<string | null> {
  try {
    const r = await pedir(URL_XML_COSTERA, { intentos: 1, timeoutMs: 15_000, log, etiqueta: "XML costero de aemet.es" });
    const edicion = /<elaborado>\s*([^<]+?)\s*<\/elaborado>/.exec(r.texto())?.[1];
    const lm = Date.parse(r.headers.get("last-modified") ?? "");
    if (edicion !== elaborado || !Number.isFinite(lm) || lm > ahora.getTime() + 60_000) return null;
    return new Date(lm).toISOString();
  } catch {
    return null;
  }
}

// --- Open-Meteo ---

type RespuestaOm = { latitude?: number; longitude?: number; hourly?: Record<string, unknown[]> & { time?: string[] } };

const redondeo: Record<VariableMar, number> = {
  ola: 2, olaDir: 0, olaPeriodo: 1, fondo: 2, fondoDir: 0, fondoPeriodo: 1, olaViento: 2, agua: 1, viento: 0, vientoDir: 0, racha: 0,
};
function valor(v: unknown, dec: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const f = 10 ** dec;
  return Math.round(v * f) / f;
}

function urlOm(base: string, puntos: PuntoCostaDef[], variables: string[], extra: Record<string, string>): string {
  const url = new URL(base);
  url.searchParams.set("latitude", puntos.map((p) => p.lat).join(","));
  url.searchParams.set("longitude", puntos.map((p) => p.lon).join(","));
  url.searchParams.set("hourly", variables.join(","));
  url.searchParams.set("forecast_hours", String(HORAS));
  url.searchParams.set("timezone", "Europe/Madrid");
  url.searchParams.set("cell_selection", "sea");
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.toString();
}

async function pedirSerie(url: string, n: number, log: (m: string) => void): Promise<RespuestaOm[]> {
  const r = await pedirOpenMeteo(url, { log });
  const datos = toArray(JSON.parse(r.texto()) as RespuestaOm | RespuestaOm[]);
  if (datos.length !== n) throw new Error(`Open-Meteo devolvió ${datos.length} ubicaciones de ${n}`);
  return datos;
}

/** Descarga oleaje y viento de los puntos. Devuelve el peso gastado aunque falle la segunda petición. */
async function descargarOleaje(puntos: PuntoCostaDef[], log: (m: string) => void, gasto: { peso: number }): Promise<Pick<MarJson, "horas" | "puntos">> {
  const varsMar = Object.keys(VARIABLES_MAR);
  const varsViento = Object.keys(VARIABLES_VIENTO);
  const dias = Math.ceil(HORAS / 24);
  const mar = await pedirSerie(urlOm("https://marine-api.open-meteo.com/v1/marine", puntos, varsMar, { length_unit: "metric" }), puntos.length, log);
  gasto.peso += pesoOpenMeteo(puntos.length, varsMar.length, 1, dias);
  const viento = await pedirSerie(
    urlOm("https://api.open-meteo.com/v1/forecast", puntos, varsViento, { wind_speed_unit: "kmh", models: "best_match" }),
    puntos.length,
    log
  );
  gasto.peso += pesoOpenMeteo(puntos.length, varsViento.length, 1, dias);

  const horas = (mar[0].hourly?.time ?? []).map(String);
  if (horas.length < 72) throw new Error(`serie de oleaje demasiado corta (${horas.length} h)`);
  const salida: PuntoMar[] = puntos.map((p, i) => {
    const hm = mar[i].hourly ?? {};
    const tm = (hm.time ?? []).map(String);
    if (tm.length !== horas.length || tm[0] !== horas[0]) throw new Error(`eje de horas distinto en el oleaje de ${p.nombre}`);
    const hv = viento[i].hourly ?? {};
    const indiceViento = new Map((hv.time ?? []).map((t, k) => [String(t), k]));
    const serie = {} as SerieMar;
    for (const [om, corto] of Object.entries(VARIABLES_MAR)) serie[corto] = horas.map((_, k) => valor(hm[om]?.[k], redondeo[corto]));
    for (const [om, corto] of Object.entries(VARIABLES_VIENTO)) {
      serie[corto] = horas.map((t) => {
        const k = indiceViento.get(t);
        return k === undefined ? null : valor(hv[om]?.[k], redondeo[corto]);
      });
    }
    return { ...p, latModelo: valor(mar[i].latitude, 4), lonModelo: valor(mar[i].longitude, 4), serie };
  });
  const sinOla = salida.filter((p) => !p.serie.ola.some((v) => v != null));
  if (sinOla.length) log(`  mar: sin oleaje en ${sinOla.map((p) => p.nombre).join(", ")} (¿celda de tierra?)`);
  if (sinOla.length > puntos.length / 2) throw new Error(`${sinOla.length} de ${puntos.length} puntos sin oleaje`);
  return { horas, puntos: salida };
}

// --- Módulo ---

export async function leerPuntosCosta(dirRaiz: string): Promise<PuntoCostaDef[]> {
  const lista = JSON.parse(await readFile(path.join(dirRaiz, "scripts", "puntos-costa-almeria.json"), "utf8")) as PuntoCostaDef[];
  if (!Array.isArray(lista) || !lista.length) throw new Error("scripts/puntos-costa-almeria.json vacío");
  return lista.map((p) => ({ id: String(p.id), nombre: String(p.nombre), municipio: String(p.municipio), lat: Number(p.lat), lon: Number(p.lon), subzonaAemet: Number(p.subzonaAemet) }));
}

const VACIO: MarJson = { actualizado: null, horas: [], puntos: [], costera: null, costeraComprobada: null };

export const actualizar: Fuente = async (ctx) => {
  const ant: { actualizado?: string | null; peso?: number; costera?: { elaborado?: string | null; publicado?: string | null; comprobado?: string | null } } = ctx.meta.fuentes?.mar ?? {};
  const ruta = path.join(ctx.dirDatos, "mar.json");
  const previo = await leerJson<MarJson>(ruta, VACIO);
  const datos: MarJson = { ...VACIO, ...previo };
  const cliente = new ClienteAemet(ctx.aemetKey, ctx.log);
  const gasto = { peso: 0 };
  let pidioOm = false;
  const notas: string[] = [];
  const errores: string[] = [];
  let cambiado = false;

  // 1. Boletín costero de AEMET
  const comprobadoAnt = ant.costera?.comprobado ?? previo.costeraComprobada ?? null;
  const elaboradoAnt = previo.costera?.elaborado ?? ant.costera?.elaborado ?? null;
  // Edad de la edición desde su publicación. `elaborado` es el inicio de validez (puede ser futuro): se toma el más
  // antiguo de los instantes conocidos (publicado, elaborado y, en datos sin `publicado`, la última comprobación).
  const instantesEdicion = [msIso(previo.costera?.publicado ?? (previo.costera ? comprobadoAnt : null)), msElaborado(elaboradoAnt)].filter(Number.isFinite);
  const edadH = instantesEdicion.length ? (ctx.ahora.getTime() - Math.min(...instantesEdicion)) / 3_600_000 : Number.NaN;
  const desdeComprobado = minutosDesde(comprobadoAnt, ctx.ahora);
  const tocaCostera =
    ctx.forzar ||
    !previo.costera ||
    !(edadH < COSTERA_EDAD_NUEVA_H) ||
    desdeComprobado >= COSTERA_MAX_SIN_COMPROBAR_MIN;
  const reintentoCostera = !ctx.forzar && previo.costera && desdeComprobado < COSTERA_REINTENTO_MIN;
  if (!ctx.aemetKey) notas.push("costera: sin AEMET_API_KEY, se conserva la anterior");
  else if (!tocaCostera || reintentoCostera) notas.push(`costera vigente (válida desde ${elaboradoAnt ?? "?"} UTC, ${Number.isFinite(edadH) ? edadH.toFixed(1) : "?"} h)`);
  else {
    try {
      const costera = normalizarCostera(await cliente.json<unknown>(`/prediccion/maritima/costera/costa/${COSTA_AEMET}`));
      if (previo.costera?.publicado && costera.elaborado === previo.costera.elaborado) {
        costera.publicado = previo.costera.publicado;
        costera.publicadoOrigen = previo.costera.publicadoOrigen ?? "descarga";
      } else {
        const web = await publicadoEnWeb(costera.elaborado, ctx.ahora, ctx.log);
        costera.publicado = web ?? ctx.ahora.toISOString();
        costera.publicadoOrigen = web ? "web" : "descarga";
      }
      const nueva = costera.elaborado !== elaboradoAnt || JSON.stringify(costera) !== JSON.stringify(previo.costera);
      datos.costera = costera;
      datos.costeraComprobada = ctx.ahora.toISOString();
      cambiado = cambiado || nueva;
      notas.push(nueva ? `costera nueva (publicada ${costera.publicado}, ${costera.publicadoOrigen}; válida desde ${costera.elaborado} UTC)` : "costera sin cambios");
    } catch (e) {
      errores.push(`costera: ${mensajeError(e)}`);
    }
  }

  // 2. Oleaje y viento de Open-Meteo
  try {
    const puntos = await leerPuntosCosta(ctx.dirRaiz);
    const anteriores = Array.isArray(previo.puntos) ? previo.puntos : [];
    const mismosPuntos = anteriores.length === puntos.length && puntos.every((p, i) => anteriores[i]?.id === p.id && anteriores[i]?.lat === p.lat && anteriores[i]?.lon === p.lon);
    const edad = minutosDesde(previo.actualizado ?? ant.actualizado, ctx.ahora);
    if (!ctx.forzar && edad < TTL_OM_MIN && mismosPuntos && Array.isArray(previo.horas) && previo.horas.length > 0) {
      notas.push(`oleaje vigente (${Math.round(edad)} min)`);
    } else {
      pidioOm = true;
      const nuevo = await descargarOleaje(puntos, ctx.log, gasto);
      datos.horas = nuevo.horas;
      datos.puntos = nuevo.puntos;
      datos.actualizado = ctx.ahora.toISOString();
      cambiado = true;
      notas.push(`oleaje de ${puntos.length} puntos, ${nuevo.horas.length} h`);
    }
  } catch (e) {
    errores.push(`oleaje: ${mensajeError(e)}`);
  }

  try {
    if (cambiado || !existe(ruta)) await escribirJson(ruta, datos);
  } catch (e) {
    errores.push(`escritura: ${mensajeError(e)}`);
    cambiado = false;
  }

  const metaFuente = {
    actualizado: datos.actualizado,
    peso: pidioOm ? gasto.peso : (ant.peso ?? 0),
    costera: { elaborado: datos.costera?.elaborado ?? null, publicado: datos.costera?.publicado ?? null, comprobado: datos.costeraComprobada },
  };
  return {
    fuente: "mar",
    ok: errores.length === 0,
    cambiado,
    peticionesAemet: cliente.peticiones,
    // Se informa el peso (aunque sea 0) si se llegó a pedir algo a Open-Meteo, para el espaciado de los demás módulos
    pesoOpenMeteo: pidioOm ? gasto.peso : undefined,
    nota: [...notas, ...errores.map((e) => `error ${e}; se conservan los datos anteriores`)].join("; "),
    metaFuente,
  };
};
