// Calima: polvo mineral en superficie (dust, µg/m³) y espesor óptico de aerosoles a 550 nm (aerosol_optical_depth)
// de la Air Quality API de Open-Meteo (CAMS, Copernicus) para los 103 municipios → src/data/calima.json
//
// Modelos (domains=auto, comprobado el 2026-10-31 en los meta.json de Open-Meteo):
//  - CAMS Europa: 0,1° (~11 km), una pasada al día (00 UTC, disponible hacia las 11:30 UTC), 96 h. Trae dust, no AOD.
//  - CAMS global: 0,4° (~45 km), dos pasadas al día (00 y 12 UTC, disponibles hacia las 10 y las 22 UTC), 120 h.
//    Trae dust y AOD. Con domains=auto, dust sale de CAMS Europa mientras dura y después del global.
// Por qué los 103 municipios y no una malla: con 2 variables y 6 días el peso es 1 por ubicación (103 por descarga).
// Una malla de 25 puntos ahorraría ~78 por descarga (~234/día) pero se perdería el detalle de 11 km de CAMS Europa
// en un relieve como el de Almería (costa, Tabernas, Filabres) y el dato por municipio para las páginas.
// Cadencia: se descarga cuando Open-Meteo publica una pasada nueva de CAMS Europa o del global (meta.json, no gastan
// cupo), con 10 min de margen; si no se pueden leer los meta.json, cada 6 h. Unas 3 descargas al día → ~309/día.
// Nunca lanza: ante un fallo conserva calima.json y devuelve ok=false.
import path from "node:path";
import { escribirJson, existe, horaMadrid, leerJson, leerMunicipios, mensajeError, minutosDesde, pedirOpenMeteo, pesoOpenMeteo, toArray } from "./comun";
import type { Fuente } from "./tipos";

const URL_AQ = "https://air-quality-api.open-meteo.com/v1/air-quality";
const META = {
  europa: "https://air-quality-api.open-meteo.com/data/cams_europe/static/meta.json",
  global: "https://air-quality-api.open-meteo.com/data/cams_global/static/meta.json",
} as const;
const DIAS = 6; // desde hoy a las 00 (Madrid); se recortan las horas finales sin datos (CAMS global llega a ~5 días)
const VARIABLES = ["dust", "aerosol_optical_depth"] as const;
const MARGEN_PUBLICACION_MS = 10 * 60_000;
const TTL_SIN_META_MIN = 360;
const MIN_HORAS = 96;

// --- Niveles ---

export type NivelCalima = "sin" | "debil" | "moderada" | "intensa" | "muy-intensa";

/**
 * Niveles por concentración de polvo en superficie (máximo horario del día, µg/m³). Umbrales tomados de los tramos de
 * PM10 del Índice Nacional de Calidad del Aire (Orden TEC/351/2019, tabla actualizada por la Resolución de 2 de
 * septiembre de 2020 de la DG de Calidad y Evaluación Ambiental, BOE-A-2020-10426):
 *   0-20 buena; 21-50 razonablemente buena y regular; 51-100 desfavorable; 101-150 muy desfavorable; >150 extremadamente desfavorable.
 * 50 µg/m³ es además el valor límite diario de PM10 (Directiva 2008/50/CE, RD 102/2011).
 * Matices: el ICA usa la media móvil de 24 h de PM10 medido y aquí se aplica al máximo horario previsto del polvo de
 * CAMS (partículas minerales hasta 20 µm), así que el nivel es una estimación prudente, no un índice de calidad del aire.
 * `hasta` es inclusivo; el último nivel no tiene tope.
 */
export const NIVELES_CALIMA: { nivel: NivelCalima; nombre: string; hasta: number | null }[] = [
  { nivel: "sin", nombre: "Sin calima", hasta: 20 },
  { nivel: "debil", nombre: "Calima débil", hasta: 50 },
  { nivel: "moderada", nombre: "Calima moderada", hasta: 100 },
  { nivel: "intensa", nombre: "Calima intensa", hasta: 150 },
  { nivel: "muy-intensa", nombre: "Calima muy intensa", hasta: null },
];

export function nivelCalima(polvo: number | null | undefined): NivelCalima | null {
  if (polvo == null || !Number.isFinite(polvo)) return null;
  return (NIVELES_CALIMA.find((n) => n.hasta == null || polvo <= n.hasta) ?? NIVELES_CALIMA[NIVELES_CALIMA.length - 1]).nivel;
}

// --- Formato de src/data/calima.json ---

