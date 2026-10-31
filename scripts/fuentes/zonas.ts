// scripts/fuentes/zonas.ts
// Predicción horaria de Open-Meteo para las zonas de scripts/zonas-almeria.json → src/data/zonas/{municipio}.json
// Se descarga cuando hay una pasada principal nueva de ICON-EU (00, 06, 12 y 18Z) y han pasado ≥5 h desde la
// última descarga, cuando las zonas tienen más de 7 h, cuando falta algún fichero o con --forzar.
// Nunca lanza: ante cualquier fallo devuelve ok=false y conserva los ficheros anteriores.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos.ts";

const OM = "https://api.open-meteo.com/v1/forecast";
const META_ICON_EU = [
  "https://api.open-meteo.com/data/dwd_icon_eu/static/meta.json",
  "https://api.open-meteo.com/data/dwd_icon_eu_native/static/meta.json",
];

/** Variables horarias pedidas, exactamente estas 10 (peso 1 por ubicación) y su nombre en el fichero. */
export const VARIABLES = {
  temperature_2m: "temp",
  relative_humidity_2m: "hr",
  precipitation: "precip",
  precipitation_probability: "prob",
  weather_code: "wc",
  wind_speed_10m: "viento",
  wind_direction_10m: "dir",
  wind_gusts_10m: "racha",
  cape: "cape",
  snowfall: "nieve",
} as const;
export type VariableZona = (typeof VARIABLES)[keyof typeof VARIABLES];
export type SerieZona = Record<VariableZona, (number | null)[]>;

/** Formato de src/data/zonas/{id}.json */
export type ArchivoZonas = {
  municipio: string;
  actualizado: string; // ISO de la descarga
  pasada: string | null; // init ISO de la pasada principal de ICON-EU
  horas: string[]; // "YYYY-MM-DDTHH:00" locales (Europe/Madrid)
  ultimaHoraDetalle: string; // última hora local con datos de ICON-EU
  zonas: { id: string; serie: SerieZona }[];
};

type ZonaDef = { id: string; municipio: string; lat: number; lon: number; altitud: number };
type RespuestaOm = { hourly?: Record<string, (number | null)[] | string[]> & { time?: string[] } };

const HORAS_PREVISION = 120;
const UBICACIONES_POR_PETICION = 550; // ≤1.000 por petición y ≤600 de peso por minuto
const ESPERA_MINUTO_MS = 61_000;
const H = 3_600_000;
const MIN_HORAS_PASADA = 5;
const MAX_EDAD_HORAS = 7;
const ZONA_HORARIA = "Europe/Madrid";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "2026-10-29T14:00" en hora de Madrid */
export function horaLocalMadrid(fecha: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(fecha)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

/** Peso de Open-Meteo por ubicación: max(1, variables × modelos / 10 × max(1, días / 14)). */
export function pesoPorUbicacion(variables: number, horas: number, modelos = 1): number {
  const dias = Math.ceil(horas / 24);
  return Math.max(1, ((variables * modelos) / 10) * Math.max(1, dias / 14));
}

type PasadaIcon = { principal: Date; ultimaHora: Date; init: Date };

/**
 * Última pasada principal de ICON-EU según el meta.json de Open-Meteo y la última hora con dato de esa pasada.
 * Las pasadas intermedias (03, 09, 15 y 21Z) solo llegan a ~31 h: el final real del detalle es el de la principal.
 */
export async function pasadaIconEu(log: (m: string) => void): Promise<PasadaIcon | null> {
  for (const url of META_ICON_EU) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = (await res.json()) as { last_run_initialisation_time?: number; data_end_time?: number };
      if (!Number.isFinite(m.last_run_initialisation_time) || !Number.isFinite(m.data_end_time)) throw new Error("meta.json sin tiempos");
      const init = new Date(m.last_run_initialisation_time! * 1000);
      const principal = new Date(Math.floor(init.getTime() / (6 * H)) * 6 * H);
      // data_end_time es el final (exclusivo) de la última pasada: una intermedia de 21Z da +31 h (último dato a +30 h).
      // Si la última es intermedia, la principal anterior sigue llegando a +120 h.
      const fin120 = principal.getTime() + 120 * H;
      const ultimaHora = new Date(init.getTime() === principal.getTime() ? Math.min(m.data_end_time! * 1000 - H, fin120) : fin120);
      return { principal, ultimaHora, init };
    } catch (e) {
      log(`  zonas: no se pudo leer ${url}: ${(e as Error).message}`);
    }
  }
  return null;
}

