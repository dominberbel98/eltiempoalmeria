// Lectura de src/data/calima.json (scripts/fuentes/calima.ts) y preparación de la página /calima/: polvo mineral en
// superficie (µg/m³) y espesor óptico de aerosoles de CAMS para los 103 municipios, por horas y por días.
// Solo se ejecuta en el build. Los valores que faltan son null (nunca 0) y se muestran como "—".
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NIVELES_CALIMA, nivelCalima, type CalimaJson, type DiaCalima, type NivelCalima, type PuntoCalima } from "../../scripts/fuentes/calima";
import { getMunicipios } from "./datos";
import { diaConNumero, horaLocal, horasDesde, textoActualizacion } from "./tiempo";

export type { CalimaJson, DiaCalima, NivelCalima, PuntoCalima };
export { NIVELES_CALIMA, nivelCalima };

const RUTA = path.resolve("src/data/calima.json");

export const ATRIBUCION_CAMS =
  "Polvo y aerosoles: Servicio de Vigilancia Atmosférica de Copernicus (CAMS), a través de Open-Meteo.com (CC BY 4.0).";
export const ATRIBUCION_OPEN_METEO = "Weather data by Open-Meteo.com (CC BY 4.0)";
export const FUENTE_UMBRALES =
  "Los niveles siguen los tramos de PM10 del Índice Nacional de Calidad del Aire (Orden TEC/351/2019, actualizados por la Resolución de 2 de septiembre de 2020, BOE-A-2020-10426): 20, 50, 100 y 150 µg/m³. 50 µg/m³ es además el valor límite diario de PM10 (Real Decreto 102/2011).";
export const NOTA_CALIMA =
  "Es una previsión del modelo, no una medición: se aplica a la hora con más polvo del día y solo cuenta el polvo mineral, no el resto de partículas. Para la calidad del aire medida, consulta la red de la Junta de Andalucía.";

/** Un día con menos horas que estas no se enseña (el último trozo de la serie). */
export const MIN_HORAS_DIA = 18;
/** A partir de esta antigüedad (h) la página avisa de que la previsión no es reciente (CAMS se publica cada ~12 h). */
export const HORAS_DESFASE_CALIMA = 14;

// ---------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------

let cache: { mtime: number; datos: CalimaJson | null } | null = null;

