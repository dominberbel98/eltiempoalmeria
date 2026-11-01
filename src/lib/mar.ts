// Lectura de src/data/mar.json (scripts/fuentes/mar.ts) y preparación de la página /mar/: boletín costero de AEMET,
// oleaje, mar de fondo, temperatura del agua y viento sobre el mar en 10 puntos de la costa, de oeste a este.
// Solo se ejecuta en el build. Los valores que faltan son null (nunca 0) y se muestran como "—".
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CosteraAemet, MarJson, PuntoCostaDef, PuntoMar, SerieMar, SubzonaCostera, VariableMar, ZonaCostera } from "../../scripts/fuentes/mar";
import { getMunicipios } from "./datos";
import { diaConNumero, horaLocal, horasDesde, textoActualizacion } from "./tiempo";

export type { CosteraAemet, MarJson, PuntoCostaDef, PuntoMar, SerieMar, SubzonaCostera, VariableMar, ZonaCostera };

const RUTA = path.resolve("src/data/mar.json");
const ZONA = "Europe/Madrid";

export const ATRIBUCION_AEMET = "Información elaborada por la Agencia Estatal de Meteorología";
export const ATRIBUCION_OPEN_METEO = "Weather data by Open-Meteo.com (CC BY 4.0)";
export const NOTA_MODELO_MAR =
  "Oleaje, mar de fondo y temperatura del agua: modelo marino de Open-Meteo en la celda de mar más cercana a cada punto (unos 9 km). Viento sobre el mar: modelo meteorológico de Open-Meteo.";
export const NOTA_ESTADO_MAR =
  "El estado de la mar sigue la escala Douglas aplicada a la altura total de la ola. AEMET usa esa escala solo para la mar de viento y da el mar de fondo aparte, así que con mar de fondo la cifra del modelo puede quedar un tramo por encima del boletín.";

/** Horas que enseña la página (el archivo trae 75 para que, con el TTL de 3 h, siempre queden 72 por delante). */
export const HORAS_PAGINA = 72;
/** Un día con menos horas que estas sale marcado como parcial. */
export const MIN_HORAS_DIA = 18;
/** Un día con menos horas que estas no se resume (el último trozo de la serie). */
export const MIN_HORAS_RESUMEN = 6;
/** A partir de esta antigüedad (h) del oleaje la página avisa de que los datos no son recientes. */
export const HORAS_DESFASE_MAR = 6;

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

let cache: { mtime: number; datos: MarJson | null } | null = null;