export type DiaCalima = {
  fecha: string; // "YYYY-MM-DD" (Madrid)
  horas: number; // horas con dato de polvo ese día (24 si está completo)
  polvoMax: number | null; // µg/m³, máximo horario
  polvoMedia: number | null; // µg/m³, media de las horas con dato
  aodMax: number | null; // adimensional
  nivel: NivelCalima | null; // por polvoMax
};
export type PuntoCalima = {
  id: string; // código INE del municipio
  nombre: string;
  /** Series horarias alineadas con `horas` */
  polvo: (number | null)[];
  aod: (number | null)[];
  dias: DiaCalima[];
};
export type CalimaJson = {
  actualizado: string; // ISO UTC de la descarga
  /** Inicio (ISO UTC) de las pasadas de CAMS vigentes en la descarga, si se pudieron leer */
  pasadas: { europa: string | null; global: string | null };
  /** Última hora local con polvo de CAMS Europa (11 km); después, CAMS global (45 km) */
  finEuropa: string | null;
  horas: string[]; // "YYYY-MM-DDTHH:00" locales, desde hoy a las 00:00
  puntos: PuntoCalima[];
};

// --- Descarga ---

type MetaCams = { init: number; disponible: number; fin: number };
async function leerMetaCams(url: string, log: (m: string) => void): Promise<MetaCams | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m = (await res.json()) as { last_run_initialisation_time?: number; last_run_availability_time?: number; data_end_time?: number };
    const [init, disponible, fin] = [m.last_run_initialisation_time, m.last_run_availability_time, m.data_end_time].map(Number);
    if (![init, disponible, fin].every(Number.isFinite)) throw new Error("meta.json sin tiempos");
    return { init: init * 1000, disponible: disponible * 1000, fin: fin * 1000 };
  } catch (e) {
    log(`  calima: no se pudo leer ${url}: ${mensajeError(e)}`);
    return null;
  }
}

type RespuestaAq = { hourly?: { time?: string[]; dust?: unknown[]; aerosol_optical_depth?: unknown[] } };

const num = (v: unknown, dec: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** dec) / 10 ** dec : null);
const iso = (ms: number | undefined) => (ms == null ? null : new Date(ms).toISOString());

/** Resumen diario de una serie horaria. */
export function resumirDias(horas: string[], polvo: (number | null)[], aod: (number | null)[]): DiaCalima[] {
  const porDia = new Map<string, { p: number[]; a: number[] }>();
  horas.forEach((h, i) => {
    const fecha = h.slice(0, 10);
    const d = porDia.get(fecha) ?? { p: [], a: [] };
    if (polvo[i] != null) d.p.push(polvo[i] as number);
    if (aod[i] != null) d.a.push(aod[i] as number);
    porDia.set(fecha, d);
  });
  return [...porDia]
    .filter(([, d]) => d.p.length > 0)
    .map(([fecha, d]) => {
      const polvoMax = Math.max(...d.p);
      return {
        fecha,
        horas: d.p.length,
        polvoMax,
        polvoMedia: Math.round((d.p.reduce((a, b) => a + b, 0) / d.p.length) * 10) / 10,
        aodMax: d.a.length ? Math.max(...d.a) : null,
        nivel: nivelCalima(polvoMax),
      };
    });
}

