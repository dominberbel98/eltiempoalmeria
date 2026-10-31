// Lectura de src/data/agro.json (RIA, IFAPA) y preparación de los bloques de la página /agro/.
// Solo se ejecuta en el build. Todas las estaciones RIA de Almería miden al aire libre: no hay datos de
// dentro de invernadero. Los valores que faltan son null (nunca 0) y se muestran como "—".
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgroJson, DiaRia, EstacionRia, EstadoEstacion, ReferenciaMunicipio } from "../../scripts/fuentes/ria";

export type { AgroJson, DiaRia, EstacionRia, EstadoEstacion, ReferenciaMunicipio };

const RUTA = path.resolve("src/data/agro.json");
const ZONA = "Europe/Madrid";
const KMH = 3.6; // la RIA da el viento en m/s

export const ATRIBUCION_RIA =
  "Datos agroclimáticos: Red de Información Agroclimática de Andalucía (RIA), IFAPA, Junta de Andalucía. Información obtenida del Portal IFAPA.";
export const URL_RIA = "https://www.juntadeandalucia.es/agriculturaypesca/ifapa/riaweb/web/";
export const NOTA_AIRE_LIBRE =
  "Las estaciones RIA de Almería miden al aire libre: ninguna está bajo plástico. Dentro del invernadero las temperaturas y la humedad son otras.";

/** Grupos de la comparación de la maqueta (códigos de estación RIA). */
export const ZONAS_INVERNADERO = ["1", "10", "11"]; // La Mojonera, Adra, Níjar
export const ZONAS_INTERIOR = ["4", "5", "12"]; // Tabernas, Fiñana, Tíjola

export const UMBRAL_HELADA = 0; // °C, mínima ≤ 0
export const UMBRAL_HELADA_DEBIL = 2; // °C, mínima ≤ 2: riesgo de helada en el suelo o en zonas bajas
export const UMBRAL_CALOR = 35; // °C, máxima ≥ 35
export const UMBRAL_CALOR_EXTREMO = 40; // °C, máxima ≥ 40

// ---------------------------------------------------------------------------------------------
// Lectura y formato
// ---------------------------------------------------------------------------------------------

let cache: { mtime: number; datos: AgroJson | null } | null = null;

/** agro.json o null si no existe o no se puede leer (la página debe mostrar "sin datos"). */
export function getAgro(): AgroJson | null {
  if (!existsSync(RUTA)) return null;
  try {
    const mtime = statSync(RUTA).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.datos;
    const datos = JSON.parse(readFileSync(RUTA, "utf8")) as AgroJson;
    if (!datos || !Array.isArray(datos.estaciones)) return null;
    cache = { mtime, datos };
    return datos;
  } catch {
    return null;
  }
}