/** calima.json o null si no existe o no se puede leer (la página debe mostrar "sin datos"). */
export function getCalima(): CalimaJson | null {
  if (!existsSync(RUTA)) return null;
  try {
    const mtime = statSync(RUTA).mtimeMs;
    if (cache && cache.mtime === mtime) return cache.datos;
    const datos = JSON.parse(readFileSync(RUTA, "utf8")) as CalimaJson;
    if (!datos || !Array.isArray(datos.puntos) || !Array.isArray(datos.horas)) return null;
    cache = { mtime, datos };
    return datos;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Niveles y escala de color
// ---------------------------------------------------------------------------------------------

/**
 * Muestra de color de un nivel. `fondo` y `texto` cumplen AA (≥4,5:1) entre sí, comprobado con la fórmula de WCAG 2.
 * `clase` son las utilidades de Tailwind de los mismos tokens de global.css. `borde`: el fondo tiene menos de 3:1 sobre
 * blanco y cal, así que una barra o un punto de ese color en una gráfica necesita un borde de 1 px en ceniza (#56646B).
 */
export type InfoNivel = {
  nivel: NivelCalima;
  nombre: string; // "Calima moderada"
  /** "de 51 a 100 µg/m³" */
  rango: string;
  desde: number; // µg/m³, límite inferior (exclusivo salvo en el primero)
  hasta: number | null; // µg/m³, inclusivo; null en el último
  descripcion: string;
  fondo: string;
  texto: string;
  clase: string;
  borde: boolean;
  contraste: number;
  orden: number; // 0-4
};

/** Escala del polvo: niebla y arenas (temp-4, temp-5) y almagra desde calima intensa. Contrastes: 11,4 · 8,9 · 6,6 · 5,4 · 8,2. */
const COLORES: Record<NivelCalima, Pick<InfoNivel, "fondo" | "texto" | "clase" | "borde" | "contraste" | "descripcion">> = {
  sin: {
    fondo: "#DDE4E2", texto: "#1E2A30", clase: "bg-niebla text-basalto", borde: true, contraste: 11.39,
    descripcion: "Aire sin polvo apreciable.",
  },
  debil: {
    fondo: "#D3C9A6", texto: "#1E2A30", clase: "bg-temp-4 text-basalto", borde: true, contraste: 8.87,
    descripcion: "Algo de polvo en suspensión: el cielo puede verse blanquecino.",
  },
  moderada: {
    fondo: "#D9A27E", texto: "#1E2A30", clase: "bg-temp-5 text-basalto", borde: true, contraste: 6.59,
    descripcion: "Cielo turbio y menos visibilidad. Puede molestar a personas con asma o alergias.",
  },
  intensa: {
    fondo: "#B5472E", texto: "#FFFFFF", clase: "bg-almagra text-blanco", borde: false, contraste: 5.38,
    descripcion: "Mucho polvo. Mejor evitar el ejercicio intenso al aire libre si tienes problemas respiratorios o del corazón.",
  },
  "muy-intensa": {
    fondo: "#8E2F1E", texto: "#FFFFFF", clase: "bg-almagra-oscuro text-blanco", borde: false, contraste: 8.15,
    descripcion: "Episodio fuerte de polvo. Las personas sensibles deberían limitar el tiempo al aire libre.",
  },
};

export const ESCALA_CALIMA: InfoNivel[] = NIVELES_CALIMA.map((n, i) => {
  const desde = i === 0 ? 0 : (NIVELES_CALIMA[i - 1].hasta as number);
  const rango = n.hasta == null ? `más de ${desde} µg/m³` : i === 0 ? `hasta ${n.hasta} µg/m³` : `de ${desde + 1} a ${n.hasta} µg/m³`;
  return { nivel: n.nivel, nombre: n.nombre, rango, desde, hasta: n.hasta, orden: i, ...COLORES[n.nivel] };
});

const POR_NIVEL = new Map(ESCALA_CALIMA.map((n) => [n.nivel, n]));

/** Datos del nivel (nombre, color, descripción). */
export const infoNivel = (nivel: NivelCalima): InfoNivel => POR_NIVEL.get(nivel)!;

/** Color del polvo en µg/m³ (null si falta el dato). */
export function colorPolvo(polvo: number | null | undefined): InfoNivel | null {
  const n = nivelCalima(polvo);
  return n ? infoNivel(n) : null;
}

/**
 * Lectura orientativa del espesor óptico de aerosoles a 550 nm (adimensional): cuánto apagan la luz del sol el polvo y
 * el resto de partículas en toda la columna de aire. No es una escala oficial; con polvo alto en altura el cielo se
 * ve turbio aunque en superficie haya poco.
 */
export function textoAod(aod: number | null | undefined): string | null {
  if (aod == null || !Number.isFinite(aod)) return null;
  if (aod < 0.1) return "Cielo muy limpio";
  if (aod < 0.3) return "Cielo normal";
  if (aod < 0.6) return "Cielo turbio";
  return "Cielo muy turbio";
}

// ---------------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------------

/** "38 µg/m³", "—" */
export const fmtPolvo = (v: number | null | undefined, unidad = true) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}${unidad ? " µg/m³" : ""}`;
/** "0,15", "—" */
export const fmtAod = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Hoy", "Mañana" o "Martes 3" para una fecha "YYYY-MM-DD" respecto a la hora local "YYYY-MM-DDTHH:00". */
export function etiquetaDia(fecha: string, ahoraLocal: string): string {
  const hoy = ahoraLocal.slice(0, 10);
  const manana = new Date(Date.parse(`${hoy}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return fecha === hoy ? "Hoy" : fecha === manana ? "Mañana" : diaConNumero(fecha);
}
/** "hoy", "mañana" o "el martes 3" (en frase) */
const enFrase = (etiqueta: string) => (etiqueta === "Hoy" || etiqueta === "Mañana" ? etiqueta.toLowerCase() : `el ${etiqueta.toLowerCase()}`);
const aLas = (t: string) => (t.slice(11, 13) === "01" ? `a la ${t.slice(11, 16)}` : `a las ${t.slice(11, 16)}`);

