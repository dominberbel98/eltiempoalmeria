// Lectura de src/data/playas.json (predicción de playas de AEMET) y preparación de los listados de /playas/,
// /playas/[playa]/ y del bloque de playas de cada municipio. Solo se ejecuta en el build.
// Si playas.json no existe, las playas salen de scripts/playas-almeria.json sin predicción (`dias: []`), para que
// las páginas se generen igual y digan "sin datos". Los valores que faltan son null (nunca 0) y se muestran como "—".
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DiaPlaya, EstadoNivel, EstadoPlaya, Franja, MaestroPlayas, MunicipioPlaya, Playa, PlayaMaestro, PlayasJson } from "../../scripts/fuentes/playas";
import type { Cielo } from "./tiempo";

export type { DiaPlaya, EstadoNivel, EstadoPlaya, Franja, MunicipioPlaya, Playa, PlayaMaestro, PlayasJson };

const RUTA = path.resolve("src/data/playas.json");
const RUTA_MAESTRO = path.resolve("scripts/playas-almeria.json");
const ZONA = "Europe/Madrid";

export const ATRIBUCION_PLAYAS = "Predicción de playas: Información elaborada por la Agencia Estatal de Meteorología (AEMET).";
export const URL_PLAYAS_AEMET = "https://www.aemet.es/es/eltiempo/prediccion/playas";
/** AEMET elabora la predicción de playas una vez al día, hacia las 08:50 UTC (09:50 en invierno, 10:50 en verano). */
export const NOTA_ELABORACION = "AEMET elabora la predicción de playas una vez al día, a media mañana, para hoy y los dos días siguientes.";

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

let cache: { mtime: number; datos: PlayasJson } | null = null;

function leerMaestro(): PlayasJson {
  try {
    const m = JSON.parse(readFileSync(RUTA_MAESTRO, "utf8")) as MaestroPlayas;
    return { actualizado: null, playas: (m.playas ?? []).map((p) => ({ ...p, elaborado: null, dias: [] })) };
  } catch {
    return { actualizado: null, playas: [] };
  }
}

/** playas.json, o las playas del maestro sin predicción si no existe o no se puede leer. Nunca lanza. */
export function getPlayas(): PlayasJson {
  if (!existsSync(RUTA)) return leerMaestro();
  try {
    const mtime = statSync(RUTA).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.datos;
    const datos = JSON.parse(readFileSync(RUTA, "utf8")) as PlayasJson;
    if (!datos || !Array.isArray(datos.playas) || !datos.playas.length) return leerMaestro();
    for (const p of datos.playas) if (!Array.isArray(p.dias)) p.dias = [];
    cache = { mtime, datos };
    return datos;
  } catch {
    return leerMaestro();
  }
}

/** Todas las playas, en el orden del maestro (municipio y nombre). */
export const listaPlayas = (datos: PlayasJson = getPlayas()): Playa[] => datos.playas;

/** Una playa por su slug (o por su id AEMET de 7 dígitos). */
export function getPlaya(slugOId: string, datos: PlayasJson = getPlayas()): Playa | null {
  return datos.playas.find((p) => p.slug === slugOId || p.id === slugOId) ?? null;
}

/** Playas de un municipio, por id INE ("04013") o slug ("almeria"). Vacío si no tiene playas de AEMET. */
export function playasDeMunicipio(idOSlug: string, datos: PlayasJson = getPlayas()): Playa[] {
  return datos.playas.filter((p) => p.municipio.id === idOSlug || p.municipio.slug === idOSlug);
}

export type MunicipioConPlayas = { municipio: MunicipioPlaya; playas: Playa[] };

/** Municipios costeros con playas de AEMET, por orden alfabético, con sus playas. */
export function municipiosConPlayas(datos: PlayasJson = getPlayas()): MunicipioConPlayas[] {
  const grupos = new Map<string, MunicipioConPlayas>();
  for (const p of datos.playas) {
    const g = grupos.get(p.municipio.id) ?? { municipio: p.municipio, playas: [] };
    g.playas.push(p);
    grupos.set(p.municipio.id, g);
  }
  return [...grupos.values()].sort((a, b) => a.municipio.nombre.localeCompare(b.municipio.nombre, "es"));
}

// ---------------------------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------------------------

/** Fecha de hoy en Madrid, "YYYY-MM-DD". */
export const hoyMadrid = (d: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** `elaborado` de AEMET (UTC sin "Z") a milisegundos; NaN si no vale. */
export function msElaborado(elaborado: string | null | undefined): number {
  if (!elaborado) return Number.NaN;
  const s = elaborado.trim();
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s + "Z");
}