const numFmt = new Map<string, Intl.NumberFormat>();
/** Número en formato español con `dec` decimales fijos; "—" si falta. */
export function fmtNum(v: number | null | undefined, dec = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const clave = String(dec);
  if (!numFmt.has(clave)) numFmt.set(clave, new Intl.NumberFormat("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false }));
  return numFmt.get(clave)!.format(v === 0 ? 0 : v).replace("-", "−");
}
/** Lluvia: "0 mm" sin decimales cuando es 0, "0,2 mm" si no. */
export const fmtLluvia = (v: number | null | undefined) => (v == null ? "—" : v === 0 ? "0 mm" : `${fmtNum(v, 1)} mm`);
/** Con signo: "−24,7", "+3,2", "0,0". */
export const fmtSigno = (v: number | null | undefined, dec = 1) =>
  v == null ? "—" : v > 0 ? `+${fmtNum(v, dec)}` : fmtNum(v, dec);
/** m/s -> km/h redondeado */
export const kmh = (ms: number | null | undefined) => (ms == null ? null : Math.round(ms * KMH));

const listaFmt = new Intl.ListFormat("es", { style: "long", type: "conjunction" });
export const unirNombres = (nombres: string[]) => listaFmt.format(nombres);

const DIA_MS = 86_400_000;
const utc = (f: string) => new Date(`${f}T12:00:00Z`);
export const hoyMadrid = (d: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const diasEntre = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / DIA_MS);
const sumarDias = (f: string, n: number) => new Date(utc(f).getTime() + n * DIA_MS).toISOString().slice(0, 10);

/** "27 de octubre" */
export const fechaDia = (f: string) => new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", day: "numeric", month: "long" }).format(utc(f));
/** "martes 3 de noviembre" */
export const fechaDiaSemana = (f: string) =>
  new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(utc(f)).replace(",", "");
/** "ayer, 27 de octubre" / "hoy" / "el 25 de octubre" según la distancia a hoy (Madrid) */
export function fechaRelativa(f: string, hoy = hoyMadrid()): string {
  const d = diasEntre(f, hoy);
  if (d === 0) return "hoy";
  if (d === 1) return `ayer, ${fechaDia(f)}`;
  if (d === -1) return "mañana";
  return `el ${fechaDia(f)}`;
}

const media = (vals: (number | null | undefined)[]) => {
  const v = vals.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

const diaDe = (e: EstacionRia, fecha: string | null): DiaRia | null => (fecha ? e.dias.find((d) => d.fecha === fecha) ?? null : null);

// ---------------------------------------------------------------------------------------------
// Cabecera: ETo media del último día
// ---------------------------------------------------------------------------------------------

export type ResumenAgro = {
  fecha: string | null; // último día con datos de la red (normalmente ayer)
  fechaTexto: string | null; // "ayer, 27 de octubre"
  estacionesActivas: number;
  estacionesConDato: number; // con datos ese día
  et0Media: number | null; // mm, media de las estaciones con ET0 ese día
  /** Estaciones donde la lluvia de los últimos 7 días cubre la ETo de esos días */
  cubiertas: string[];
  /** "En la última semana no ha llovido lo suficiente para cubrirla en ninguna estación." */
  fraseBalance: string | null;
  ultimaCargaRia: string | null;
};

export function resumenAgro(agro: AgroJson | null = getAgro(), hoy = hoyMadrid()): ResumenAgro {
  const vacio: ResumenAgro = {
    fecha: null, fechaTexto: null, estacionesActivas: 0, estacionesConDato: 0, et0Media: null, cubiertas: [], fraseBalance: null, ultimaCargaRia: null,
  };
  if (!agro) return vacio;
  const fecha = agro.ultimoDiaDisponible;
  const delDia = agro.estaciones.map((e) => diaDe(e, fecha)).filter((d): d is DiaRia => !!d);
  const conBalance = agro.estaciones.filter((e) => e.estado !== "sin-datos" && e.acumulados.balance_7d != null);
  const cubiertas = conBalance.filter((e) => (e.acumulados.balance_7d as number) >= 0).map((e) => e.nombre);
  let fraseBalance: string | null = null;
  if (conBalance.length) {
    if (!cubiertas.length) fraseBalance = "En la última semana no ha llovido lo suficiente para cubrirla en ninguna estación.";
    else if (cubiertas.length === conBalance.length) fraseBalance = "En la última semana la lluvia ha cubierto la ETo en todas las estaciones.";
    else fraseBalance = `En la última semana la lluvia solo ha cubierto la ETo en ${unirNombres(cubiertas)}.`;
  }
  return {
    fecha,
    fechaTexto: fecha ? fechaRelativa(fecha, hoy) : null,
    estacionesActivas: agro.estaciones.length,
    estacionesConDato: delDia.filter((d) => [d.tMax, d.tMin, d.et0, d.precip].some((v) => v != null)).length,
    et0Media: r1(media(delDia.map((d) => d.et0))),
    cubiertas,
    fraseBalance,
    ultimaCargaRia: agro.ultimaCargaRia,
  };
}

// ---------------------------------------------------------------------------------------------
// ETo y riego (balance de 7 días por estación)
// ---------------------------------------------------------------------------------------------

export type FilaRiego = {
  codigo: string;
  nombre: string;
  altitud: number;
  estado: EstadoEstacion;
  ultimoDia: string | null;
  et0Ultimo: number | null; // ET0 del último día de la red (null si la estación no lo tiene)
  et0_7d: number | null;
  precip_7d: number | null;
  balance_7d: number | null; // lluvia − ETo, mm (negativo = déficit)
  diasConEt0_7d: number;
  parcial: boolean; // la ET0 de 7 días no cubre los 7 días
  /** Ancho de la barra en % (sobre una escala común redondeada a 5 mm) */
  anchoBarra: number;
  deficit: boolean;
};

export type TablaRiego = {
  filas: FilaRiego[]; // de mayor déficit a menor
  escalaMm: number; // fondo de escala de las barras
  sinDatos: string[]; // estaciones sin datos en la última semana
  /** "Huércal-Overa no ha enviado datos esta semana." o null */
  notaSinDatos: string | null;
  fecha: string | null;
};

export function tablaRiego(agro: AgroJson | null = getAgro()): TablaRiego {
  if (!agro) return { filas: [], escalaMm: 5, sinDatos: [], notaSinDatos: null, fecha: null };
  const ref = agro.ultimoDiaDisponible;
  const con = agro.estaciones.filter((e) => e.acumulados.diasConEt0_7d > 0 || e.acumulados.diasConPrecip_7d > 0);
  const sinDatos = agro.estaciones.filter((e) => !con.includes(e)).map((e) => e.nombre);
  const maxAbs = Math.max(0, ...con.map((e) => Math.abs(e.acumulados.balance_7d ?? 0)));
  const escalaMm = Math.max(5, Math.ceil(maxAbs / 5) * 5);
  const filas: FilaRiego[] = con.map((e) => {
    const a = e.acumulados;
    return {
      codigo: e.codigo,
      nombre: e.nombre,
      altitud: e.altitud,
      estado: e.estado,
      ultimoDia: e.ultimoDia,
      et0Ultimo: diaDe(e, ref)?.et0 ?? null,
      et0_7d: a.et0_7d,
      precip_7d: a.precip_7d,
      balance_7d: a.balance_7d,
      diasConEt0_7d: a.diasConEt0_7d,
      parcial: a.diasConEt0_7d < 7,
      anchoBarra: a.balance_7d == null ? 0 : Math.round((Math.abs(a.balance_7d) / escalaMm) * 1000) / 10,
      deficit: (a.balance_7d ?? 0) < 0,
    };
  });
  filas.sort((x, y) => (x.balance_7d ?? Infinity) - (y.balance_7d ?? Infinity) || x.nombre.localeCompare(y.nombre, "es"));
  const notaSinDatos = sinDatos.length
    ? `${unirNombres(sinDatos)} ${sinDatos.length === 1 ? "no ha enviado" : "no han enviado"} datos esta semana.`
    : null;
  return { filas, escalaMm, sinDatos, notaSinDatos, fecha: ref };
}

// ---------------------------------------------------------------------------------------------
// Zonas de invernadero frente a interior
// ---------------------------------------------------------------------------------------------

export type GrupoZona = {
  id: "invernadero" | "interior";
  titulo: string; // "Zonas de invernadero" / "Interior"
  estaciones: string[]; // nombres de las estaciones del grupo
  estacionesTexto: string; // "La Mojonera, Adra y Níjar"
  fecha: string | null;
  usadas: number; // estaciones con dato ese día
  faltan: string[]; // estaciones del grupo sin dato ese día
  /** Medias del último día de la red */
  dia: { tMax: number | null; tMin: number | null; hrMed: number | null; radiacion: number | null; et0: number | null };
  /** Medias de los últimos 7 días (de las medias diarias de cada estación) */
  semana: { tMax: number | null; tMin: number | null; hrMed: number | null; radiacion: number | null; et0_7d: number | null; precip_7d: number | null };
};

export type ComparacionZonas = { grupos: GrupoZona[]; todasAlAireLibre: boolean; nota: string; fecha: string | null };

export function comparacionZonas(agro: AgroJson | null = getAgro()): ComparacionZonas {
  const fecha = agro?.ultimoDiaDisponible ?? null;
  const grupo = (id: GrupoZona["id"], titulo: string, codigos: string[]): GrupoZona => {
    const est = (agro?.estaciones ?? []).filter((e) => codigos.includes(e.codigo)).sort((a, b) => codigos.indexOf(a.codigo) - codigos.indexOf(b.codigo));
    const delDia = est.map((e) => ({ e, d: diaDe(e, fecha) }));
    const usadas = delDia.filter(({ d }) => d && (d.tMax != null || d.tMin != null));
    const ventana = (e: EstacionRia) => (fecha ? e.dias.filter((d) => d.fecha > sumarDias(fecha, -7) && d.fecha <= fecha) : []);
    const mediaSemana = (c: "tMax" | "tMin" | "hrMed" | "radiacion") => r1(media(est.map((e) => media(ventana(e).map((d) => d[c])))));
    return {
      id,
      titulo,
      estaciones: est.map((e) => e.nombre),
      estacionesTexto: unirNombres(est.map((e) => e.nombre)),
      fecha,
      usadas: usadas.length,
      faltan: delDia.filter((x) => !usadas.includes(x)).map(({ e }) => e.nombre),
      dia: {
        tMax: r1(media(usadas.map(({ d }) => d!.tMax))),
        tMin: r1(media(usadas.map(({ d }) => d!.tMin))),
        hrMed: r1(media(usadas.map(({ d }) => d!.hrMed))),
        radiacion: r1(media(usadas.map(({ d }) => d!.radiacion))),
        et0: r1(media(usadas.map(({ d }) => d!.et0))),
      },
      semana: {
        tMax: mediaSemana("tMax"),
        tMin: mediaSemana("tMin"),
        hrMed: mediaSemana("hrMed"),
        radiacion: mediaSemana("radiacion"),
        et0_7d: r1(media(est.map((e) => e.acumulados.et0_7d))),
        precip_7d: r1(media(est.map((e) => e.acumulados.precip_7d))),
      },
    };
  };
  const todasAlAireLibre = (agro?.estaciones ?? []).every((e) => !e.bajoPlastico);
  return {
    grupos: [grupo("invernadero", "Zonas de invernadero", ZONAS_INVERNADERO), grupo("interior", "Interior", ZONAS_INTERIOR)],
    todasAlAireLibre,
    nota: todasAlAireLibre
      ? "Las estaciones RIA de Almería miden al aire libre: ninguna está bajo plástico. Comparamos las que están en zonas de invernadero, cerca de la costa, con las del interior. Dentro del invernadero las temperaturas son otras."
      : "Comparamos las estaciones de zonas de invernadero, cerca de la costa, con las del interior. Salvo que se indique, miden al aire libre: dentro del invernadero las temperaturas son otras.",
    fecha,
  };
}

// ---------------------------------------------------------------------------------------------
// Helada y calor: observado (RIA) y previsto (lo pasa la página desde la previsión por municipio o zona)
// ---------------------------------------------------------------------------------------------

export type ExtremoObservado = { valor: number; estaciones: string[]; fechas: string[] } | null;

export type HeladaCalorObservado = {
  dias: number; // ventana (7)
  desde: string | null;
  hasta: string | null;
  minima: ExtremoObservado; // mínima más baja de la ventana y dónde
  maxima: ExtremoObservado; // máxima más alta de la ventana y dónde
  heladas: { nombre: string; dias: number }[]; // estaciones con días de mínima ≤ 0 °C
  calor: { nombre: string; dias: number }[]; // estaciones con días de máxima ≥ 35 °C
  /** "En los últimos 7 días, las mínimas más frías se midieron en Fiñana y Tabernas: 6,8 °C." */
  fraseMinima: string | null;
  fraseMaxima: string | null;
};

export function heladaCalorObservado(agro: AgroJson | null = getAgro(), dias = 7): HeladaCalorObservado {
  const hasta = agro?.ultimoDiaDisponible ?? null;
  const desde = hasta ? sumarDias(hasta, -(dias - 1)) : null;
  const base: HeladaCalorObservado = { dias, desde, hasta, minima: null, maxima: null, heladas: [], calor: [], fraseMinima: null, fraseMaxima: null };
  if (!agro || !hasta || !desde) return base;
  const filas = agro.estaciones.flatMap((e) => e.dias.filter((d) => d.fecha >= desde && d.fecha <= hasta).map((d) => ({ e, d })));
  const extremo = (campo: "tMin" | "tMax", modo: "min" | "max"): ExtremoObservado => {
    const vals = filas.filter(({ d }) => d[campo] != null);
    if (!vals.length) return null;
    const valor = (modo === "min" ? Math.min : Math.max)(...vals.map(({ d }) => d[campo] as number));
    const en = vals.filter(({ d }) => d[campo] === valor);
    return { valor, estaciones: [...new Set(en.map(({ e }) => e.nombre))], fechas: [...new Set(en.map(({ d }) => d.fecha))].sort() };
  };
  const cuenta = (pred: (d: DiaRia) => boolean) =>
    agro.estaciones
      .map((e) => ({ nombre: e.nombre, dias: e.dias.filter((d) => d.fecha >= desde && d.fecha <= hasta && pred(d)).length }))
      .filter((x) => x.dias > 0)
      .sort((a, b) => b.dias - a.dias);
  const minima = extremo("tMin", "min");
  const maxima = extremo("tMax", "max");
  const texto = (x: NonNullable<ExtremoObservado>, singular: string, plural: string) =>
    x.estaciones.length > 1
      ? `En los últimos ${dias} días, las ${plural} se midieron en ${unirNombres(x.estaciones)}: ${fmtNum(x.valor, 1)} °C.`
      : `En los últimos ${dias} días, la ${singular} se midió en ${x.estaciones[0]}: ${fmtNum(x.valor, 1)} °C.`;
  return {
    ...base,
    minima,
    maxima,
    heladas: cuenta((d) => d.tMin != null && d.tMin <= UMBRAL_HELADA),
    calor: cuenta((d) => d.tMax != null && d.tMax >= UMBRAL_CALOR),
    fraseMinima: minima ? texto(minima, "mínima más fría", "mínimas más frías") : null,
    fraseMaxima: maxima ? texto(maxima, "máxima más alta", "máximas más altas") : null,
  };
}

/** Entrada genérica de previsión: un municipio o una zona con sus días (p. ej. desde fichas() o zonas). */
export type EntradaPrevision = { nombre: string; slug?: string; dias: { fecha: string; min: number | null; max: number | null }[] };

export type ExtremoPrevisto = { valor: number; nombre: string; slug?: string; fecha: string; fechaTexto: string } | null;

export type HeladaCalorPrevisto = {
  minima: ExtremoPrevisto;
  maxima: ExtremoPrevisto;
  nivelHelada: "helada" | "debil" | "no";
  nivelCalor: "extremo" | "calor" | "no";
  tituloHelada: string; // "Sin riesgo de helada esta semana"
  tituloCalor: string; // "Sin calor extremo"
  /** "La mínima más baja prevista en la provincia es de 5 °C en María, el martes 3 de noviembre." */
  fraseHelada: string | null;
  /** "La máxima más alta prevista es de 26 °C hoy en Rioja." */
  fraseCalor: string | null;
  municipiosHelada: string[]; // con mínima prevista ≤ 0 °C
  municipiosCalor: string[]; // con máxima prevista ≥ 35 °C
};

/** Extremos previstos en los próximos `dias` días (desde hoy en Madrid). */
export function heladaCalorPrevisto(entradas: EntradaPrevision[], dias = 7, hoy = hoyMadrid()): HeladaCalorPrevisto {
  const hasta = sumarDias(hoy, dias - 1);
  const filas = entradas.flatMap((e) => e.dias.filter((d) => d.fecha >= hoy && d.fecha <= hasta).map((d) => ({ e, d })));
  const cuando = (f: string) => {
    const n = diasEntre(hoy, f);
    return n === 0 ? "hoy" : n === 1 ? "mañana" : `el ${fechaDiaSemana(f)}`;
  };
  const extremo = (campo: "min" | "max"): ExtremoPrevisto => {
    const vals = filas.filter(({ d }) => d[campo] != null);
    if (!vals.length) return null;
    const mejor = vals.reduce((a, b) => (campo === "min" ? ((b.d.min as number) < (a.d.min as number) ? b : a) : (b.d.max as number) > (a.d.max as number) ? b : a));
    return { valor: Math.round(mejor.d[campo] as number), nombre: mejor.e.nombre, slug: mejor.e.slug, fecha: mejor.d.fecha, fechaTexto: cuando(mejor.d.fecha) };
  };
  const minima = extremo("min");
  const maxima = extremo("max");
  const nivelHelada = minima == null ? "no" : minima.valor <= UMBRAL_HELADA ? "helada" : minima.valor <= UMBRAL_HELADA_DEBIL ? "debil" : "no";
  const nivelCalor = maxima == null ? "no" : maxima.valor >= UMBRAL_CALOR_EXTREMO ? "extremo" : maxima.valor >= UMBRAL_CALOR ? "calor" : "no";
  const nombres = (pred: (d: { min: number | null; max: number | null }) => boolean) =>
    [...new Set(filas.filter(({ d }) => pred(d)).map(({ e }) => e.nombre))].sort((a, b) => a.localeCompare(b, "es"));
  const fraseCuando = (x: NonNullable<ExtremoPrevisto>) => (x.fechaTexto === "hoy" || x.fechaTexto === "mañana" ? `${x.fechaTexto} en ${x.nombre}` : `en ${x.nombre}, ${x.fechaTexto}`);
  return {
    minima,
    maxima,
    nivelHelada,
    nivelCalor,
    tituloHelada: nivelHelada === "helada" ? "Helada prevista" : nivelHelada === "debil" ? "Riesgo de helada débil" : `Sin riesgo de helada ${dias === 7 ? "esta semana" : `en ${dias} días`}`,
    tituloCalor: nivelCalor === "extremo" ? "Calor extremo previsto" : nivelCalor === "calor" ? "Calor previsto" : "Sin calor extremo",
    fraseHelada: minima ? `La mínima más baja prevista en la provincia es de ${minima.valor} °C ${fraseCuando(minima)}.` : null,
    fraseCalor: maxima ? `La máxima más alta prevista es de ${maxima.valor} °C ${fraseCuando(maxima)}.` : null,
    municipiosHelada: nombres((d) => d.min != null && Math.round(d.min) <= UMBRAL_HELADA),
    municipiosCalor: nombres((d) => d.max != null && Math.round(d.max) >= UMBRAL_CALOR),
  };
}

// ---------------------------------------------------------------------------------------------
// Lluvia y viento acumulados (7 y 30 días)
// ---------------------------------------------------------------------------------------------

export type FilaAcumulados = {
  codigo: string;
  nombre: string;
  estado: EstadoEstacion;
  precip_7d: number | null;
  precip_30d: number | null;
  diasConPrecip_7d: number;
  diasConPrecip_30d: number;
  racha_7d: number | null; // km/h
  racha_30d: number | null; // km/h
  /** Mayor valor de su columna (para resaltarlo como en la maqueta) */
  destacaLluvia30: boolean;
  destacaRacha7: boolean;
  destacaRacha30: boolean;
};

export function tablaAcumulados(agro: AgroJson | null = getAgro()): { filas: FilaAcumulados[]; fecha: string | null } {
  if (!agro) return { filas: [], fecha: null };
  const est = agro.estaciones.filter((e) => e.acumulados.diasConDatos_30d > 0);
  const filas = est.map((e) => {
    const a = e.acumulados;
    return {
      codigo: e.codigo,
      nombre: e.nombre,
      estado: e.estado,
      precip_7d: a.precip_7d,
      precip_30d: a.precip_30d,
      diasConPrecip_7d: a.diasConPrecip_7d,
      diasConPrecip_30d: a.diasConPrecip_30d,
      racha_7d: kmh(a.vientoMax_7d),
      racha_30d: kmh(a.vientoMax_30d),
      destacaLluvia30: false,
      destacaRacha7: false,
      destacaRacha30: false,
    };
  });
  const marcar = (campo: "precip_30d" | "racha_7d" | "racha_30d", destino: "destacaLluvia30" | "destacaRacha7" | "destacaRacha30") => {
    const max = Math.max(...filas.map((f) => f[campo] ?? -Infinity));
    if (Number.isFinite(max) && max > 0) for (const f of filas) if (f[campo] === max) f[destino] = true;
  };
  marcar("precip_30d", "destacaLluvia30");
  marcar("racha_7d", "destacaRacha7");
  marcar("racha_30d", "destacaRacha30");
  filas.sort((x, y) => (y.precip_30d ?? -1) - (x.precip_30d ?? -1) || x.nombre.localeCompare(y.nombre, "es"));
  return { filas, fecha: agro.ultimoDiaDisponible };
}

// ---------------------------------------------------------------------------------------------
// Estado de cada estación y estación de referencia por municipio
// ---------------------------------------------------------------------------------------------

export const TEXTO_ESTADO: Record<EstadoEstacion, string> = { ok: "Al día", retrasada: "Con retraso", "sin-datos": "Sin datos recientes" };

export type FilaEstado = {
  codigo: string;
  nombre: string;
  altitud: number;
  estado: EstadoEstacion;
  estadoTexto: string;
  ultimoDia: string | null;
  ultimoDiaTexto: string; // "27 de octubre" o "—"
  retrasoDias: number | null;
  conservada: boolean; // la última descarga de esta estación falló y se muestran sus datos anteriores
};

export function estadoEstaciones(agro: AgroJson | null = getAgro()): FilaEstado[] {
  if (!agro) return [];
  return agro.estaciones
    .map((e) => ({
      codigo: e.codigo,
      nombre: e.nombre,
      altitud: e.altitud,
      estado: e.estado,
      estadoTexto: TEXTO_ESTADO[e.estado],
      ultimoDia: e.ultimoDia,
      ultimoDiaTexto: e.ultimoDia ? fechaDia(e.ultimoDia) : "—",
      retrasoDias: e.retrasoDias,
      conservada: !!e.conservada,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

export type EstacionReferencia = {
  estacion: EstacionRia;
  distanciaKm: number;
  difAltitud: number; // municipio − estación, m
  aviso: boolean;
  /** "Fiñana, a 5,7 km y 97 m más baja que el pueblo" */
  frase: string;
  /** Aviso de representatividad o null: "La estación está a más de 20 km y 891 m más baja: sus datos pueden no representar a María." */
  textoAviso: string | null;
  /** Si la más cercana no tiene datos recientes, la más cercana que sí */
  alternativa: { estacion: EstacionRia; distanciaKm: number; difAltitud: number; frase: string } | null;
};

function fraseEstacion(nombre: string, distanciaKm: number, difAltitud: number): string {
  const dif = Math.abs(difAltitud);
  const alt = dif < 25 ? "a una altitud parecida" : `${dif} m más ${difAltitud > 0 ? "baja" : "alta"} que el pueblo`;
  return `${nombre}, a ${fmtNum(distanciaKm, 1)} km y ${alt}`;
}

/** Estación RIA de referencia de un municipio (código INE), con distancia y diferencia de altitud. */
export function estacionDeMunicipio(id: string, nombreMunicipio?: string, agro: AgroJson | null = getAgro()): EstacionReferencia | null {
  const ref = agro?.municipios?.[id];
  if (!agro || !ref) return null;
  const estacion = agro.estaciones.find((e) => e.codigo === ref.estacion);
  if (!estacion) return null;
  const lejos = ref.distanciaKm > 20;
  const desnivel = Math.abs(ref.difAltitud) > 300;
  const motivos = [lejos ? `a más de 20 km` : null, desnivel ? `${Math.abs(ref.difAltitud)} m más ${ref.difAltitud > 0 ? "baja" : "alta"}` : null].filter(Boolean);
  const alt = ref.estacionConDatos ? agro.estaciones.find((e) => e.codigo === ref.estacionConDatos) : undefined;
  return {
    estacion,
    distanciaKm: ref.distanciaKm,
    difAltitud: ref.difAltitud,
    aviso: ref.aviso,
    frase: fraseEstacion(estacion.nombre, ref.distanciaKm, ref.difAltitud),
    textoAviso: ref.aviso
      ? `La estación está ${unirNombres(motivos as string[])}: sus datos pueden no representar ${nombreMunicipio ? `a ${nombreMunicipio}` : "al municipio"}.`
      : null,
    alternativa:
      alt && ref.distanciaConDatosKm != null && ref.difAltitudConDatos != null
        ? { estacion: alt, distanciaKm: ref.distanciaConDatosKm, difAltitud: ref.difAltitudConDatos, frase: fraseEstacion(alt.nombre, ref.distanciaConDatosKm, ref.difAltitudConDatos) }
        : null,
  };
}

/** Atribución y fuente para el pie de /agro/ */
export function fuenteAgro(agro: AgroJson | null = getAgro()) {
  return {
    atribucion: agro?.fuente?.atribucion ?? ATRIBUCION_RIA,
    url: agro?.fuente?.url ?? URL_RIA,
    licencia: agro?.fuente?.licencia ?? null,
    ultimaCargaRia: agro?.ultimaCargaRia ?? null,
    ultimoDia: agro?.ultimoDiaDisponible ?? null,
    descargado: agro?.updatedAt ?? null,
    fallos: agro?.fallos ?? [],
  };
}

/** Fecha del último dato, para el pie: "Datos RIA del 27 de octubre de 2026" */
export function fechaDatosRia(agro: AgroJson | null = getAgro()): string | null {
  const f = agro?.ultimoDiaDisponible;
  return f ? `Datos RIA del ${new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(utc(f))}` : null;
}