const listaFmt = new Intl.ListFormat("es", { style: "long", type: "conjunction" });

// ---------------------------------------------------------------------------------------------
// Municipios
// ---------------------------------------------------------------------------------------------

export type DiaCalimaPagina = DiaCalima & { etiqueta: string; nivel: NivelCalima | null; info: InfoNivel | null };
export type HoraCalima = { t: string; polvo: number | null; aod: number | null };

export type MunicipioCalima = {
  id: string;
  nombre: string;
  slug: string | null;
  /** Días desde hoy con al menos MIN_HORAS_DIA horas */
  dias: DiaCalimaPagina[];
  /** Hoy (máximo de todo el día, también de las horas pasadas) */
  hoy: DiaCalimaPagina | null;
  /** Peor día de los que se enseñan */
  peorDia: DiaCalimaPagina | null;
  /** Desde la hora actual hasta el final de la previsión */
  horas: HoraCalima[];
  /** Hora con más polvo en las próximas 24 h */
  max24h: { valor: number; t: string } | null;
};

function slugsPorId(): Map<string, string> {
  try {
    return new Map(getMunicipios().map((m) => [m.id, m.slug]));
  } catch {
    return new Map();
  }
}

function prepararDias(p: PuntoCalima, ahoraLocal: string): DiaCalimaPagina[] {
  const hoy = ahoraLocal.slice(0, 10);
  return p.dias
    .filter((d) => d.fecha >= hoy && (d.horas >= MIN_HORAS_DIA || d.fecha === hoy))
    .map((d) => {
      const nivel = d.nivel ?? nivelCalima(d.polvoMax);
      return { ...d, nivel, etiqueta: etiquetaDia(d.fecha, ahoraLocal), info: nivel ? infoNivel(nivel) : null };
    });
}

/** Los 103 municipios (orden de calima.json, alfabético) preparados para la página. Lista vacía si no hay datos. */
export function municipiosCalima(ahora: Date = new Date(), calima: CalimaJson | null = getCalima()): MunicipioCalima[] {
  if (!calima) return [];
  const ahoraLocal = horaLocal(ahora);
  const i0 = calima.horas.findIndex((t) => t >= ahoraLocal);
  const inicio = i0 < 0 ? calima.horas.length : i0;
  const slugs = slugsPorId();
  return calima.puntos.map((p) => {
    const horas: HoraCalima[] = [];
    for (let i = inicio; i < calima.horas.length; i++) horas.push({ t: calima.horas[i], polvo: p.polvo[i] ?? null, aod: p.aod[i] ?? null });
    const dias = prepararDias(p, ahoraLocal);
    let max24h: MunicipioCalima["max24h"] = null;
    for (const h of horas.slice(0, 24)) if (h.polvo != null && (!max24h || h.polvo > max24h.valor)) max24h = { valor: h.polvo, t: h.t };
    const peorDia = dias.reduce<DiaCalimaPagina | null>((a, d) => (!a || (d.polvoMax ?? -1) > (a.polvoMax ?? -1) ? d : a), null);
    return {
      id: p.id,
      nombre: p.nombre,
      slug: slugs.get(p.id) ?? null,
      dias,
      hoy: dias.find((d) => d.fecha === ahoraLocal.slice(0, 10)) ?? null,
      peorDia,
      horas,
      max24h,
    };
  });
}