export const actualizar: Fuente = async (ctx) => {
  const ant: { actualizado?: string | null; peso?: number; pasadas?: { europa?: string | null; global?: string | null } } = ctx.meta.fuentes?.calima ?? {};
  const ruta = path.join(ctx.dirDatos, "calima.json");
  const base = { fuente: "calima" };
  let peso: number | undefined;
  try {
    const municipios = await leerMunicipios(ctx);
    const previo = await leerJson<CalimaJson | null>(ruta, null);
    const mismos = Boolean(previo?.puntos?.length === municipios.length && municipios.every((m, i) => previo?.puntos[i]?.id === m.id));

    const [europa, global] = [await leerMetaCams(META.europa, ctx.log), await leerMetaCams(META.global, ctx.log)];
    const listo = (m: MetaCams | null) => (m && ctx.ahora.getTime() >= m.disponible + MARGEN_PUBLICACION_MS ? m : null);
    const [eu, gl] = [listo(europa), listo(global)];
    const pasadasAnt = ant.pasadas ?? previo?.pasadas ?? {};
    const nueva = (m: MetaCams | null, previa: string | null | undefined) => Boolean(m && (!previa || m.init > Date.parse(previa)));
    const edad = minutosDesde(ant.actualizado ?? previo?.actualizado, ctx.ahora);
    const motivo = ctx.forzar
      ? "forzado"
      : !previo || !mismos
        ? "sin datos"
        : nueva(eu, pasadasAnt.europa)
          ? `pasada nueva de CAMS Europa (${iso(eu!.init)!.slice(0, 13)}Z)`
          : nueva(gl, pasadasAnt.global)
            ? `pasada nueva de CAMS global (${iso(gl!.init)!.slice(0, 13)}Z)`
            : (!europa || !global) && edad >= TTL_SIN_META_MIN
              ? `meta.json no disponible y datos de hace ${Math.round(edad / 60)} h`
              : edad >= 2 * TTL_SIN_META_MIN
                ? `datos de hace ${Math.round(edad / 60)} h`
                : null;
    if (!motivo) {
      // Con los datos de calima.json por si meta.json no los tenía
      const metaFuente = { ...ant, actualizado: ant.actualizado ?? previo?.actualizado ?? null, pasadas: { europa: pasadasAnt.europa ?? null, global: pasadasAnt.global ?? null } };
      return { ...base, ok: true, cambiado: false, nota: `vigente (${Math.round(edad)} min, sin pasada nueva de CAMS)`, metaFuente };
    }

    const url = new URL(URL_AQ);
    url.searchParams.set("latitude", municipios.map((m) => m.lat).join(","));
    url.searchParams.set("longitude", municipios.map((m) => m.lon).join(","));
    url.searchParams.set("hourly", VARIABLES.join(","));
    url.searchParams.set("domains", "auto");
    url.searchParams.set("forecast_days", String(DIAS));
    url.searchParams.set("timezone", "Europe/Madrid");

    peso = 0; // a partir de aquí ya se ha pedido algo a Open-Meteo
    const r = await pedirOpenMeteo(url.toString(), { log: ctx.log });
    peso = pesoOpenMeteo(municipios.length, VARIABLES.length, 1, DIAS);
    const datos = toArray(JSON.parse(r.texto()) as RespuestaAq | RespuestaAq[]);
    if (datos.length !== municipios.length) throw new Error(`Open-Meteo devolvió ${datos.length} ubicaciones de ${municipios.length}`);
    const tiempo = (datos[0].hourly?.time ?? []).map(String);
    datos.forEach((d, i) => {
      const t = d.hourly?.time;
      if (!t || t.length !== tiempo.length || String(t[0]) !== tiempo[0]) throw new Error(`eje de horas distinto en ${municipios[i].nombre}`);
    });

    // Recorta por el final las horas sin polvo en ningún punto (más allá del alcance de CAMS)
    let n = tiempo.length;
    while (n > 0 && datos.every((d) => num(d.hourly?.dust?.[n - 1], 1) == null)) n--;
    if (n < MIN_HORAS) throw new Error(`serie de polvo demasiado corta (${n} h)`);
    const horas = tiempo.slice(0, n);

    const puntos: PuntoCalima[] = municipios.map((m, i) => {
      const h = datos[i].hourly ?? {};
      const polvo = horas.map((_, k) => num(h.dust?.[k], 1));
      const aod = horas.map((_, k) => num(h.aerosol_optical_depth?.[k], 2));
      return { id: m.id, nombre: m.nombre, polvo, aod, dias: resumirDias(horas, polvo, aod) };
    });
    const sinDatos = puntos.filter((p) => !p.polvo.some((v) => v != null)).length;
    if (sinDatos > municipios.length * 0.2) throw new Error(`${sinDatos} municipios sin serie de polvo`);

    const actualizado = ctx.ahora.toISOString();
    const pasadas = { europa: iso(europa?.init) ?? pasadasAnt.europa ?? null, global: iso(global?.init) ?? pasadasAnt.global ?? null };
    // data_end_time es exclusivo: la última hora con dato de CAMS Europa es la anterior
    const finEuropa = europa ? horaMadrid(new Date(europa.fin - 3_600_000)) : null;
    const archivo: CalimaJson = { actualizado, pasadas, finEuropa, horas, puntos };
    await escribirJson(ruta, archivo);
    return {
      ...base,
      ok: true,
      cambiado: true,
      pesoOpenMeteo: peso,
      nota: `${municipios.length} municipios, ${horas.length} h (${motivo})`,
      metaFuente: { actualizado, peso, pasadas },
    };
  } catch (e) {
    if (!existe(ruta)) ctx.log("  calima: no hay calima.json anterior");
    return { ...base, ok: false, cambiado: false, pesoOpenMeteo: peso, nota: `error: ${mensajeError(e)}; se conservan los datos anteriores`, metaFuente: ant };
  }
};
