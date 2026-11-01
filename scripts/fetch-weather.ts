// scripts/fetch-weather.ts
// Orquestador de descarga: ejecuta en orden los módulos de scripts/fuentes/*.ts según su caducidad (TTL) y lo que
// ya haya en src/data/ (restaurado de la caché de Actions o vacío) y escribe src/data/meta.json.
//
// Uso:  npm run fetch:data                       (lee AEMET_API_KEY de .env si existe)
//       npm run fetch:data -- --forzar           (ignora los TTL de todas las fuentes)
//       npm run fetch:data -- --solo aemet       (solo esa fuente, forzada: avisos, aemet, openmeteo, mar, calima,
//                                                  zonas, observaciones, radar, playas, ria)
// Sin AEMET_API_KEY (solo en local, nunca en CI) se saltan las fuentes AEMET y se conserva lo que hubiera.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  escribirJson,
  leerDatosMunicipio,
  leerJson,
  mensajeError,
  msElaborado,
  msIso,
  municipiosDesdeSemilla,
  rutaMunicipio,
} from "./fuentes/comun";
import type { Ctx, Fuente, Meta, ResultadoFuente } from "./fuentes/tipos";

const DIR_RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR_DATOS = path.join(DIR_RAIZ, "src", "data");
const DIR_FUENTES = path.join(DIR_RAIZ, "scripts", "fuentes");
const MAX_SIN_DATOS = 0.2; // si más del 20 % de municipios se queda sin ninguna previsión, se aborta (sigue online la versión anterior)
const ANTIGUEDAD_FALLO_AEMET_MS = 24 * 3_600_000;

// Orden de ejecución. Los opcionales los crean otras tareas: si el archivo no existe, se saltan.
// - avisos va primero: es lo más urgente y casi siempre solo pide el RSS público (sin cupo).
// - Open-Meteo: openmeteo (206) + mar (20) + calima (103) caben en el mismo minuto (≤329 de 600); zonas (≈350)
//   va detrás y espera 61 s si ya se pidió Open-Meteo en esta ejecución.
// - AEMET: todos los módulos comparten el ritmo de 1,6 s del ClienteAemet (≤37,5 peticiones/min en total).
//   playas va al final porque su lote (22 peticiones, ~35 s) no debe retrasar el radar.
const MODULOS: { nombre: string; archivo: string; clave: string; opcional?: boolean }[] = [
  { nombre: "avisos", archivo: "avisos.ts", clave: "avisos" },
  { nombre: "aemet", archivo: "aemet.ts", clave: "aemet" },
  { nombre: "openmeteo", archivo: "openmeteo.ts", clave: "openMeteo" },
  { nombre: "mar", archivo: "mar.ts", clave: "mar" },
  { nombre: "calima", archivo: "calima.ts", clave: "calima" },
  { nombre: "zonas", archivo: "zonas.ts", clave: "zonas", opcional: true },
  { nombre: "observaciones", archivo: "observaciones.ts", clave: "observaciones" },
  { nombre: "radar", archivo: "radar.ts", clave: "radar", opcional: true },
  { nombre: "playas", archivo: "playas.ts", clave: "playas" },
  { nombre: "ria", archivo: "ria.ts", clave: "ria", opcional: true },
];

// Forma mínima de cada fuente en meta.json (contrato de datos)
const META_FUENTE: Record<string, Record<string, unknown>> = {
  aemet: { actualizado: null, elaborado: null, modo: "cache", atom: { etag: null, lastModified: null } },
  openMeteo: { actualizado: null, peso: 0 },
  zonas: { actualizado: null, pasada: null, peso: 0 },
  observaciones: { actualizado: null },
  radar: { actualizado: null },
  ria: { actualizado: null, ultimoDia: null },
  // Sin objetos anidados por defecto: mar, calima y avisos recurren a su propio JSON cuando falta el dato en meta
  avisos: { actualizado: null, elaborado: null },
  playas: { actualizado: null, elaborado: null },
  mar: { actualizado: null, peso: 0 },
  calima: { actualizado: null, peso: 0 },
};

type Gasto = { aemet: number; openMeteo: number };
type Consumo = {
  // porFuente: solo las fuentes que han gastado algo ese día (para comprobar el presupuesto de cada módulo)
  dias: Record<string, Gasto & { ejecuciones: number; porFuente?: Record<string, Gasto> }>;
  ejecuciones: { inicio: string; segundos: number; aemet: number; openMeteo: number; fuentes: Record<string, string>; gasto?: Record<string, Gasto> }[];
};

function leerArgumentos(argv: string[]) {
  let forzar = false;
  let solo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--forzar") forzar = true;
    else if (a === "--solo") solo = argv[++i] ?? null;
    else if (a.startsWith("--solo=")) solo = a.slice(7);
    else console.warn(`AVISO: argumento desconocido "${a}"`);
  }
  if (solo != null) {
    solo = solo.toLowerCase().replace(/[^a-z]/g, "");
    if (!MODULOS.some((m) => m.nombre === solo)) throw new Error(`--solo: fuente desconocida "${solo}" (${MODULOS.map((m) => m.nombre).join(", ")})`);
  }
  return { forzar, solo };
}