/** Calima de un municipio (para su página), o null si no hay datos. */
export function calimaDeMunicipio(idMunicipio: string, ahora: Date = new Date(), calima: CalimaJson | null = getCalima()): MunicipioCalima | null {
  if (!calima) return null;
  const solo: CalimaJson = { ...calima, puntos: calima.puntos.filter((p) => p.id === idMunicipio) };
  return municipiosCalima(ahora, solo)[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Resumen provincial
// ---------------------------------------------------------------------------------------------

export type DiaProvincia = {
  fecha: string;
  etiqueta: string; // "Hoy", "Mañana", "Martes 3"
  /** Municipio con más polvo ese día */
  max: { id: string; nombre: string; slug: string | null; valor: number } | null;
  nivelMax: NivelCalima | null;
  infoMax: InfoNivel | null;
  /** Municipios en cada nivel */
  conteo: Record<NivelCalima, number>;
  /** Municipios con calima (nivel débil o más), de más a menos polvo */
  conCalima: { id: string; nombre: string; slug: string | null; valor: number; nivel: NivelCalima }[];
  /** "Calima moderada en 12 municipios; la más intensa, en Pulpí (64 µg/m³)." o "Sin calima en la provincia." */
  frase: string;
};

export type ResumenCalima = {
  dias: DiaProvincia[];
  /** Día con más polvo de la previsión */
  peorDia: DiaProvincia | null;
  /** "No se espera calima en los próximos 4 días: el polvo no pasa de 3 µg/m³." */
  frase: string | null;
};

const CONTEO_VACIO = (): Record<NivelCalima, number> => ({ sin: 0, debil: 0, moderada: 0, intensa: 0, "muy-intensa": 0 });

export function resumenCalima(municipios: MunicipioCalima[]): ResumenCalima {
  const fechas = [...new Set(municipios.flatMap((m) => m.dias.map((d) => d.fecha)))].sort();
  const dias: DiaProvincia[] = fechas.map((fecha) => {
    const conteo = CONTEO_VACIO();
    const filas: DiaProvincia["conCalima"] = [];
    let max: DiaProvincia["max"] = null;
    let etiqueta = fecha;
    for (const m of municipios) {
      const d = m.dias.find((x) => x.fecha === fecha);
      if (!d || d.polvoMax == null || !d.nivel) continue;
      etiqueta = d.etiqueta;
      conteo[d.nivel]++;
      if (d.nivel !== "sin") filas.push({ id: m.id, nombre: m.nombre, slug: m.slug, valor: d.polvoMax, nivel: d.nivel });
      if (!max || d.polvoMax > max.valor) max = { id: m.id, nombre: m.nombre, slug: m.slug, valor: d.polvoMax };
    }
    filas.sort((a, b) => b.valor - a.valor || a.nombre.localeCompare(b.nombre, "es"));
    const nivelMax = max ? nivelCalima(max.valor) : null;
    let frase: string;
    if (!max || !nivelMax) frase = "Sin datos de polvo.";
    else if (nivelMax === "sin") frase = `Sin calima en la provincia: el polvo no pasa de ${fmtPolvo(max.valor)}.`;
    else {
      const n = filas.length;
      frase = `${infoNivel(nivelMax).nombre} en ${n === 1 ? "un municipio" : `${n} municipios`}; la más intensa, en ${max.nombre} (${fmtPolvo(max.valor)}).`;
      if (n > 1 && filas.some((f) => f.nivel !== nivelMax)) {
        const porNivel = ESCALA_CALIMA.filter((x) => x.nivel !== "sin" && conteo[x.nivel] > 0)
          .reverse()
          .map((x) => `${conteo[x.nivel]} con ${x.nombre.toLowerCase()}`);
        frase = `Calima en ${n} municipios (${listaFmt.format(porNivel)}); la más intensa, en ${max.nombre} (${fmtPolvo(max.valor)}).`;
      }
    }
    return { fecha, etiqueta, max, nivelMax, infoMax: nivelMax ? infoNivel(nivelMax) : null, conteo, conCalima: filas, frase };
  });
  const peorDia = dias.reduce<DiaProvincia | null>((a, d) => (!a || (d.max?.valor ?? -1) > (a.max?.valor ?? -1) ? d : a), null);
  let frase: string | null = null;
  if (peorDia?.max && peorDia.nivelMax) {
    if (peorDia.nivelMax === "sin") {
      frase = `No se espera calima en los próximos ${dias.length} días: el polvo no pasa de ${fmtPolvo(peorDia.max.valor)}.`;
    } else {
      frase = `El día con más polvo será ${enFrase(peorDia.etiqueta)}: hasta ${fmtPolvo(peorDia.max.valor)} en ${peorDia.max.nombre} (${infoNivel(peorDia.nivelMax).nombre.toLowerCase()}).`;
    }
  }
  return { dias, peorDia, frase };
}

export type HoraProvincia = { t: string; max: number | null; mediana: number | null; maxAod: number | null };

/** Serie horaria provincial desde la hora actual: máximo y mediana del polvo de los 103 municipios (para la gráfica). */
export function serieProvincial(municipios: MunicipioCalima[]): HoraProvincia[] {
  const n = Math.max(0, ...municipios.map((m) => m.horas.length));
  const ref = municipios.find((m) => m.horas.length === n);
  if (!ref) return [];
  return ref.horas.map((h, i) => {
    const polvo = municipios.map((m) => m.horas[i]?.polvo).filter((v): v is number => v != null).sort((a, b) => a - b);
    const aod = municipios.map((m) => m.horas[i]?.aod).filter((v): v is number => v != null);
    const mitad = polvo.length >> 1;
    const mediana = !polvo.length ? null : polvo.length % 2 ? polvo[mitad] : Math.round(((polvo[mitad - 1] + polvo[mitad]) / 2) * 10) / 10;
    return { t: h.t, max: polvo.length ? polvo[polvo.length - 1] : null, mediana, maxAod: aod.length ? Math.max(...aod) : null };
  });
}

/** Hora con más polvo de la provincia en la previsión: "el martes 3 a las 15:00". */
export function picoProvincial(municipios: MunicipioCalima[]): { valor: number; t: string; nombre: string; texto: string } | null {
  let pico: { valor: number; t: string; nombre: string } | null = null;
  for (const m of municipios) for (const h of m.horas) if (h.polvo != null && (!pico || h.polvo > pico.valor)) pico = { valor: h.polvo, t: h.t, nombre: m.nombre };
  if (!pico) return null;
  const ahoraLocal = municipios.find((m) => m.horas.length)?.horas[0].t ?? pico.t;
  return { ...pico, texto: `${enFrase(etiquetaDia(pico.t.slice(0, 10), ahoraLocal))} ${aLas(pico.t)}` };
}

// ---------------------------------------------------------------------------------------------
// Fuente y actualización
// ---------------------------------------------------------------------------------------------

export type FuenteCalima = {
  actualizado: string | null;
  /** "1 de noviembre de 2026 a las 02:45" */
  actualizadoTexto: string;
  /** Más de HORAS_DESFASE_CALIMA horas sin descarga nueva */
  desfasado: boolean;
  /** "Hasta el miércoles 4 a la 01:00, modelo europeo de CAMS (unos 11 km); después, modelo global (unos 45 km)." */
  fraseModelos: string;
};

export function fuenteCalima(ahora: Date = new Date(), calima: CalimaJson | null = getCalima()): FuenteCalima {
  const ahoraLocal = horaLocal(ahora);
  const fin = calima?.finEuropa ?? null;
  const fraseModelos =
    fin && fin >= ahoraLocal
      ? `Hasta ${enFrase(etiquetaDia(fin.slice(0, 10), ahoraLocal))} ${aLas(fin)}, modelo europeo de CAMS (unos 11 km); después, modelo global (unos 45 km).`
      : "Modelos europeo (unos 11 km) y global (unos 45 km) de CAMS.";
  return {
    actualizado: calima?.actualizado ?? null,
    actualizadoTexto: textoActualizacion(calima?.actualizado),
    desfasado: horasDesde(calima?.actualizado, ahora.getTime()) > HORAS_DESFASE_CALIMA,
    fraseModelos,
  };
}
