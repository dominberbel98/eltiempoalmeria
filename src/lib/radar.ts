// Lectura de src/data/radar/radar.json para la página /radar/. Solo se ejecuta en el build.
// Los GIF se sirven desde public/radar/ (los copia scripts/fuentes/radar.ts antes del build).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ImagenRadar, RadarJson } from "../../scripts/fuentes/radar";

export type { ImagenRadar, RadarJson };

const ZONA = "Europe/Madrid";
const DIR_DATOS = path.resolve("src/data/radar");
const DIR_PUBLICO = path.resolve("public/radar");

/** Tamaño real del GIF del radar regional de AEMET (para width/height del <img>). */
export const ANCHO_RADAR = 480;
export const ALTO_RADAR = 530;
/** A partir de esta antigüedad la página avisa de que la última imagen no es reciente. */
export const MINUTOS_AVISO = 30;
export const ATRIBUCION_RADAR = "Radar de Almería (Níjar), © AEMET";
export const URL_NOTA_LEGAL_AEMET = "https://www.aemet.es/es/nota_legal";

export type ImagenRadarPagina = {
  archivo: string;
  src: string; // "{BASE_URL}radar/2026-10-28T1930Z.gif"
  hora: string | null; // ISO UTC
  aprox: boolean;
  horaMadrid: string; // "20:30"
  fechaMadrid: string; // "28 de octubre"
  /** "20:30" o "hacia las 20:30" si la hora es aproximada */
  etiquetaHora: string;
  /** "28 de octubre de 2026, 20:30 (hora peninsular)" con "hacia las" si es aproximada */
  textoCompleto: string;
  /** Respecto a la última imagen: "Ahora", "−15 min", "−1 h", "−1 h 45" */
  relativa: string;
  /** Minutos antes de la última imagen (0 en la última) */
  minutosAntes: number;
  alt: string;
};

export type DatosRadar = {
  imagenes: ImagenRadarPagina[]; // de la más antigua a la más reciente (máx. 8)
  ultima: ImagenRadarPagina | null;
  /** Minutos entre la hora de la última imagen y el momento del build */
  minutosDesdeUltima: number | null;
  antigua: boolean; // la última tiene más de MINUTOS_AVISO minutos (o no hay imágenes)
  /** Texto de aviso para mostrar cuando antigua = true, o null */
  aviso: string | null;
  /** Última comprobación correcta del radar (ISO UTC) o null */
  comprobado: string | null;
};

function leerRadar(): RadarJson {
  const ruta = path.join(DIR_DATOS, "radar.json");
  if (!existsSync(ruta)) return { actualizado: null, imagenes: [] };
  try {
    const r = JSON.parse(readFileSync(ruta, "utf8")) as RadarJson;
    return { actualizado: r.actualizado ?? null, imagenes: Array.isArray(r.imagenes) ? r.imagenes : [] };
  } catch {
    return { actualizado: null, imagenes: [] };
  }
}

/** radar.json tal cual, solo con las imágenes cuyo GIF está en public/radar/ (las que se pueden servir). */
export function getRadar(): RadarJson {
  const r = leerRadar();
  return {
    actualizado: r.actualizado,
    imagenes: r.imagenes.filter((i) => /^[\w-]+\.gif$/.test(i.archivo) && existsSync(path.join(DIR_PUBLICO, i.archivo))),
  };
}

const horaFmt = new Intl.DateTimeFormat("es-ES", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hour12: false });
const fechaFmt = new Intl.DateTimeFormat("es-ES", { timeZone: ZONA, day: "numeric", month: "long" });
const fechaAnioFmt = new Intl.DateTimeFormat("es-ES", { timeZone: ZONA, day: "numeric", month: "long", year: "numeric" });

/** "−1 h 45", "−1 h", "−45 min", "Ahora" */
export function etiquetaRelativa(minutos: number): string {
  const m = Math.round(minutos);
  if (m <= 0) return "Ahora";
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `−${r} min`;
  return r ? `−${h} h ${String(r).padStart(2, "0")}` : `−${h} h`;
}

/** "hace 35 min", "hace 1 h 10 min", "hace 3 h" */
function hace(minutos: number): string {
  const m = Math.round(minutos);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `hace ${h} h ${r} min` : `hace ${h} h`;
}

/** Datos listos para la página /radar/: imágenes con su hora en Europe/Madrid y aviso de antigüedad. */
export function datosRadar(ahora: Date = new Date()): DatosRadar {
  const r = getRadar();
  const conHora = r.imagenes.map((i) => ({ ...i, t: Date.parse(i.hora ?? i.descargada) })).filter((i) => Number.isFinite(i.t));
  conHora.sort((a, b) => a.t - b.t);
  const tUltima = conHora.at(-1)?.t ?? null;
  const imagenes: ImagenRadarPagina[] = conHora.map((i) => {
    const d = new Date(i.t);
    const horaMadrid = horaFmt.format(d);
    const fechaMadrid = fechaFmt.format(d);
    const etiquetaHora = i.aprox ? `hacia las ${horaMadrid}` : horaMadrid;
    const minutosAntes = tUltima === null ? 0 : (tUltima - i.t) / 60_000;
    return {
      archivo: i.archivo,
      src: `${import.meta.env.BASE_URL}radar/${i.archivo}`,
      hora: i.hora,
      aprox: i.aprox,
      horaMadrid,
      fechaMadrid,
      etiquetaHora,
      textoCompleto: `${fechaAnioFmt.format(d)}, ${i.aprox ? "hacia las " : ""}${horaMadrid} (hora peninsular)`,
      relativa: etiquetaRelativa(minutosAntes),
      minutosAntes: Math.round(minutosAntes),
      alt: `Imagen del radar de AEMET en Almería ${i.aprox ? "de hacia las" : "de las"} ${horaMadrid} del ${fechaMadrid} (hora peninsular), con la reflectividad de la precipitación sobre el sureste peninsular`,
    };
  });
  const ultima = imagenes.at(-1) ?? null;
  const minutosDesdeUltima = tUltima === null ? null : Math.max(0, Math.round((ahora.getTime() - tUltima) / 60_000));
  const antigua = minutosDesdeUltima === null || minutosDesdeUltima > MINUTOS_AVISO;
  let aviso: string | null = null;
  if (!ultima) aviso = "Ahora mismo no hay imágenes del radar disponibles. AEMET no ha publicado ninguna o no se han podido descargar.";
  else if (antigua && minutosDesdeUltima !== null)
    aviso = `La última imagen es ${ultima.aprox ? "de hacia las" : "de las"} ${ultima.horaMadrid} del ${ultima.fechaMadrid} (${hace(minutosDesdeUltima)}): AEMET no ha publicado imágenes más recientes.`;
  return { imagenes, ultima, minutosDesdeUltima, antigua, aviso, comprobado: r.actualizado };
}