async function postOpenMeteo(lote: ZonaDef[], log: (m: string) => void): Promise<{ datos: RespuestaOm[]; coste: number | null }> {
  const cuerpo = new URLSearchParams({
    latitude: lote.map((z) => z.lat).join(","),
    longitude: lote.map((z) => z.lon).join(","),
    elevation: lote.map((z) => z.altitud).join(","),
    hourly: Object.keys(VARIABLES).join(","),
    models: "best_match",
    cell_selection: "land",
    timezone: ZONA_HORARIA,
    wind_speed_unit: "kmh",
    forecast_hours: String(HORAS_PREVISION),
  });
  let ultimoError = "";
  for (let intento = 1; intento <= 3; intento++) {
    let res: Response;
    try {
      res = await fetch(OM, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: cuerpo.toString(),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      ultimoError = `red: ${(e as Error).message}`;
      await sleep(intento * 10_000);
      continue;
    }
    const texto = await res.text();
    if (res.status === 429) {
      let motivo = texto.slice(0, 200);
      try {
        motivo = String(JSON.parse(texto).reason ?? motivo);
      } catch {
        // texto plano
      }
      // Los 429 de cuota no gastan; si es por hora o por día, reintentar no sirve
      if (/hour|daily|day|month/i.test(motivo)) throw new Error(`Open-Meteo 429 sin reintento: ${motivo}`);
      const espera = Number(res.headers.get("retry-after")) * 1000 || ESPERA_MINUTO_MS;
      log(`  zonas: 429 por minuto, espero ${Math.round(espera / 1000)} s (intento ${intento})`);
      ultimoError = `429: ${motivo}`;
      await sleep(espera);
      continue;
    }
    if (res.status >= 500) {
      ultimoError = `HTTP ${res.status}`;
      await sleep(intento * 15_000);
      continue;
    }
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${texto.slice(0, 200)}`);
    const j = JSON.parse(texto) as RespuestaOm | RespuestaOm[];
    const datos = Array.isArray(j) ? j : [j];
    if (datos.length !== lote.length) throw new Error(`Open-Meteo devolvió ${datos.length} ubicaciones de ${lote.length}`);
    const coste = Number(res.headers.get("x-ratelimit-cost"));
    return { datos, coste: Number.isFinite(coste) && coste > 0 ? coste : null };
  }
  throw new Error(`Open-Meteo: sin respuesta válida (${ultimoError})`);
}

async function leerJson<T>(ruta: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(ruta, "utf8")) as T;
  } catch {
    return null;
  }
}

export const actualizar: Fuente = async (ctx: Ctx): Promise<ResultadoFuente> => {
  const previo: { actualizado?: string | null; pasada?: string | null; peso?: number } = { ...(ctx.meta?.fuentes?.zonas ?? {}) };
  const dirZonas = path.join(ctx.dirDatos, "zonas");
  let pesoGastado = 0;
  try {
    const defs = await leerJson<ZonaDef[]>(path.join(ctx.dirRaiz, "scripts", "zonas-almeria.json"));
    if (!defs?.length) throw new Error("no existe scripts/zonas-almeria.json o está vacío");
    const municipios = [...new Set(defs.map((z) => z.municipio))];

    // Estado anterior: meta.json y, si falta, el propio fichero de zonas
    if (!previo.actualizado) {
      const muestra = await leerJson<ArchivoZonas>(path.join(dirZonas, `${municipios[0]}.json`));
      if (muestra) {
        previo.actualizado = muestra.actualizado;
        previo.pasada ??= muestra.pasada;
      }
    }
    const faltan = municipios.filter((id) => !existsSync(path.join(dirZonas, `${id}.json`)));
    const edadH = previo.actualizado ? (ctx.ahora.getTime() - Date.parse(previo.actualizado)) / H : Infinity;

    const pasada = await pasadaIconEu(ctx.log);
    const nuevaPasada = Boolean(pasada && (!previo.pasada || pasada.principal.getTime() > Date.parse(previo.pasada)));
    const motivo = ctx.forzar
      ? "forzado"
      : faltan.length
        ? `faltan ${faltan.length} municipios`
        : !(edadH <= MAX_EDAD_HORAS)
          ? `datos de hace ${Number.isFinite(edadH) ? edadH.toFixed(1) + " h" : "?"}`
          : nuevaPasada && edadH >= MIN_HORAS_PASADA
            ? `pasada nueva de ICON-EU (${pasada!.principal.toISOString().slice(0, 13)}Z)`
            : null;
    if (!motivo) {
      return {
        fuente: "zonas",
        ok: true,
        cambiado: false,
        nota: nuevaPasada ? `pasada nueva, pero la última descarga es de hace ${edadH.toFixed(1)} h` : "sin pasada principal nueva",
        pesoOpenMeteo: 0,
        metaFuente: { actualizado: previo.actualizado ?? null, pasada: previo.pasada ?? null, peso: previo.peso ?? 0 },
      };
    }
    ctx.log(`Zonas: ${defs.length} ubicaciones en ${municipios.length} municipios (${motivo})`);

    if (ctx.yaPidioOpenMeteo) {
      ctx.log(`  zonas: espero ${ESPERA_MINUTO_MS / 1000} s tras la petición principal de Open-Meteo`);
      await sleep(ESPERA_MINUTO_MS);
    }

    // Peticiones POST en serie, nunca en paralelo (1 petición simultánea por IP)
    const pesoUbic = pesoPorUbicacion(Object.keys(VARIABLES).length, HORAS_PREVISION);
    const respuestas: RespuestaOm[] = [];
    for (let i = 0; i < defs.length; i += UBICACIONES_POR_PETICION) {
      if (i > 0) await sleep(ESPERA_MINUTO_MS);
      const lote = defs.slice(i, i + UBICACIONES_POR_PETICION);
      const { datos, coste } = await postOpenMeteo(lote, ctx.log);
      pesoGastado += coste ?? lote.length * pesoUbic;
      respuestas.push(...datos);
    }

    // Validación: todas las ubicaciones con el mismo eje de horas y al menos 3 días
    const horas = (respuestas[0]?.hourly?.time ?? []) as string[];
    if (horas.length < 72) throw new Error(`serie demasiado corta (${horas.length} h)`);
    respuestas.forEach((r, i) => {
      const t = r.hourly?.time as string[] | undefined;
      if (!t || t.length !== horas.length || t[0] !== horas[0]) throw new Error(`eje de horas distinto en la zona ${defs[i].id}`);
    });
    const ultimaSerie = horas[horas.length - 1];
    const estimada = new Date(Math.floor((ctx.ahora.getTime() - 4 * H) / (6 * H)) * 6 * H + 120 * H);
    let ultimaHoraDetalle = horaLocalMadrid(pasada?.ultimaHora ?? estimada);
    if (ultimaHoraDetalle > ultimaSerie || ultimaHoraDetalle < horas[0]) ultimaHoraDetalle = ultimaSerie;

    const actualizado = new Date().toISOString();
    const porMunicipio = new Map<string, ArchivoZonas>();
    for (const id of municipios) {
      porMunicipio.set(id, { municipio: id, actualizado, pasada: pasada?.principal.toISOString() ?? null, horas, ultimaHoraDetalle, zonas: [] });
    }
    defs.forEach((z, i) => {
      const h = respuestas[i].hourly ?? {};
      const serie = Object.fromEntries(
        Object.entries(VARIABLES).map(([om, corto]) => {
          const v = h[om] as (number | null)[] | undefined;
          return [corto, horas.map((_, k) => (typeof v?.[k] === "number" && Number.isFinite(v[k]) ? (v[k] as number) : null))];
        })
      ) as SerieZona;
      porMunicipio.get(z.municipio)!.zonas.push({ id: z.id, serie });
    });

    // Escritura al final y fichero a fichero con renombrado: si algo falla antes, quedan los datos anteriores
    await mkdir(dirZonas, { recursive: true });
    for (const [id, archivo] of porMunicipio) {
      const destino = path.join(dirZonas, `${id}.json`);
      await writeFile(`${destino}.tmp`, JSON.stringify(archivo));
      await rename(`${destino}.tmp`, destino);
    }
    ctx.log(`  zonas: ${defs.length} zonas, ${horas.length} h, detalle hasta ${ultimaHoraDetalle}, peso ${pesoGastado}`);
    return {
      fuente: "zonas",
      ok: true,
      cambiado: true,
      nota: `${defs.length} zonas (${motivo}); detalle hasta ${ultimaHoraDetalle}${pasada ? "" : "; meta.json de ICON-EU no disponible, fin estimado"}`,
      pesoOpenMeteo: pesoGastado,
      metaFuente: { actualizado, pasada: pasada?.principal.toISOString() ?? null, peso: pesoGastado },
    };
  } catch (e) {
    ctx.log(`  zonas: fallo, se conservan los datos anteriores: ${(e as Error).message}`);
    return {
      fuente: "zonas",
      ok: false,
      cambiado: false,
      nota: (e as Error).message,
      pesoOpenMeteo: pesoGastado,
      metaFuente: { actualizado: previo.actualizado ?? null, pasada: previo.pasada ?? null, peso: previo.peso ?? 0 },
    };
  }
};