/** "31 de octubre a las 09:51" en hora de Madrid (o "a la 01:05"); null si no hay fecha válida. */
export function textoElaborado(elaborado: string | null | undefined): string | null {
  const t = msElaborado(elaborado);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const fecha = d.toLocaleDateString("es-ES", { timeZone: ZONA, day: "numeric", month: "long" });
  const hora = d.toLocaleTimeString("es-ES", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${fecha} ${hora.startsWith("01:") ? "a la" : "a las"} ${hora}`;
}

/** Días de la predicción desde hoy (Madrid): quita los días ya pasados. */
export const diasVigentes = (p: Playa, hoy = hoyMadrid()): DiaPlaya[] => p.dias.filter((d) => d.fecha >= hoy);

/** El día de hoy, o el primero vigente si AEMET aún no ha publicado el de hoy; null si no hay ninguno. */
export const diaDeHoy = (p: Playa, hoy = hoyMadrid()): DiaPlaya | null => diasVigentes(p, hoy)[0] ?? null;

/** "Hoy", "Mañana" o "Lunes 2". */
export function nombreDiaPlaya(fecha: string, hoy = hoyMadrid()): string {
  const d = Math.round((Date.parse(`${fecha}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / 86_400_000);
  if (d === 0) return "Hoy";
  if (d === 1) return "Mañana";
  const f = new Date(`${fecha}T12:00:00Z`);
  return `${DIAS[f.getUTCDay()]} ${f.getUTCDate()}`;
}
const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// ---------------------------------------------------------------------------------------------
// Textos de los códigos de AEMET
// ---------------------------------------------------------------------------------------------

const TEXTO_CIELO: Record<number, string> = { 100: "despejado", 110: "nuboso", 120: "muy nuboso", 130: "chubascos", 140: "lluvia" };
const TEXTO_VIENTO: Record<number, string> = { 210: "flojo", 220: "moderado", 230: "fuerte" };
const TEXTO_OLEAJE: Record<number, string> = { 310: "débil", 320: "moderado", 330: "fuerte" };
const TEXTO_SENSACION: Record<number, string> = {
  410: "muy frío",
  420: "frío",
  430: "muy fresco",
  440: "fresco",
  450: "suave",
  460: "calor agradable",
  470: "calor moderado",
  480: "calor fuerte",
};

const deMapa = (mapa: Record<number, string>, codigo: number | null | undefined) => (codigo == null ? null : (mapa[codigo] ?? null));
/** 100 -> "despejado", 110 "nuboso", 120 "muy nuboso", 130 "chubascos", 140 "lluvia". */
export const textoCielo = (codigo: number | null | undefined) => deMapa(TEXTO_CIELO, codigo);
/** 210 -> "flojo", 220 "moderado", 230 "fuerte". */
export const textoViento = (codigo: number | null | undefined) => deMapa(TEXTO_VIENTO, codigo);
/** 310 -> "débil", 320 "moderado", 330 "fuerte". */
export const textoOleaje = (codigo: number | null | undefined) => deMapa(TEXTO_OLEAJE, codigo);
/** 410-480 -> "muy frío" … "calor fuerte". */
export const textoSensacion = (codigo: number | null | undefined) => deMapa(TEXTO_SENSACION, codigo);

/** Texto de una franja: el de AEMET si viene, si no el de la tabla; "—" si falta. */
export const textoFranja = (f: Franja | null | undefined, mapa: (c: number | null) => string | null) => f?.texto ?? mapa(f?.codigo ?? null) ?? "—";

/** Icono del sistema de la web (src/lib/tiempo.ts) para un código de cielo de playas. */
export function cieloIcono(codigo: number | null | undefined): Cielo | null {
  switch (codigo) {
    case 100:
      return "despejado";
    case 110:
      return "nuboso";
    case 120:
      return "cubierto";
    case 130:
    case 140:
      return "lluvia";
    default:
      return null;
  }
}

/** Categoría del índice UV de la OMS: "bajo" (0-2), "moderado" (3-5), "alto" (6-7), "muy alto" (8-10), "extremo" (11+). */
export function categoriaUv(uv: number | null | undefined): "bajo" | "moderado" | "alto" | "muy alto" | "extremo" | null {
  if (uv == null || !Number.isFinite(uv)) return null;
  if (uv < 3) return "bajo";
  if (uv < 6) return "moderado";
  if (uv < 8) return "alto";
  if (uv < 11) return "muy alto";
  return "extremo";
}

/** Consejo breve según el UV máximo; null si es bajo o falta. */
export function consejoUv(uv: number | null | undefined): string | null {
  const c = categoriaUv(uv);
  if (c === "moderado") return "Protección solar en las horas centrales.";
  if (c === "alto") return "Protección solar alta; evita el sol del mediodía.";
  if (c === "muy alto" || c === "extremo") return "Protección solar máxima; evita el sol entre las 12 y las 17.";
  return null;
}

