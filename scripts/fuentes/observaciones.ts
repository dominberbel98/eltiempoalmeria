// Observación convencional de AEMET, filtrada a la provincia de Almería, para la página /observaciones/.
// `/observacion/convencional/todas` solo trae las 12 últimas horas (unas 9.800 lecturas de ~860 estaciones, 2,3 MB),
// así que cada descarga se fusiona con el archivo anterior (clave estación + `fint`) y se conservan las 24 últimas
// horas: tras 12 h de ejecuciones la serie está completa. 2 peticiones a AEMET por descarga (endpoint + datos).
// TTL de 55 min: AEMET publica cada hora y algunas estaciones llegan con una hora de retraso.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ClienteAemet, escribirJson, existe, leerJson, mensajeError, minutosDesde, msIso } from "./comun";
import type { Fuente } from "./tipos";

const TTL_MIN = 55;
/** Horas de serie que se guardan por estación (lecturas horarias: `fint` desde la más reciente − 23 h). */
export const HORAS_SERIE = 24;
// Caja amplia de la provincia: solo sirve para no descartar las estaciones de costa (faros) que el contorno
// simplificado deja en el mar. Lo que cae dentro de otra provincia se descarta siempre.
const BBOX = { latMin: 36.65, latMax: 37.95, lonMin: -3.2, lonMax: -1.6 };

type Obs = { idema?: string; lat?: number; lon?: number; fint?: string };

/**
 * Une las lecturas anteriores con las nuevas (las nuevas mandan si coinciden estación y `fint`), descarta las que no
 * tienen estación o fecha válida y las de más de HORAS_SERIE horas antes de la lectura más reciente, y ordena por
 * estación y hora.
 */
export function fusionarObservaciones<T extends Obs>(anteriores: T[], nuevas: T[]): T[] {
  const porClave = new Map<string, T>();
  for (const o of [...anteriores, ...nuevas]) {
    const ms = msIso(o.fint);
    if (!o.idema || !Number.isFinite(ms)) continue;
    porClave.set(`${o.idema}|${ms}`, o);
  }
  const lista = [...porClave.values()];
  const ultima = Math.max(...lista.map((o) => msIso(o.fint)));
  const desde = ultima - (HORAS_SERIE - 1) * 3_600_000;
  return lista
    .filter((o) => msIso(o.fint) >= desde)
    .sort((a, b) => a.idema!.localeCompare(b.idema!) || msIso(a.fint) - msIso(b.fint));
}
type Anillo = [number, number][];
type Multi = Anillo[][];
type Provincias = { almeria: Multi; otras: Multi[] };

function enAnillo(lon: number, lat: number, anillo: Anillo): boolean {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

const enMulti = (lon: number, lat: number, mp: Multi) => mp.some(([exterior, ...huecos]) => enAnillo(lon, lat, exterior) && !huecos.some((h) => enAnillo(lon, lat, h)));

export async function leerProvincias(dirRaiz: string): Promise<Provincias> {
  const gj = JSON.parse(await readFile(path.join(dirRaiz, "public", "provinces.geojson"), "utf8")) as {
    features: { properties: { NAMEUNIT?: string }; geometry: { type: string; coordinates: unknown } }[];
  };
  const multi = (g: { type: string; coordinates: unknown }): Multi => (g.type === "Polygon" ? [g.coordinates as Anillo[]] : (g.coordinates as Multi));
  const almeria = gj.features.find((f) => f.properties.NAMEUNIT === "Almería");
  if (!almeria) throw new Error("public/provinces.geojson no tiene la provincia de Almería");
  return { almeria: multi(almeria.geometry), otras: gj.features.filter((f) => f !== almeria).map((f) => multi(f.geometry)) };
}

/** Dentro del contorno de Almería, o en la caja de la provincia sin caer en ninguna provincia vecina (costa). */
export function enAlmeria(o: Obs, p: Provincias): boolean {
  if (typeof o.lat !== "number" || typeof o.lon !== "number") return false;
  if (enMulti(o.lon, o.lat, p.almeria)) return true;
  const enCaja = o.lat >= BBOX.latMin && o.lat <= BBOX.latMax && o.lon >= BBOX.lonMin && o.lon <= BBOX.lonMax;
  return enCaja && !p.otras.some((mp) => enMulti(o.lon!, o.lat!, mp));
}

export const actualizar: Fuente = async (ctx) => {
  const ant = ctx.meta.fuentes?.observaciones ?? {};
  const ruta = path.join(ctx.dirDatos, "observaciones.json");
  const cliente = new ClienteAemet(ctx.aemetKey, ctx.log);
  const base = { fuente: "observaciones" };
  try {
    if (!ctx.aemetKey) {
      if (!existe(ruta)) await escribirJson(ruta, []); // las páginas esperan el archivo
      return { ...base, ok: false, cambiado: false, nota: "sin AEMET_API_KEY: se conserva lo que hubiera", metaFuente: ant };
    }
    const edad = minutosDesde(ant.actualizado, ctx.ahora);
    if (!ctx.forzar && edad < TTL_MIN && existe(ruta)) {
      return { ...base, ok: true, cambiado: false, nota: `vigente (${Math.round(edad)} min)`, metaFuente: ant };
    }
    const provincias = await leerProvincias(ctx.dirRaiz);
    const todas = await cliente.json<Obs[]>("/observacion/convencional/todas");
    if (!Array.isArray(todas)) throw new Error("la respuesta no es una lista");
    const enProvincia = todas.filter((o) => enAlmeria(o, provincias));
    if (!enProvincia.length) throw new Error(`ninguna de las ${todas.length} observaciones cae en la provincia`);
    const anteriores = await leerJson<Obs[]>(ruta, []);
    const serie = fusionarObservaciones(Array.isArray(anteriores) ? anteriores : [], enProvincia);
    await escribirJson(ruta, serie);
    const estaciones = new Set(serie.map((o) => o.idema)).size;
    return {
      ...base,
      ok: true,
      cambiado: true,
      peticionesAemet: cliente.peticiones,
      nota: `${enProvincia.length} lecturas nuevas; ${serie.length} en 24 h de ${estaciones} estaciones`,
      metaFuente: { actualizado: ctx.ahora.toISOString() },
    };
  } catch (e) {
    if (!existe(ruta)) await escribirJson(ruta, []).catch(() => {});
    return {
      ...base,
      ok: false,
      cambiado: false,
      peticionesAemet: cliente.peticiones,
      nota: `error: ${mensajeError(e)}; se conservan los datos anteriores`,
      metaFuente: ant,
    };
  }
};
