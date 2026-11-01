// Lectura de src/data/avisos.json (avisos Meteoalerta de AEMET, scripts/fuentes/avisos.ts) y de las zonas de aviso
// versionadas en scripts/avisos-zonas-almeria.json. Solo se ejecuta en el build: el estado (vigente, próximo,
// expirado) se calcula con la hora del build, que se repite cada 15 min.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type {
  Aviso,
  AvisosJson,
  Fenomeno,
  MunicipioZonaAviso,
  NivelAviso,
  ZonaAvisoAlmeria,
  ZonaDeAviso,
  ZonasAvisoJson,
} from "../../scripts/fuentes/avisos";

export type { Aviso, AvisosJson, Fenomeno, MunicipioZonaAviso, NivelAviso, ZonaAvisoAlmeria, ZonaDeAviso };

const ZONA = "Europe/Madrid";
const RUTA_AVISOS = path.resolve("src/data/avisos.json");
const RUTA_ZONAS = path.resolve("scripts/avisos-zonas-almeria.json");

export const ATRIBUCION_AVISOS = "Información elaborada por la Agencia Estatal de Meteorología";
export const URL_AVISOS_AEMET = "https://www.aemet.es/es/eltiempo/prediccion/avisos?k=and";

// ---------------------------------------------------------------------------------------------
// Niveles: nombres, significado (Plan Meteoalerta) y colores
// ---------------------------------------------------------------------------------------------

export const NIVELES: NivelAviso[] = ["amarillo", "naranja", "rojo"];
export const ORDEN_NIVEL: Record<NivelAviso, number> = { amarillo: 1, naranja: 2, rojo: 3 };
export const NOMBRE_NIVEL: Record<NivelAviso, string> = { amarillo: "Amarillo", naranja: "Naranja", rojo: "Rojo" };
export const SIGNIFICADO_NIVEL: Record<NivelAviso, string> = {
  amarillo: "No hay riesgo para la población en general, pero sí para alguna actividad concreta.",
  naranja: "Riesgo meteorológico importante: fenómenos poco habituales y peligrosos para las actividades habituales.",
  rojo: "Riesgo meteorológico extraordinario: fenómenos muy peligrosos y de intensidad excepcional.",
};

/**
 * Colores por nivel (contraste WCAG calculado; los textos cumplen AA):
 * - marca: relleno de la etiqueta o del área en el mapa, con `tinta` encima (amarillo 8,8:1, naranja 5,8:1, rojo 5,6:1).
 *   El amarillo sobre cal o blanco no llega a 3:1: la etiqueta lleva siempre texto o el `borde`.
 * - fondo: fondo de la tarjeta o fila del aviso; encima, `texto` (≥5,6:1) o basalto (≥11,5:1).
 * - texto: el nivel escrito como texto sobre blanco, cal o `fondo` (≥5,5:1).
 * - borde: filete izquierdo o contorno (≥3,5:1 sobre blanco, cal y su `fondo`, salvo naranja sobre su fondo: 3,2:1).
 * - marcaOscuro: relleno sobre basalto o basalto-2 (≥3,8:1), con basalto como texto encima.
 * Se proponen como tokens `--color-aviso-{nivel}`, `-fondo`, `-texto`, `-borde` en src/styles/global.css;
 * `VAR_NIVEL` da las variables con estos valores de respaldo.
 */
export const COLOR_NIVEL: Record<NivelAviso, { marca: string; tinta: string; fondo: string; texto: string; borde: string; marcaOscuro: string }> = {
  amarillo: { marca: "#f2c230", tinta: "#1e2a30", fondo: "#fbf0c9", texto: "#735600", borde: "#9c7700", marcaOscuro: "#f2c230" },
  naranja: { marca: "#ec8a3c", tinta: "#1e2a30", fondo: "#fce3cf", texto: "#93430c", borde: "#c9631c", marcaOscuro: "#ec8a3c" },
  rojo: { marca: "#c62a2a", tinta: "#ffffff", fondo: "#f9dddd", texto: "#a01c1c", borde: "#c62a2a", marcaOscuro: "#f0605a" },
};