const minuscula = (s: string) => (s ? s.charAt(0).toLocaleLowerCase("es") + s.slice(1) : s);

/** "Oleaje débil, viento flojo" u "Oleaje débil por la mañana y moderado por la tarde, viento flojo"; null si falta todo. */
export function fraseMar(d: DiaPlaya | null | undefined): string | null {
  if (!d) return null;
  const partes = [d.oleaje.texto ? `oleaje ${minuscula(d.oleaje.texto)}` : null, d.viento.texto ? `viento ${minuscula(d.viento.texto)}` : null].filter(
    (x): x is string => !!x
  );
  if (!partes.length) return null;
  const s = partes.join(", ");
  return s.charAt(0).toLocaleUpperCase("es") + s.slice(1);
}

// ---------------------------------------------------------------------------------------------
// Estado del mar y resumen para listados
// ---------------------------------------------------------------------------------------------

export type EstadoMar = "buena" | "regular" | "mala" | "sin-datos";

export const TEXTO_ESTADO_MAR: Record<EstadoMar, string> = {
  buena: "Mar en calma",
  regular: "Mar movida",
  mala: "Mar fuerte",
  "sin-datos": "Sin predicción",
};

/**
 * Puntuación de un día para ordenar playas: menor es mejor. Pesa más el oleaje que el viento y cuentan mañana y tarde
 * (de 6 a 18). null si no hay códigos de oleaje ni de viento.
 */
export function puntuacionMar(d: DiaPlaya | null | undefined): number | null {
  if (!d) return null;
  const n = (f: Franja, mapa: Record<number, string>) => (f.codigo != null && f.codigo in mapa ? Math.round((f.codigo % 100) / 10) : null);
  const ole = [n(d.oleaje.manana, TEXTO_OLEAJE), n(d.oleaje.tarde, TEXTO_OLEAJE)];
  const vie = [n(d.viento.manana, TEXTO_VIENTO), n(d.viento.tarde, TEXTO_VIENTO)];
  if ([...ole, ...vie].every((x) => x == null)) return null;
  // Lo que falte cuenta como lo otro de la misma franja del día, o como débil/flojo
  const val = (a: number | null, b: number | null) => a ?? b ?? 1;
  return 2 * (val(ole[0], ole[1]) + val(ole[1], ole[0])) + val(vie[0], vie[1]) + val(vie[1], vie[0]);
}

/** buena: oleaje débil y viento flojo todo el día; mala: oleaje o viento fuerte en alguna franja; regular: el resto. */
export function estadoMar(d: DiaPlaya | null | undefined): EstadoMar {
  if (!d) return "sin-datos";
  const niveles = [d.oleaje.nivel, d.viento.nivel].filter((x): x is 1 | 2 | 3 => x != null);
  if (!niveles.length) return "sin-datos";
  const max = Math.max(...niveles);
  return max >= 3 ? "mala" : max === 2 ? "regular" : "buena";
}

export type ResumenPlaya = {
  playa: Playa;
  dia: DiaPlaya | null; // el de la fecha pedida (o el primero vigente si se pide hoy y no hay)
  fecha: string | null;
  estado: EstadoMar;
  estadoTexto: string; // "Mar en calma"
  puntuacion: number | null; // 6-18, menor es mejor
  cielo: string | null; // "Despejado por la mañana y nuboso por la tarde"
  icono: Cielo | null; // el de la tarde si cambia, que es cuando más se va a la playa
  mar: string | null; // "Oleaje débil, viento flojo"
  tMax: number | null;
  tAgua: number | null;
  uvMax: number | null;
  uvCategoria: ReturnType<typeof categoriaUv>;
  sensacion: string | null;
  elaborado: string | null; // "31 de octubre a las 09:51"
};

/** Resumen de una playa para un día (por defecto hoy en Madrid). */
export function resumenPlaya(p: Playa, fecha?: string, hoy = hoyMadrid()): ResumenPlaya {
  const dia = fecha ? (p.dias.find((d) => d.fecha === fecha) ?? null) : diaDeHoy(p, hoy);
  const estado = estadoMar(dia);
  return {
    playa: p,
    dia,
    fecha: dia?.fecha ?? null,
    estado,
    estadoTexto: TEXTO_ESTADO_MAR[estado],
    puntuacion: puntuacionMar(dia),
    cielo: dia?.cielo.texto ?? null,
    icono: cieloIcono(dia?.cielo.tarde.codigo ?? dia?.cielo.manana.codigo),
    mar: fraseMar(dia),
    tMax: dia?.tMax ?? null,
    tAgua: dia?.tAgua ?? null,
    uvMax: dia?.uvMax ?? null,
    uvCategoria: categoriaUv(dia?.uvMax),
    sensacion: dia ? textoFranja(dia.sensacion, textoSensacion) : null,
    elaborado: textoElaborado(p.elaborado),
  };
}

