// Observación convencional de AEMET (últimas 24 h de todas las estaciones), filtrada a la provincia. TTL 55 min.
import path from "node:path";
import { ClienteAemet, escribirJson, existe, mensajeError, minutosDesde } from "./comun";
import type { Fuente } from "./tipos";

const TTL_MIN = 55;
// Caja aproximada de la provincia para filtrar estaciones (refinar luego con el polígono provincial)
const BBOX = { latMin: 36.65, latMax: 37.95, lonMin: -3.2, lonMax: -1.6 };

type Obs = { idema?: string; lat?: number; lon?: number; fint?: string };

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
    const todas = await cliente.json<Obs[]>("/observacion/convencional/todas");
    if (!Array.isArray(todas)) throw new Error("la respuesta no es una lista");
    const enProvincia = todas.filter(
      (o) =>
        typeof o.lat === "number" &&
        typeof o.lon === "number" &&
        o.lat >= BBOX.latMin &&
        o.lat <= BBOX.latMax &&
        o.lon >= BBOX.lonMin &&
        o.lon <= BBOX.lonMax
    );
    if (!enProvincia.length) throw new Error(`ninguna de las ${todas.length} observaciones cae en la provincia`);
    await escribirJson(ruta, enProvincia);
    const estaciones = new Set(enProvincia.map((o) => o.idema)).size;
    return {
      ...base,
      ok: true,
      cambiado: true,
      peticionesAemet: cliente.peticiones,
      nota: `${enProvincia.length} observaciones de ${estaciones} estaciones`,
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