/** mar.json o null si no existe o no se puede leer (la página debe mostrar "sin datos"). */
export function getMar(): MarJson | null {
  if (!existsSync(RUTA)) return null;
  try {
    const mtime = statSync(RUTA).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.datos;
    const datos = JSON.parse(readFileSync(RUTA, "utf8")) as MarJson;
    if (!datos || !Array.isArray(datos.puntos) || !Array.isArray(datos.horas)) return null;
    cache = { mtime, datos };
    return datos;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Estado de la mar (escala Douglas) y escala de color de la altura de ola
// ---------------------------------------------------------------------------------------------

export type IdEstadoMar =
  | "calma"
  | "rizada"
  | "marejadilla"
  | "marejada"
  | "fuerte-marejada"
  | "gruesa"
  | "muy-gruesa"
  | "arbolada"
  | "montanosa"
  | "enorme";

export type EstadoMar = {
  id: IdEstadoMar;
  /** "Fuerte marejada" */
  nombre: string;
  /** Altura significante máxima del tramo en metros (inclusiva); null en el último */
  hasta: number | null;
  /** Rango legible: "de 0,5 a 1,25 m" */
  rango: string;
  /** Tramo de color de ESCALA_OLA (0-5) */
  tramo: number;
};

/**
 * Escala Douglas de la mar (código 3700 de la OMM), la que usa AEMET en sus predicciones marítimas.
 * Límites de altura significante en metros.
 */
export const ESTADOS_MAR: EstadoMar[] = [
  { id: "calma", nombre: "Calma", hasta: 0, rango: "0 m", tramo: 0 },
  { id: "rizada", nombre: "Rizada", hasta: 0.1, rango: "hasta 0,1 m", tramo: 0 },
  { id: "marejadilla", nombre: "Marejadilla", hasta: 0.5, rango: "de 0,1 a 0,5 m", tramo: 1 },
  { id: "marejada", nombre: "Marejada", hasta: 1.25, rango: "de 0,5 a 1,25 m", tramo: 2 },
  { id: "fuerte-marejada", nombre: "Fuerte marejada", hasta: 2.5, rango: "de 1,25 a 2,5 m", tramo: 3 },
  { id: "gruesa", nombre: "Gruesa", hasta: 4, rango: "de 2,5 a 4 m", tramo: 4 },
  { id: "muy-gruesa", nombre: "Muy gruesa", hasta: 6, rango: "de 4 a 6 m", tramo: 5 },
  { id: "arbolada", nombre: "Arbolada", hasta: 9, rango: "de 6 a 9 m", tramo: 5 },
  { id: "montanosa", nombre: "Montañosa", hasta: 14, rango: "de 9 a 14 m", tramo: 5 },
  { id: "enorme", nombre: "Enorme", hasta: null, rango: "más de 14 m", tramo: 5 },
];

/**
 * Estado de la mar para una altura de ola en metros (null si falta). Por debajo de 0,05 m cuenta como calma.
 * Se calcula con la altura redondeada a 1 decimal, la que se muestra (fmtAltura), para que "0,5 m" sea siempre
 * marejadilla y nunca salgan dos estados distintos para la misma cifra.
 */
export function estadoMar(alturaBruta: number | null | undefined): EstadoMar | null {
  if (alturaBruta == null || !Number.isFinite(alturaBruta)) return null;
  if (alturaBruta < 0.05) return ESTADOS_MAR[0];
  const altura = Math.round(alturaBruta * 10) / 10;
  return ESTADOS_MAR.slice(1).find((e) => e.hasta == null || altura <= e.hasta) ?? ESTADOS_MAR[ESTADOS_MAR.length - 1];
}

/**
 * Muestra de una escala de color. `fondo` y `texto` cumplen AA (≥4,5:1) entre sí, comprobado con la fórmula de WCAG 2.
 * `clase` son las utilidades de Tailwind de los mismos tokens de global.css (para chips y celdas).
 * `borde`: el fondo tiene menos de 3:1 sobre blanco y cal, así que una barra o un punto de ese color en una gráfica
 * necesita un borde de 1 px en ceniza (#56646B) para distinguirse (WCAG 1.4.11).
 */
export type MuestraColor = { fondo: string; texto: string; clase: string; borde: boolean; contraste: number };

/**
 * Altura de ola en 6 tramos de la escala Douglas: de mar-fondo a mar-texto (verde mar) y almagra a partir de mar
 * gruesa. Contraste del texto sobre el fondo: 12,4 · 10,2 · 7,2 · 6,5 · 5,4 · 8,2.
 */
export const ESCALA_OLA: (MuestraColor & { etiqueta: string; desde: number })[] = [
  { etiqueta: "Calma o rizada", desde: 0, fondo: "#E2EEEC", texto: "#1E2A30", clase: "bg-mar-fondo text-basalto", borde: true, contraste: 12.37 },
  { etiqueta: "Marejadilla", desde: 0.1, fondo: "#B4E0DA", texto: "#1E2A30", clase: "bg-lluvia-6 text-basalto", borde: true, contraste: 10.23 },
  { etiqueta: "Marejada", desde: 0.5, fondo: "#74C3BD", texto: "#1E2A30", clase: "bg-lluvia-5 text-basalto", borde: true, contraste: 7.2 },
  { etiqueta: "Fuerte marejada", desde: 1.25, fondo: "#13696A", texto: "#FFFFFF", clase: "bg-mar-texto text-blanco", borde: false, contraste: 6.45 },
  { etiqueta: "Gruesa", desde: 2.5, fondo: "#B5472E", texto: "#FFFFFF", clase: "bg-almagra text-blanco", borde: false, contraste: 5.38 },
  { etiqueta: "Muy gruesa o más", desde: 4, fondo: "#8E2F1E", texto: "#FFFFFF", clase: "bg-almagra-oscuro text-blanco", borde: false, contraste: 8.15 },
];

/** Color de la altura de ola (null si falta el dato). */
export function colorOla(altura: number | null | undefined): (MuestraColor & { etiqueta: string; desde: number }) | null {
  const e = estadoMar(altura);
  return e ? ESCALA_OLA[e.tramo] : null;
}

// ---------------------------------------------------------------------------------------------
// Viento en escala Beaufort (la del boletín costero)
// ---------------------------------------------------------------------------------------------

export type FuerzaBeaufort = { fuerza: number; nombre: string; kmh: string; nudos: string };

/** Escala Beaufort con los nombres de AEMET. */
export const BEAUFORT: FuerzaBeaufort[] = [
  { fuerza: 0, nombre: "Calma", kmh: "menos de 1 km/h", nudos: "menos de 1 nudo" },
  { fuerza: 1, nombre: "Ventolina", kmh: "de 1 a 5 km/h", nudos: "de 1 a 3 nudos" },
  { fuerza: 2, nombre: "Flojito", kmh: "de 6 a 11 km/h", nudos: "de 4 a 6 nudos" },
  { fuerza: 3, nombre: "Flojo", kmh: "de 12 a 19 km/h", nudos: "de 7 a 10 nudos" },
  { fuerza: 4, nombre: "Bonancible", kmh: "de 20 a 28 km/h", nudos: "de 11 a 16 nudos" },
  { fuerza: 5, nombre: "Fresquito", kmh: "de 29 a 38 km/h", nudos: "de 17 a 21 nudos" },
  { fuerza: 6, nombre: "Fresco", kmh: "de 39 a 49 km/h", nudos: "de 22 a 27 nudos" },
  { fuerza: 7, nombre: "Frescachón", kmh: "de 50 a 61 km/h", nudos: "de 28 a 33 nudos" },
  { fuerza: 8, nombre: "Temporal", kmh: "de 62 a 74 km/h", nudos: "de 34 a 40 nudos" },
  { fuerza: 9, nombre: "Temporal fuerte", kmh: "de 75 a 88 km/h", nudos: "de 41 a 47 nudos" },
  { fuerza: 10, nombre: "Temporal duro", kmh: "de 89 a 102 km/h", nudos: "de 48 a 55 nudos" },
  { fuerza: 11, nombre: "Temporal muy duro", kmh: "de 103 a 117 km/h", nudos: "de 56 a 63 nudos" },
  { fuerza: 12, nombre: "Temporal huracanado", kmh: "118 km/h o más", nudos: "64 nudos o más" },
];

/**
 * Fuerzas Beaufort que aparecen en un texto del boletín ("E y NE 3 a 5 amainando a S 2 a 3" => 2, 3, 5), ordenadas.
 * Ignora alturas y distancias ("de 1 a 2 m", "2 millas"). Orientativo: sirve para la leyenda junto al texto.
 */
export function fuerzasEnTexto(texto: string): FuerzaBeaufort[] {
  const vistas = new Set<number>();
  // Fuera primero las cantidades con unidad, también en rango: "de 1 a 2 m", "2 o 3 millas", "1010 hPa"
  const sinMedidas = texto.replace(/\d+(?:[,.]\d+)?(?:\s*(?:a|o|y)\s*\d+(?:[,.]\d+)?)?\s*(?:m\b|metros?|km|millas?|mn\b|%|h\b|hpa|°)/gi, " ");
  for (const m of sinMedidas.matchAll(/(?<![\d,.])(\d{1,2})(?![\d,.])/g)) {
    const n = Number(m[1]);
    if (n <= 12) vistas.add(n);
  }
  return [...vistas].sort((a, b) => a - b).map((n) => BEAUFORT[n]);
}

/** Estados de la mar (escala Douglas) que nombra un texto del boletín, en orden de la escala. */
export function estadosEnTexto(texto: string): EstadoMar[] {
  const t = texto.toLowerCase();
  const fuerte = /fuerte marejada/.test(t);
  const sinFuerte = t.replace(/fuerte marejada/g, " ");
  return ESTADOS_MAR.filter((e) => {
    if (e.id === "fuerte-marejada") return fuerte;
    if (e.id === "gruesa") return /\bgruesa\b/.test(sinFuerte.replace(/muy gruesa/g, " "));
    if (e.id === "muy-gruesa") return /muy gruesa/.test(t);
    return new RegExp(`\\b${e.nombre.toLowerCase()}\\b`).test(sinFuerte);
  });
}

/** Glosario breve de los términos del boletín costero. */
export const GLOSARIO_MAR: { termino: string; definicion: string }[] = [
  { termino: "Mar de viento", definicion: "Olas que levanta el viento que sopla en la zona. Es la que describe la escala Douglas del boletín (marejadilla, marejada…)." },
  { termino: "Mar de fondo", definicion: "Olas que llegan de lejos, generadas por un viento que sopla en otra zona. Son más largas y pueden romper con fuerza en la orilla aunque haya poco viento." },
  { termino: "Fuerza del viento", definicion: "El boletín da el viento en la escala Beaufort, de 0 (calma) a 12 (temporal huracanado). Fuerza 4 son de 20 a 28 km/h y fuerza 7, de 50 a 61 km/h." },
  { termino: "Altura significante", definicion: "Altura media del tercio de olas más altas. Algunas olas sueltas pueden llegar a casi el doble." },
  { termino: "Periodo", definicion: "Segundos entre dos olas seguidas. Con periodos largos (10 s o más) la ola trae más energía." },
];

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------

const MENOS = "−";
const fmtDec = (v: number, dec: number) =>
  (Math.round(v * 10 ** dec) / 10 ** dec).toLocaleString("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });

/** "0,5 m", "<0,1 m", "—" */
export function fmtAltura(m: number | null | undefined, unidad = true): string {
  if (m == null || !Number.isFinite(m)) return "—";
  const s = m > 0 && m < 0.05 ? "<0,1" : fmtDec(m, 1);
  return `${s}${unidad ? " m" : ""}`;
}
/** "6 s", "—" */
export const fmtPeriodo = (s: number | null | undefined) => (s == null || !Number.isFinite(s) ? "—" : `${Math.round(s)} s`);
/** "21,4 °C", "−0,5 °C", "—" */
export function fmtAgua(c: number | null | undefined, unidad = true): string {
  if (c == null || !Number.isFinite(c)) return "—";
  return `${c < 0 ? MENOS : ""}${fmtDec(Math.abs(c), 1)}${unidad ? " °C" : ""}`;
}
/** "24 km/h", "—" */
export const fmtVientoMar = (v: number | null | undefined, unidad = true) => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}${unidad ? " km/h" : ""}`);

const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const RUMBOS = ["norte", "nordeste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
const sector = (g: number) => Math.round((((g % 360) + 360) % 360) / 45) % 8;
/** Rumbo corto de donde viene: "NE" */
export const rumboCorto = (grados: number | null | undefined) => (grados == null || !Number.isFinite(grados) ? "—" : PUNTOS[sector(grados)]);
/** De donde viene, en frase: "del nordeste" */
export const procedencia = (grados: number | null | undefined) => (grados == null || !Number.isFinite(grados) ? "" : `del ${RUMBOS[sector(grados)]}`);

/** Instante (ms) de una fecha de AEMET (UTC sin "Z"). */
const msAemet = (s: string | null | undefined) => {
  if (!s) return Number.NaN;
  const t = String(s).trim();
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : t + "Z");
};
function partes(ms: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("es-ES", { timeZone: ZONA, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value])
  );
  return { semana: p.weekday, dia: p.day, mes: p.month, hora: `${p.hour}:${p.minute}` };
}
const aLas = (hora: string) => (hora.startsWith("01:") ? `a la ${hora}` : `a las ${hora}`);
/** "sábado 31 a las 21:00" (Madrid) */
export function diaYHora(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const p = partes(ms);
  return `${p.semana} ${p.dia} ${aLas(p.hora)}`;
}
/** "Hoy", "Mañana" o "Martes 3" para una fecha "YYYY-MM-DD" respecto a la hora local "YYYY-MM-DDTHH:00". */
export function etiquetaDia(fecha: string, ahoraLocal: string): string {
  const hoy = ahoraLocal.slice(0, 10);
  const manana = new Date(Date.parse(`${hoy}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return fecha === hoy ? "Hoy" : fecha === manana ? "Mañana" : diaConNumero(fecha);
}
/** "15:00" de una hora local "YYYY-MM-DDTHH:00" */
export const horaDe = (t: string) => t.slice(11, 16);

const listaFmt = new Intl.ListFormat("es", { style: "long", type: "conjunction" });

// ---------------------------------------------------------------------------------------------
// Puntos de la costa
// ---------------------------------------------------------------------------------------------

/** Valores de una hora en un punto (mismos nombres que SerieMar). */
export type HoraMar = { t: string } & Record<VariableMar, number | null>;

export type DiaMar = {
  fecha: string; // "YYYY-MM-DD"
  etiqueta: string; // "Hoy", "Mañana", "Martes 3"
  horas: number; // horas con dato de ola ese día dentro de la ventana
  parcial: boolean; // menos de MIN_HORAS_DIA horas
  olaMax: number | null;
  olaMin: number | null;
  /** Hora local de la ola más alta */
  olaMaxHora: string | null;
  /** Rumbo predominante de la ola (media circular ponderada por la altura), en grados */
  olaDir: number | null;
  periodoMax: number | null;
  fondoMax: number | null;
  fondoDir: number | null;
  vientoMax: number | null;
  rachaMax: number | null;
  vientoDir: number | null;
  aguaMedia: number | null;
  estado: EstadoMar | null; // por olaMax
};

export type PuntoMarPagina = {
  id: string;
  nombre: string;
  lat: number;
  lon: number;
  /** Código INE del municipio del punto (scripts/puntos-costa-almeria.json) */
  municipioId: string;
  /** El municipio con su slug para enlazar; null si no está en municipios.json */
  municipio: { id: string; nombre: string; slug: string } | null;
  /** Subzona del boletín costero de AEMET que cubre el punto */
  subzona: SubzonaCostera | null;
  /** Hora actual (o la primera de la serie si ya ha pasado), null si no hay serie */
  ahora: HoraMar | null;
  estadoAhora: EstadoMar | null;
  /** Desde la hora actual, como mucho HORAS_PAGINA */
  horas: HoraMar[];
  dias: DiaMar[];
  /** Ola más alta en la ventana */
  olaMax: { valor: number; t: string } | null;
};

const VARIABLES: VariableMar[] = ["ola", "olaDir", "olaPeriodo", "fondo", "fondoDir", "fondoPeriodo", "olaViento", "agua", "viento", "vientoDir", "racha"];

const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null && Number.isFinite(x));
const maximo = (xs: (number | null)[]) => {
  const v = nums(xs);
  return v.length ? Math.max(...v) : null;
};
const minimo = (xs: (number | null)[]) => {
  const v = nums(xs);
  return v.length ? Math.min(...v) : null;
};
const media = (xs: (number | null)[], dec = 1) => {
  const v = nums(xs);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10 ** dec) / 10 ** dec : null;
};
/** Media circular de direcciones (°) ponderada; null si no hay datos o se anulan. */
function rumboMedio(dirs: (number | null)[], pesos: (number | null)[]): number | null {
  let x = 0;
  let y = 0;
  dirs.forEach((d, i) => {
    const w = pesos[i] ?? 0;
    if (d == null || !Number.isFinite(d) || !(w > 0)) return;
    x += w * Math.cos((d * Math.PI) / 180);
    y += w * Math.sin((d * Math.PI) / 180);
  });
  if (Math.hypot(x, y) < 1e-9) return null;
  return Math.round((((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360);
}

/** Índice de la hora actual (o de la primera hora futura) en una lista de horas locales ordenadas. */
function indiceAhora(horas: string[], ahoraLocal: string): number {
  const i = horas.findIndex((t) => t >= ahoraLocal);
  return i < 0 ? horas.length : i;
}

function horaDePunto(p: PuntoMar, horas: string[], i: number): HoraMar {
  const h = { t: horas[i] } as HoraMar;
  for (const v of VARIABLES) h[v] = p.serie?.[v]?.[i] ?? null;
  return h;
}

function resumirDias(horas: HoraMar[], ahoraLocal: string): DiaMar[] {
  const porDia = new Map<string, HoraMar[]>();
  for (const h of horas) {
    const f = h.t.slice(0, 10);
    porDia.set(f, [...(porDia.get(f) ?? []), h]);
  }
  const dias: DiaMar[] = [];
  for (const [fecha, hs] of porDia) {
    const conOla = hs.filter((h) => h.ola != null);
    if (conOla.length < MIN_HORAS_RESUMEN) continue;
    const olaMax = maximo(hs.map((h) => h.ola));
    const pico = olaMax == null ? null : hs.find((h) => h.ola === olaMax) ?? null;
    dias.push({
      fecha,
      etiqueta: etiquetaDia(fecha, ahoraLocal),
      horas: conOla.length,
      parcial: conOla.length < MIN_HORAS_DIA,
      olaMax,
      olaMin: minimo(hs.map((h) => h.ola)),
      olaMaxHora: pico?.t ?? null,
      olaDir: rumboMedio(hs.map((h) => h.olaDir), hs.map((h) => h.ola)),
      periodoMax: maximo(hs.map((h) => h.olaPeriodo)),
      fondoMax: maximo(hs.map((h) => h.fondo)),
      fondoDir: rumboMedio(hs.map((h) => h.fondoDir), hs.map((h) => h.fondo)),
      vientoMax: maximo(hs.map((h) => h.viento)),
      rachaMax: maximo(hs.map((h) => h.racha)),
      vientoDir: rumboMedio(hs.map((h) => h.vientoDir), hs.map((h) => h.viento)),
      aguaMedia: media(hs.map((h) => h.agua)),
      estado: estadoMar(olaMax),
    });
  }
  return dias;
}

function subzonasPorId(mar: MarJson | null): Map<number, SubzonaCostera> {
  const m = new Map<number, SubzonaCostera>();
  for (const z of mar?.costera?.zonas ?? []) for (const s of z.subzonas) m.set(s.id, s);
  return m;
}

function municipiosPorId(): Map<string, { id: string; nombre: string; slug: string }> {
  try {
    return new Map(getMunicipios().map((m) => [m.id, { id: m.id, nombre: m.nombre, slug: m.slug }]));
  } catch {
    return new Map();
  }
}

/** Los puntos de la costa, de oeste a este, preparados para la página. Lista vacía si no hay mar.json. */
export function puntosMar(ahora: Date = new Date(), mar: MarJson | null = getMar()): PuntoMarPagina[] {
  if (!mar) return [];
  const ahoraLocal = horaLocal(ahora);
  const inicio = Math.min(indiceAhora(mar.horas, ahoraLocal), Math.max(0, mar.horas.length - 1));
  const fin = Math.min(mar.horas.length, inicio + HORAS_PAGINA);
  const subzonas = subzonasPorId(mar);
  const municipios = municipiosPorId();
  return mar.puntos.map((p) => {
    const horas: HoraMar[] = [];
    for (let i = inicio; i < fin; i++) horas.push(horaDePunto(p, mar.horas, i));
    const ahoraH = horas[0] ?? null;
    const olaMaxValor = maximo(horas.map((h) => h.ola));
    const pico = olaMaxValor == null ? null : horas.find((h) => h.ola === olaMaxValor) ?? null;
    return {
      id: p.id,
      nombre: p.nombre,
      lat: p.lat,
      lon: p.lon,
      municipioId: p.municipio,
      municipio: municipios.get(p.municipio) ?? null,
      subzona: subzonas.get(p.subzonaAemet) ?? null,
      ahora: ahoraH,
      estadoAhora: estadoMar(ahoraH?.ola),
      horas,
      dias: resumirDias(horas, ahoraLocal),
      olaMax: pico && olaMaxValor != null ? { valor: olaMaxValor, t: pico.t } : null,
    };
  });
}

/** Puntos de la costa de un municipio (Almería tiene dos: la capital y Cabo de Gata). */
export function puntosDeMunicipio(idMunicipio: string, ahora: Date = new Date(), mar: MarJson | null = getMar()): PuntoMarPagina[] {
  return puntosMar(ahora, mar).filter((p) => p.municipioId === idMunicipio);
}

// ---------------------------------------------------------------------------------------------
// Resumen de la costa
// ---------------------------------------------------------------------------------------------

export type ResumenMar = {
  /** Rango de la ola ahora en los puntos con dato */
  olaAhora: { min: number; max: number; estadoMin: EstadoMar; estadoMax: EstadoMar } | null;
  /** Punto con la ola más alta ahora */
  puntoMasOla: { id: string; nombre: string; valor: number } | null;
  aguaAhora: { min: number; max: number } | null;
  /** Ola más alta prevista en la ventana (72 h) */
  picoVentana: { id: string; nombre: string; valor: number; t: string; texto: string } | null;
  /** "Ahora hay olas de 0,4 a 0,7 m en la costa (marejadilla a marejada). La más alta, en Cabo de Gata." */
  fraseAhora: string | null;
  /** "El agua está entre 20,9 y 23,4 °C." */
  fraseAgua: string | null;
  /** "En las próximas 72 horas la ola más alta se espera en Carboneras el lunes 2 a las 15:00: 1,2 m (marejada)." */
  frasePico: string | null;
};

export function resumenMar(puntos: PuntoMarPagina[]): ResumenMar {
  const conOla = puntos.filter((p) => p.ahora?.ola != null);
  const vacio: ResumenMar = { olaAhora: null, puntoMasOla: null, aguaAhora: null, picoVentana: null, fraseAhora: null, fraseAgua: null, frasePico: null };
  if (!puntos.length) return vacio;
  let olaAhora: ResumenMar["olaAhora"] = null;
  let puntoMasOla: ResumenMar["puntoMasOla"] = null;
  let fraseAhora: string | null = null;
  if (conOla.length) {
    const vals = conOla.map((p) => p.ahora!.ola as number);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const masAlto = conOla.find((p) => p.ahora!.ola === max)!;
    olaAhora = { min, max, estadoMin: estadoMar(min)!, estadoMax: estadoMar(max)! };
    puntoMasOla = { id: masAlto.id, nombre: masAlto.nombre, valor: max };
    const estados =
      olaAhora.estadoMin.id === olaAhora.estadoMax.id
        ? olaAhora.estadoMin.nombre.toLowerCase()
        : `${olaAhora.estadoMin.nombre.toLowerCase()} a ${olaAhora.estadoMax.nombre.toLowerCase()}`;
    fraseAhora =
      fmtAltura(min) === fmtAltura(max)
        ? `Ahora hay olas de ${fmtAltura(max)} en toda la costa (${estados}).`
        : `Ahora hay olas de ${fmtAltura(min, false)} a ${fmtAltura(max)} en la costa (${estados}). La más alta, en ${masAlto.nombre}.`;
  }
  const aguas = nums(puntos.map((p) => p.ahora?.agua ?? null));
  const aguaAhora = aguas.length ? { min: Math.min(...aguas), max: Math.max(...aguas) } : null;
  const fraseAgua = aguaAhora
    ? fmtAgua(aguaAhora.min) === fmtAgua(aguaAhora.max)
      ? `El agua está a ${fmtAgua(aguaAhora.max)}.`
      : `El agua está entre ${fmtAgua(aguaAhora.min, false)} y ${fmtAgua(aguaAhora.max)}.`
    : null;
  let picoVentana: ResumenMar["picoVentana"] = null;
  for (const p of puntos) {
    if (p.olaMax && (!picoVentana || p.olaMax.valor > picoVentana.valor)) {
      picoVentana = { id: p.id, nombre: p.nombre, valor: p.olaMax.valor, t: p.olaMax.t, texto: "" };
    }
  }
  let frasePico: string | null = null;
  if (picoVentana) {
    const ahoraLocal = puntos.find((p) => p.ahora)?.ahora?.t ?? picoVentana.t;
    const dia = etiquetaDia(picoVentana.t.slice(0, 10), ahoraLocal);
    picoVentana.texto = `${dia === "Hoy" || dia === "Mañana" ? dia.toLowerCase() : `el ${dia.toLowerCase()}`} ${aLas(horaDe(picoVentana.t))}`;
    const horasVentana = Math.max(...puntos.map((p) => p.horas.length));
    frasePico = `En las próximas ${horasVentana} horas la ola más alta se espera en ${picoVentana.nombre} ${picoVentana.texto}: ${fmtAltura(picoVentana.valor)} (${estadoMar(picoVentana.valor)!.nombre.toLowerCase()}).`;
  }
  return { olaAhora, puntoMasOla, aguaAhora, picoVentana, fraseAhora, fraseAgua, frasePico };
}

// ---------------------------------------------------------------------------------------------
// Boletín costero de AEMET
// ---------------------------------------------------------------------------------------------

export type SubzonaPagina = SubzonaCostera & {
  /** Fuerzas Beaufort que cita el texto, para la leyenda */
  fuerzas: FuerzaBeaufort[];
  /** Estados de la mar que cita el texto */
  estados: EstadoMar[];
  /** Puntos de la costa dentro de la subzona (ids de puntos-costa-almeria.json), de oeste a este */
  puntos: { id: string; nombre: string }[];
};

export type CosteraPagina = {
  id: string | null; // "FQXX47"
  /** "31 de octubre de 2026 a las 21:00" */
  elaboradoTexto: string;
  /** "Del sábado 31 a las 21:00 al domingo 1 a las 21:00" */
  validezTexto: string | null;
  /** La validez no ha terminado */
  vigente: boolean;
  /** Hay aviso para la zona costera (el texto no es "No hay avisos") */
  hayAviso: boolean;
  /** Texto del aviso tal cual o null si no hay */
  aviso: string | null;
  situacion: string | null;
  tendencia: string | null;
  /** "Tendencia para el domingo 1 a las 21:00 y el lunes 2" */
  tendenciaTexto: string | null;
  /** Costa Sur primero (de oeste a este) y después Costa Oriental */
  subzonas: SubzonaPagina[];
  /** Aguas costeras de la isla de Alborán (término municipal de Almería) */
  alboran: SubzonaPagina | null;
};

const ORDEN_SUBZONAS = [8010412, 8010411]; // Costa Sur de Almería, Costa Oriental de Almería
const ZONA_ALMERIA = 8010410;
const ZONA_ALBORAN = 8012920;

/** Boletín costero preparado para la página, o null si nunca se ha descargado. */
export function costeraPagina(ahora: Date = new Date(), mar: MarJson | null = getMar()): CosteraPagina | null {
  const c = mar?.costera;
  if (!c) return null;
  const puntosDe = (id: number) => (mar?.puntos ?? []).filter((p) => p.subzonaAemet === id).map((p) => ({ id: p.id, nombre: p.nombre }));
  const preparar = (s: SubzonaCostera): SubzonaPagina => ({ ...s, fuerzas: fuerzasEnTexto(s.texto), estados: estadosEnTexto(s.texto), puntos: puntosDe(s.id) });
  const almeria = c.zonas.find((z) => z.id === ZONA_ALMERIA)?.subzonas ?? [];
  const subzonas = [...almeria].sort((a, b) => {
    const ia = ORDEN_SUBZONAS.indexOf(a.id);
    const ib = ORDEN_SUBZONAS.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const alb = c.zonas.find((z) => z.id === ZONA_ALBORAN)?.subzonas[0] ?? null;
  const tIni = msAemet(c.inicio);
  const tFin = msAemet(c.fin);
  const avisoTexto = c.aviso?.texto ?? null;
  const hayAviso = !!avisoTexto && !/^no hay avisos?\.?$/i.test(avisoTexto.trim());
  const tendIni = msAemet(c.tendencia?.inicio);
  const tendFin = msAemet(c.tendencia?.fin);
  const elaboradoMs = msAemet(c.elaborado);
  return {
    id: c.id,
    elaboradoTexto: Number.isFinite(elaboradoMs) ? textoActualizacion(new Date(elaboradoMs).toISOString()) : "sin datos",
    validezTexto: Number.isFinite(tIni) && Number.isFinite(tFin) ? `Del ${diaYHora(tIni)} al ${diaYHora(tFin)}` : null,
    vigente: Number.isFinite(tFin) ? tFin > ahora.getTime() : false,
    hayAviso,
    aviso: hayAviso ? avisoTexto : null,
    situacion: c.situacion?.texto ?? null,
    tendencia: c.tendencia?.texto ?? null,
    tendenciaTexto: Number.isFinite(tendIni) && Number.isFinite(tendFin) ? `Tendencia del ${diaYHora(tendIni)} al ${diaYHora(tendFin)}` : null,
    subzonas: subzonas.map(preparar),
    alboran: alb ? preparar(alb) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Fuente y actualización
// ---------------------------------------------------------------------------------------------

export type FuenteMar = {
  /** Descarga del oleaje (ISO UTC) */
  actualizado: string | null;
  /** "1 de noviembre de 2026 a las 02:45" */
  actualizadoTexto: string;
  /** Más de HORAS_DESFASE_MAR horas sin oleaje nuevo */
  desfasado: boolean;
  /** "La predicción costera de AEMET se elaboró el 31 de octubre de 2026 a las 21:00." */
  fraseCostera: string | null;
  /** Nombres de los puntos, de oeste a este: "Adra, Balerma… y San Juan de los Terreros" */
  puntosTexto: string;
};

export function fuenteMar(ahora: Date = new Date(), mar: MarJson | null = getMar()): FuenteMar {
  const c = costeraPagina(ahora, mar);
  return {
    actualizado: mar?.actualizado ?? null,
    actualizadoTexto: textoActualizacion(mar?.actualizado),
    desfasado: horasDesde(mar?.actualizado, ahora.getTime()) > HORAS_DESFASE_MAR,
    fraseCostera: c ? `La predicción costera de AEMET se elaboró el ${c.elaboradoTexto}.` : null,
    puntosTexto: listaFmt.format((mar?.puntos ?? []).map((p) => p.nombre)),
  };
}