export type ResumenListado = {
  fecha: string | null; // día resumido ("YYYY-MM-DD")
  filas: ResumenPlaya[]; // en el orden recibido (el del maestro)
  /** Playas con mejor estado (menor puntuación). Vacío si todas están igual o no hay datos. */
  mejores: ResumenPlaya[];
  /** Playas con peor estado (mayor puntuación). Vacío si todas están igual o no hay datos. */
  peores: ResumenPlaya[];
  /** true si todas las playas con datos tienen el mismo oleaje y viento. */
  iguales: boolean;
  conDatos: number;
  sinDatos: number;
  /** "Oleaje débil y viento flojo en todas las playas." o "Mar fuerte en 3 playas: Balerma, …". null sin datos. */
  frase: string | null;
  tAguaMin: number | null;
  tAguaMax: number | null;
  uvMax: number | null;
  /** Edición más reciente entre las playas: "31 de octubre a las 09:51". */
  elaborado: string | null;
};

const listaFmt = new Intl.ListFormat("es", { style: "long", type: "conjunction" });

/**
 * Resumen de un conjunto de playas (todas, las de un municipio…) para un día. Sin `fecha`, hoy en Madrid; si AEMET aún
 * no tiene el día de hoy, el primer día vigente de la playa más reciente.
 */
export function resumenListado(playas: Playa[] = listaPlayas(), fecha?: string, hoy = hoyMadrid()): ResumenListado {
  const dia =
    fecha ??
    playas
      .map((p) => diaDeHoy(p, hoy)?.fecha)
      .filter((f): f is string => !!f)
      .sort()[0] ??
    null;
  const filas = playas.map((p) => (dia ? resumenPlaya(p, dia, hoy) : resumenPlaya(p, undefined, hoy)));
  const con = filas.filter((f) => f.puntuacion != null);
  const puntos = con.map((f) => f.puntuacion as number);
  const min = puntos.length ? Math.min(...puntos) : null;
  const max = puntos.length ? Math.max(...puntos) : null;
  const iguales = min != null && min === max;
  const mejores = !iguales && min != null ? con.filter((f) => f.puntuacion === min) : [];
  const peores = !iguales && max != null ? con.filter((f) => f.puntuacion === max) : [];
  const valores = (k: "tAgua" | "uvMax") => con.map((f) => f[k]).filter((v): v is number => v != null);
  const aguas = valores("tAgua");
  const uvs = valores("uvMax");

  let frase: string | null = null;
  if (con.length) {
    if (iguales) {
      const m = con[0].mar;
      frase = m ? `${m} en ${con.length === filas.length ? "todas las playas" : `las ${con.length} playas con predicción`}.` : null;
    } else {
      const malas = con.filter((f) => f.estado === "mala");
      const nombres = (xs: ResumenPlaya[]) => listaFmt.format(xs.slice(0, 4).map((f) => f.playa.nombre)) + (xs.length > 4 ? " y otras" : "");
      if (malas.length) frase = `Mar fuerte en ${malas.length === 1 ? "una playa" : `${malas.length} playas`}: ${nombres(malas)}.`;
      else frase = `Las mejores condiciones, en ${nombres(mejores)}.`;
    }
  }
  const elab = playas.map((p) => msElaborado(p.elaborado)).filter(Number.isFinite);
  return {
    fecha: dia,
    filas,
    mejores,
    peores,
    iguales,
    conDatos: con.length,
    sinDatos: filas.length - con.length,
    frase,
    tAguaMin: aguas.length ? Math.min(...aguas) : null,
    tAguaMax: aguas.length ? Math.max(...aguas) : null,
    uvMax: uvs.length ? Math.max(...uvs) : null,
    elaborado: elab.length ? textoElaborado(new Date(Math.max(...elab)).toISOString()) : null,
  };
}

/** Playas ordenadas de mejor a peor para un día; las que no tienen datos, al final. */
export function ordenarPorMar(filas: ResumenPlaya[]): ResumenPlaya[] {
  return [...filas].sort(
    (a, b) =>
      (a.puntuacion ?? Number.POSITIVE_INFINITY) - (b.puntuacion ?? Number.POSITIVE_INFINITY) ||
      a.playa.nombre.localeCompare(b.playa.nombre, "es")
  );
}