/** `var(--color-aviso-amarillo, #f2c230)` y similares, para usar en style o en SVG antes de que existan los tokens. */
export const VAR_NIVEL: Record<NivelAviso, { marca: string; fondo: string; texto: string; borde: string }> = Object.fromEntries(
  NIVELES.map((n) => [
    n,
    {
      marca: `var(--color-aviso-${n}, ${COLOR_NIVEL[n].marca})`,
      fondo: `var(--color-aviso-${n}-fondo, ${COLOR_NIVEL[n].fondo})`,
      texto: `var(--color-aviso-${n}-texto, ${COLOR_NIVEL[n].texto})`,
      borde: `var(--color-aviso-${n}-borde, ${COLOR_NIVEL[n].borde})`,
    },
  ])
) as Record<NivelAviso, { marca: string; fondo: string; texto: string; borde: string }>;

// ---------------------------------------------------------------------------------------------
// Fenómenos
// ---------------------------------------------------------------------------------------------

/** Nombre del fenómeno en frase normal y la forma que va tras "por": "Aviso amarillo por lluvias". */
export const FENOMENO: Record<Fenomeno, { nombre: string; trasPor: string }> = {
  viento: { nombre: "Viento", trasPor: "viento" },
  lluvia: { nombre: "Lluvias", trasPor: "lluvias" },
  tormentas: { nombre: "Tormentas", trasPor: "tormentas" },
  costeros: { nombre: "Fenómenos costeros", trasPor: "fenómenos costeros" },
  "temperaturas-maximas": { nombre: "Temperaturas máximas", trasPor: "temperaturas máximas" },
  "temperaturas-minimas": { nombre: "Temperaturas mínimas", trasPor: "temperaturas mínimas" },
  nieve: { nombre: "Nevadas", trasPor: "nevadas" },
  niebla: { nombre: "Nieblas", trasPor: "nieblas" },
  polvo: { nombre: "Polvo en suspensión", trasPor: "polvo en suspensión" },
  aludes: { nombre: "Aludes", trasPor: "aludes" },
  galernas: { nombre: "Galernas", trasPor: "galernas" },
  otro: { nombre: "Otros fenómenos", trasPor: "fenómenos adversos" },
};

/** "Aviso amarillo por lluvias" */
export function tituloAviso(a: Pick<Aviso, "nivel" | "fenomeno" | "fenomenoNombre">): string {
  const f = a.fenomeno === "otro" && a.fenomenoNombre ? a.fenomenoNombre.toLowerCase() : FENOMENO[a.fenomeno].trasPor;
  return `Aviso ${a.nivel} por ${f}`;
}

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

let cacheAvisos: { mtime: number; datos: AvisosJson | null } | null = null;

/** avisos.json o null si no existe o no se puede leer (la página debe decir que no hay datos de avisos). */
export function getAvisos(): AvisosJson | null {
  if (!existsSync(RUTA_AVISOS)) return null;
  try {
    const mtime = statSync(RUTA_AVISOS).mtimeMs;
    if (cacheAvisos && cacheAvisos.mtime === mtime) return cacheAvisos.datos;
    const d = JSON.parse(readFileSync(RUTA_AVISOS, "utf8")) as AvisosJson;
    const datos = d && Array.isArray(d.avisos) ? d : null;
    cacheAvisos = { mtime, datos };
    return datos;
  } catch {
    return null;
  }
}

let cacheZonas: ZonasAvisoJson | null = null;
function zonasJson(): ZonasAvisoJson {
  if (cacheZonas) return cacheZonas;
  try {
    cacheZonas = JSON.parse(readFileSync(RUTA_ZONAS, "utf8")) as ZonasAvisoJson;
  } catch {
    cacheZonas = { fuente: "", metodo: "", generado: "", coordenadas: "", zonas: [], municipios: {}, revisados: [] };
  }
  return cacheZonas;
}