const seg = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function main() {
  const inicio = new Date();
  const { forzar, solo } = leerArgumentos(process.argv.slice(2));
  const aemetKey = process.env.AEMET_API_KEY?.trim() || undefined;
  if (!aemetKey && process.env.CI) throw new Error("Falta la variable de entorno AEMET_API_KEY");
  if (!aemetKey) console.warn("AVISO: sin AEMET_API_KEY. Modo local: se saltan las fuentes AEMET y se conserva lo que hubiera en src/data/.");

  await mkdir(path.join(DIR_DATOS, "municipios"), { recursive: true });

  // meta.json anterior (puede no existir: caché vacía)
  const previo = await leerJson<Partial<Meta> | null>(path.join(DIR_DATOS, "meta.json"), null);
  const meta: Meta = { updatedAt: previo?.updatedAt ?? "", fallosAemet: previo?.fallosAemet ?? [], fuentes: { ...(previo?.fuentes ?? {}) } };
  for (const [clave, defecto] of Object.entries(META_FUENTE)) meta.fuentes[clave] = { ...defecto, ...(meta.fuentes[clave] ?? {}) };
  console.log(previo ? `Datos previos: última actualización ${meta.updatedAt || "desconocida"}` : "Sin datos previos (caché vacía)");

  // Lista de municipios: siempre desde la semilla versionada
  const municipios = await municipiosDesdeSemilla(DIR_RAIZ);
  if (municipios.length < 100) throw new Error(`Solo ${municipios.length} municipios en scripts/municipios-almeria.json`);
  await escribirJson(path.join(DIR_DATOS, "municipios.json"), municipios);

  const ctx: Ctx = {
    ahora: inicio,
    dirDatos: DIR_DATOS,
    dirRaiz: DIR_RAIZ,
    meta,
    forzar: forzar || solo != null,
    aemetKey,
    log: (msg) => console.log(msg),
    yaPidioOpenMeteo: false,
  };

  let peticionesAemet = 0;
  let pesoOpenMeteo = 0;
  const estados: Record<string, string> = {};
  const gastoFuentes: Record<string, Gasto> = {};
  for (const mod of MODULOS) {
    if (solo && mod.nombre !== solo) continue;
    const archivo = path.join(DIR_FUENTES, mod.archivo);
    if (!existsSync(archivo)) {
      if (mod.opcional) console.log(`[${mod.nombre}] no existe scripts/fuentes/${mod.archivo}: se salta`);
      else console.warn(`[${mod.nombre}] FALTA scripts/fuentes/${mod.archivo}`);
      estados[mod.clave] = "ausente";
      continue;
    }
    const t0 = Date.now();
    let r: ResultadoFuente;
    try {
      const actualizar = (await import(pathToFileURL(archivo).href)).actualizar as Fuente | undefined;
      if (typeof actualizar !== "function") throw new Error(`scripts/fuentes/${mod.archivo} no exporta actualizar`);
      console.log(`[${mod.nombre}]…`);
      r = await actualizar({ ...ctx, ahora: new Date() });
    } catch (e) {
      // Los módulos no deberían lanzar; si lo hacen, se conserva lo anterior igualmente
      r = { fuente: mod.clave, ok: false, cambiado: false, nota: `error no capturado: ${mensajeError(e)}` };
    }
    const clave = r.fuente || mod.clave;
    if (r.metaFuente) meta.fuentes[clave] = { ...(meta.fuentes[clave] ?? {}), ...r.metaFuente };
    if (r.pesoOpenMeteo !== undefined) ctx.yaPidioOpenMeteo = true;
    peticionesAemet += r.peticionesAemet ?? 0;
    pesoOpenMeteo += r.pesoOpenMeteo ?? 0;
    if (r.peticionesAemet || r.pesoOpenMeteo) gastoFuentes[clave] = { aemet: r.peticionesAemet ?? 0, openMeteo: r.pesoOpenMeteo ?? 0 };
    estados[clave] = !r.ok ? "error" : r.cambiado ? "cambiado" : "sin cambios";
    const consumo = [
      r.peticionesAemet ? `${r.peticionesAemet} peticiones AEMET` : "",
      r.pesoOpenMeteo ? `peso Open-Meteo ${r.pesoOpenMeteo}` : "",
    ].filter(Boolean);
    console.log(
      `[${mod.nombre}] ${r.ok ? "ok" : "ERROR"}, ${r.cambiado ? "con datos nuevos" : "sin cambios"}, ${seg(Date.now() - t0)}` +
        `${consumo.length ? ` (${consumo.join(", ")})` : ""}${r.nota ? `: ${r.nota}` : ""}`
    );
  }

  // Todos los municipios tienen archivo, aunque sea vacío: el build nunca se rompe por un municipio
  const ahoraMs = Date.now();
  meta.fallosAemet = [];
  let sinPrevision = 0;
  for (const m of municipios) {
    if (!existsSync(rutaMunicipio(DIR_DATOS, m.id))) await escribirJson(rutaMunicipio(DIR_DATOS, m.id), { aemetDiaria: null, aemetHoraria: null, openMeteo: null });
    const d = await leerDatosMunicipio(DIR_DATOS, m.id);
    const elaborado = msElaborado((d.aemetHoraria as { elaborado?: string } | null)?.elaborado);
    const conAemet = Boolean(d.aemetHoraria && d.aemetDiaria) && ahoraMs - elaborado <= ANTIGUEDAD_FALLO_AEMET_MS;
    if (!conAemet) meta.fallosAemet.push(m.id);
    if (!conAemet && !d.openMeteo) sinPrevision++;
  }

  // public/radar/ debe coincidir con src/data/radar/ (restaurado de la caché) aunque el radar no se haya ejecutado
  const archivoRadar = path.join(DIR_FUENTES, "radar.ts");
  if (existsSync(archivoRadar)) {
    try {
      const { sincronizarPublico } = (await import(pathToFileURL(archivoRadar).href)) as {
        sincronizarPublico?: (dirDatos: string, dirRaiz: string, log?: (m: string) => void) => Promise<void>;
      };
      if (typeof sincronizarPublico === "function") await sincronizarPublico(DIR_DATOS, DIR_RAIZ, ctx.log);
    } catch (e) {
      console.warn(`[radar] no se pudo sincronizar public/radar: ${mensajeError(e)}`);
    }
  }

  // updatedAt = hora del dato de predicción u observación más reciente publicado (lo que dice el pie y lo que dispara el
  // aviso de datos desfasados). De AEMET cuenta la hora de elaboración de la predicción (no la de descarga, que se
  // renueva aunque el tar traiga la misma edición); del radar, la de su última imagen (AEMET puede servir imágenes
  // antiguas). La RIA no cuenta: publica datos diarios del día anterior y su "actualizado" es solo la hora de descarga.
  const FUENTES_ACTUALIZACION: Record<string, (f: Record<string, any>) => number> = {
    aemet: (f) => msElaborado(f.elaborado),
    openMeteo: (f) => msIso(f.actualizado),
    zonas: (f) => msIso(f.actualizado),
    observaciones: (f) => msIso(f.actualizado),
    radar: (f) => msIso(f.ultimaImagen),
  };
  const tiempos = Object.entries(FUENTES_ACTUALIZACION)
    .map(([clave, hora]) => (meta.fuentes[clave] ? hora(meta.fuentes[clave] as Record<string, any>) : Number.NaN))
    .filter((t) => Number.isFinite(t) && t <= ahoraMs + 10 * 60_000);
  if (tiempos.length) meta.updatedAt = new Date(Math.max(...tiempos)).toISOString();
  await escribirJson(path.join(DIR_DATOS, "meta.json"), meta);

  // Registro de consumo (últimos 14 días y últimas 200 ejecuciones)
  const segundos = Math.round((Date.now() - inicio.getTime()) / 100) / 10;
  const rutaConsumo = path.join(DIR_DATOS, "consumo.json");
  const consumo = await leerJson<Consumo>(rutaConsumo, { dias: {}, ejecuciones: [] });
  const dia = inicio.toISOString().slice(0, 10); // los límites diarios de Open-Meteo van por día UTC
  const total = consumo.dias[dia] ?? { aemet: 0, openMeteo: 0, ejecuciones: 0 };
  const porFuente: Record<string, Gasto> = { ...(total.porFuente ?? {}) };
  for (const [clave, g] of Object.entries(gastoFuentes)) {
    const previoFuente = porFuente[clave] ?? { aemet: 0, openMeteo: 0 };
    porFuente[clave] = { aemet: previoFuente.aemet + g.aemet, openMeteo: previoFuente.openMeteo + g.openMeteo };
  }
  consumo.dias[dia] = {
    aemet: total.aemet + peticionesAemet,
    openMeteo: total.openMeteo + pesoOpenMeteo,
    ejecuciones: total.ejecuciones + 1,
    porFuente,
  };
  consumo.dias = Object.fromEntries(Object.entries(consumo.dias).sort().slice(-14));
  consumo.ejecuciones = [
    ...consumo.ejecuciones,
    { inicio: inicio.toISOString(), segundos, aemet: peticionesAemet, openMeteo: pesoOpenMeteo, fuentes: estados, gasto: gastoFuentes },
  ].slice(-200);
  await escribirJson(rutaConsumo, consumo);

  console.log(
    `Listo en ${segundos} s. Consumo: ${peticionesAemet} peticiones AEMET, peso Open-Meteo ${pesoOpenMeteo}` +
      ` (hoy: ${consumo.dias[dia].aemet} AEMET, ${consumo.dias[dia].openMeteo} Open-Meteo en ${consumo.dias[dia].ejecuciones} ejecuciones).` +
      ` Municipios sin AEMET: ${meta.fallosAemet.length}. Actualizado: ${meta.updatedAt || "sin datos"}`
  );
  if (sinPrevision > municipios.length * MAX_SIN_DATOS) {
    throw new Error(`${sinPrevision} municipios sin ninguna previsión (ni AEMET ni Open-Meteo); se aborta para no publicar datos incompletos`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