/** Las 6 zonas de aviso de Almería (4 de tierra y 2 costeras), con polígono [lon, lat]. */
export const getZonasAviso = (): ZonaAvisoAlmeria[] => zonasJson().zonas;
export const zonaAviso = (codigo: string): ZonaAvisoAlmeria | null => zonasJson().zonas.find((z) => z.codigo === codigo) ?? null;

/** Zona de tierra y zonas costeras (solo municipios con costa) de un municipio por su código INE. */
export function zonasAvisoDeMunicipio(id: string): { tierra: ZonaAvisoAlmeria | null; costa: ZonaAvisoAlmeria[] } {
  const m = zonasJson().municipios[id];
  if (!m) return { tierra: null, costa: [] };
  return { tierra: zonaAviso(m.zona), costa: m.costa.map(zonaAviso).filter((z): z is ZonaAvisoAlmeria => z != null) };
}

/** Códigos INE de los municipios de una zona (en una costera, los municipios con costa en ella). */
export function municipiosDeZona(codigo: string): string[] {
  return Object.entries(zonasJson().municipios)
    .filter(([, m]) => m.zona === codigo || m.costa.includes(codigo))
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------------------------
// Estado y filtros
// ---------------------------------------------------------------------------------------------

export type EstadoAviso = "vigente" | "proximo" | "expirado";
export type AvisosClasificados = { vigentes: Aviso[]; proximos: Aviso[] };

export function estadoAviso(a: Pick<Aviso, "inicio" | "fin">, ahora: Date = new Date()): EstadoAviso {
  const t = ahora.getTime();
  if (Date.parse(a.fin) <= t) return "expirado";
  return Date.parse(a.inicio) <= t ? "vigente" : "proximo";
}

const ordenar = (a: Aviso, b: Aviso) =>
  ORDEN_NIVEL[b.nivel] - ORDEN_NIVEL[a.nivel] || a.inicio.localeCompare(b.inicio) || a.fenomeno.localeCompare(b.fenomeno);

/** Vigentes (ordenados por nivel y luego por inicio) y próximos (por inicio y luego por nivel). */
export function clasificar(avisos: Aviso[], ahora: Date = new Date()): AvisosClasificados {
  const vigentes: Aviso[] = [];
  const proximos: Aviso[] = [];
  for (const a of avisos) {
    const e = estadoAviso(a, ahora);
    if (e === "vigente") vigentes.push(a);
    else if (e === "proximo") proximos.push(a);
  }
  vigentes.sort(ordenar);
  proximos.sort((a, b) => a.inicio.localeCompare(b.inicio) || ORDEN_NIVEL[b.nivel] - ORDEN_NIVEL[a.nivel]);
  return { vigentes, proximos };
}

/** Todos los avisos de Almería sin expirar. */
export const avisosActivos = (ahora: Date = new Date()): AvisosClasificados => clasificar(getAvisos()?.avisos ?? [], ahora);

/** Avisos de una zona (código Meteoalerta, p. ej. "610403" o "610403C"). */
export function avisosDeZona(codigo: string, ahora: Date = new Date()): AvisosClasificados {
  return clasificar((getAvisos()?.avisos ?? []).filter((a) => a.zonas.some((z) => z.codigo === codigo)), ahora);
}

/** Avisos que afectan a un municipio (su zona de tierra y, si tiene costa, sus zonas costeras). */
export function avisosDeMunicipio(id: string, ahora: Date = new Date()): AvisosClasificados & { zonas: string[] } {
  const m = zonasJson().municipios[id];
  const zonas = m ? [m.zona, ...m.costa] : [];
  const avisos = (getAvisos()?.avisos ?? []).filter((a) => a.zonas.some((z) => zonas.includes(z.codigo)));
  return { ...clasificar(avisos, ahora), zonas };
}

export function nivelMaximo(avisos: Pick<Aviso, "nivel">[]): NivelAviso | null {
  let max: NivelAviso | null = null;
  for (const a of avisos) if (!max || ORDEN_NIVEL[a.nivel] > ORDEN_NIVEL[max]) max = a.nivel;
  return max;
}

export type OpcionesNivel = {
  /** Contar también los avisos que aún no han empezado (por defecto, sí) */
  incluirProximos?: boolean;
  /** Si se cuentan los próximos, solo los que empiezan en las próximas `horas` (por defecto, todos: hasta 3 días) */
  horas?: number;
  /** Contar los avisos de las zonas costeras en los municipios con costa (por defecto, sí) */
  incluirCostas?: boolean;
};

function cuenta(a: Aviso, ahora: Date, op: OpcionesNivel): boolean {
  const e = estadoAviso(a, ahora);
  if (e === "vigente") return true;
  if (e !== "proximo" || op.incluirProximos === false) return false;
  return op.horas == null || Date.parse(a.inicio) - ahora.getTime() <= op.horas * 3_600_000;
}

/** Nivel más alto que afecta a un municipio, o null si no tiene avisos. */
export function nivelMaximoMunicipio(id: string, ahora: Date = new Date(), op: OpcionesNivel = {}): NivelAviso | null {
  const m = zonasJson().municipios[id];
  if (!m) return null;
  const zonas = op.incluirCostas === false ? [m.zona] : [m.zona, ...m.costa];
  return nivelMaximo((getAvisos()?.avisos ?? []).filter((a) => a.zonas.some((z) => zonas.includes(z.codigo)) && cuenta(a, ahora, op)));
}

/** Nivel más alto de los 103 municipios de una vez (para el mapa): { "04013": "amarillo", "04001": null, … } */
export function nivelesPorMunicipio(ahora: Date = new Date(), op: OpcionesNivel = {}): Record<string, NivelAviso | null> {
  const avisos = (getAvisos()?.avisos ?? []).filter((a) => cuenta(a, ahora, op));
  const porZona = new Map<string, NivelAviso | null>();
  for (const z of getZonasAviso()) porZona.set(z.codigo, nivelMaximo(avisos.filter((a) => a.zonas.some((x) => x.codigo === z.codigo))));
  const out: Record<string, NivelAviso | null> = {};
  for (const [id, m] of Object.entries(zonasJson().municipios)) {
    const zonas = op.incluirCostas === false ? [m.zona] : [m.zona, ...m.costa];
    out[id] = nivelMaximo(zonas.map((z) => porZona.get(z)).filter((n): n is NivelAviso => n != null).map((nivel) => ({ nivel })));
  }
  return out;
}

/** Nivel más alto de cada zona de aviso: { "610403": "amarillo", "610403C": null, … } */
export function nivelesPorZona(ahora: Date = new Date(), op: Omit<OpcionesNivel, "incluirCostas"> = {}): Record<string, NivelAviso | null> {
  const avisos = (getAvisos()?.avisos ?? []).filter((a) => cuenta(a, ahora, op));
  return Object.fromEntries(getZonasAviso().map((z) => [z.codigo, nivelMaximo(avisos.filter((a) => a.zonas.some((x) => x.codigo === z.codigo)))]));
}

// ---------------------------------------------------------------------------------------------
// Textos en español (hora de Madrid)
// ---------------------------------------------------------------------------------------------

const partesFmt = new Intl.DateTimeFormat("es-ES", {
  timeZone: ZONA,
  weekday: "long",
  day: "numeric",
  year: "numeric",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function partes(d: Date) {
  const p = Object.fromEntries(partesFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { semana: p.weekday, dia: Number(p.day), fecha: `${p.year}-${p.month}-${String(p.day).padStart(2, "0")}`, hora: `${p.hour}:${p.minute}` };
}

/** AEMET termina los avisos a las hh:59:59: para mostrar se redondea al minuto siguiente (02:59:59 -> 03:00). */
function instante(iso: string, esFin: boolean): Date {
  const t = Date.parse(iso);
  return new Date(esFin ? Math.ceil(t / 60_000) * 60_000 : Math.floor(t / 60_000) * 60_000);
}

/** "a las 19:00" / "a la 01:00" */
const aLas = (hora: string) => `${hora.startsWith("01:") ? "a la" : "a las"} ${hora}`;

const sumarDia = (fecha: string, n: number) => new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "hoy", "mañana" o "el domingo 1" respecto a `ahora` (Madrid) */
function diaRelativo(d: Date, ahora: Date): string {
  const p = partes(d);
  const hoy = partes(ahora).fecha;
  if (p.fecha === hoy) return "hoy";
  if (p.fecha === sumarDia(hoy, 1)) return "mañana";
  return `el ${p.semana} ${p.dia}`;
}

/**
 * Intervalo del aviso: "del sábado 31 a las 14:00 al domingo 1 a las 00:00"; si empieza y acaba el mismo día,
 * "el sábado 31 de 19:00 a 23:00".
 */
export function textoIntervalo(inicio: string, fin: string): string {
  const a = partes(instante(inicio, false));
  const b = partes(instante(fin, true));
  if (a.fecha === b.fecha) return `el ${a.semana} ${a.dia} de ${a.hora} a ${b.hora}`;
  return `del ${a.semana} ${a.dia} ${aLas(a.hora)} al ${b.semana} ${b.dia} ${aLas(b.hora)}`;
}

/**
 * Cuándo, relativo al momento del build:
 * vigente -> "Hasta las 23:00", "Hasta mañana a las 03:00", "Hasta el lunes 2 a las 00:00";
 * próximo -> "Desde hoy a las 19:00", "Desde mañana a las 07:00", "Desde el lunes 2 a las 00:00";
 * expirado -> "Terminó a las 03:00".
 */
export function textoCuando(a: Pick<Aviso, "inicio" | "fin">, ahora: Date = new Date()): string {
  const e = estadoAviso(a, ahora);
  if (e === "proximo") {
    const d = instante(a.inicio, false);
    return `Desde ${diaRelativo(d, ahora)} ${aLas(partes(d).hora)}`;
  }
  const d = instante(a.fin, true);
  const rel = diaRelativo(d, ahora);
  const hora = aLas(partes(d).hora);
  if (e === "expirado") return `Terminó ${rel === "hoy" ? "" : `${rel} `}${hora}`;
  return rel === "hoy" ? `Hasta ${hora.replace(/^a /, "")}` : `Hasta ${rel} ${hora}`;
}

const listaFmt = new Intl.ListFormat("es", { style: "long", type: "conjunction" });
/** "Poniente y Almería capital, Levante almeriense y Costa de Levante almeriense" (las zonas llevan "y" dentro: se separan con punto y coma si hay más de dos) */
export function textoZonas(zonas: Pick<ZonaDeAviso, "nombre">[]): string {
  const nombres = zonas.map((z) => z.nombre);
  if (nombres.length <= 2) return listaFmt.format(nombres);
  return `${nombres.slice(0, -1).join("; ")}; y ${nombres.at(-1)}`;
}

/** Valor de los parámetros en una frase: "Precipitación acumulada en una hora: 15 mm" */
export const textoParametros = (a: Pick<Aviso, "parametros">): string[] => a.parametros.filter((p) => p.nombre).map((p) => (p.valor ? `${p.nombre}: ${p.valor}` : p.nombre));

/** "Probabilidad del 40 % al 70 %" a partir de "40%-70%"; null si no viene */
export function textoProbabilidad(a: Pick<Aviso, "probabilidad">): string | null {
  const m = /(\d+)\s*%?\s*-\s*(\d+)\s*%/.exec(a.probabilidad ?? "");
  if (m) return `Probabilidad del ${m[1]} % al ${m[2]} %`;
  const s = /(\d+)\s*%/.exec(a.probabilidad ?? "");
  return s ? `Probabilidad del ${s[1]} %` : a.probabilidad ? `Probabilidad: ${a.probabilidad}` : null;
}
