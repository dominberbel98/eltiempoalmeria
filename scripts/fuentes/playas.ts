// scripts/fuentes/playas.ts
// Predicción de playas de AEMET OpenData para las 22 playas de la provincia de Almería -> src/data/playas.json.
//
// Endpoint: /prediccion/especifica/playa/{id} (dos pasos, 2 peticiones por playa). Trae el día de elaboración y los dos
// siguientes, con mañana y tarde para cielo, viento y oleaje, y un valor diario de temperatura máxima, sensación
// térmica, temperatura del agua e índice UV máximo.
//
// Cadencia: AEMET elabora las 591 playas de España de una vez, una edición al día hacia las 08:50 UTC (el 31/10/2026
// las 22 de Almería tenían elaborado 08:51:15 UTC y el XML público Last-Modified 08:51:14 GMT, sin edición de tarde a
// las 17:00 UTC). Por eso:
//   - una playa está atrasada si su `elaborado` es de un día UTC anterior al de la edición esperada (la de hoy a partir
//     de las 08:45 UTC, la de ayer antes);
//   - las atrasadas o sin datos se piden en lotes de ≤11 playas por ejecución (≤22 peticiones, ~35 s con el ritmo de
//     comun.ts), las más antiguas primero: con el workflow cada 15 min, las 22 se renuevan en dos ejecuciones;
//   - si la primera playa del lote devuelve la misma edición que ya hay, AEMET aún no ha publicado: se corta el lote y
//     no se vuelve a probar hasta pasados 30 min;
//   - sin atrasadas, cada 6 h se sondea la playa más antigua (2 peticiones) por si AEMET publica otra edición;
//   - una playa que falla por sí sola (no por caída del servicio) no se reintenta hasta pasadas 2 h; tras 2 fallos
//     seguidos de servicio o 3 playas seguidas sin predicción válida se corta el lote y se reintenta a los 30 min.
// Consumo: ~44 peticiones con la edición diaria + 2 por sondeo (≈4 sondeos al día) ≈ 50-55 peticiones AEMET/día.
// Nunca lanza: ante un fallo conserva los datos anteriores de cada playa y devuelve ok=false.
//
// Lista de playas (scripts/playas-almeria.json, versionado): sale del fichero maestro de AEMET
// https://www.aemet.es/documentos/es/eltiempo/prediccion/playas/Playas_codigos.csv (ISO-8859-1, separador ";",
// coordenadas en grados, minutos y segundos), filtrado a ID_PROVINCIA = 04 y cruzado con scripts/municipios-almeria.json.
// Al generarlo se corrigen a mano las coordenadas erróneas del CSV (CORRECCIONES_PLAYAS) y el municipio pasa a ser el
// término (public/municipios.geojson) en el que cae la playa (si cae en el mar, el de AEMET): AEMET mantiene códigos
// anteriores a la segregación de Balanegra (2015). Una playa a más de 2 km de su término detiene la generación.
// Se regenera a mano, sin clave y sin gastar cupo de OpenData, si AEMET añade o quita playas:
//   npx tsx scripts/fuentes/playas.ts --maestro
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ClienteAemet,
  decodificarMixto,
  esFalloDeServicio,
  escribirJson,
  existe,
  horaLegible,
  leerJson,
  mensajeError,
  msElaborado,
  msIso,
  municipiosDesdeSemilla,
  numONulo,
  pedir,
  slugify,
  toArray,
} from "./comun";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos";

export const URL_MAESTRO_PLAYAS = "https://www.aemet.es/documentos/es/eltiempo/prediccion/playas/Playas_codigos.csv";
const PROVINCIA = "04";
const H = 3_600_000;
const MINUTO_EDICION_UTC = 8 * 60 + 45; // 08:45 UTC: a partir de aquí se espera la edición del día
const COMPROBACION_MS = 6 * H; // sondeo por si hay una edición extra
const REINTENTO_MS = 30 * 60_000; // AEMET aún no ha publicado la edición esperada
const PAUSA_FALLIDA_MS = 2 * H; // playa que falla sola
const LOTE_PLAYAS = 11;
const PRESUPUESTO_MS = 150_000;
const OPCIONES_AEMET = { intentos: 2, timeoutMs: 20_000, ante429: () => null };
const MAX_FALLOS_SEGUIDOS = 2; // de servicio (red, 5xx, 429): se corta el lote
const MAX_FALLOS_PLAYA_SEGUIDOS = 3; // de playa (p. ej. 404 en varias seguidas): seguramente es de AEMET, se corta el lote

// ---------------------------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------------------------

/** Municipio de una playa: id INE de 5 dígitos y slug de src/data/municipios.json. */
export type MunicipioPlaya = { id: string; slug: string; nombre: string };

/**
 * Una playa de scripts/playas-almeria.json. `id` es el código AEMET de 7 dígitos (provincia, municipio y orden: el
 * municipio del código puede no ser el de `municipio`). `nota` explica en qué se aparta del CSV de AEMET.
 */
export type PlayaMaestro = { id: string; nombre: string; slug: string; municipio: MunicipioPlaya; lat: number; lon: number; nota?: string };

export type MaestroPlayas = { _comentario: string; fuente: string; generado: string; playas: PlayaMaestro[] };

/** Código de AEMET y su texto ("despejado", "flojo", "débil"…). null si falta. */
export type Franja = { codigo: number | null; texto: string | null };

/** Cielo, viento u oleaje: mañana, tarde y frase del día ("Despejado por la mañana y nuboso por la tarde"). */
export type EstadoPlaya = { manana: Franja; tarde: Franja; texto: string | null };

/** Viento u oleaje con el nivel más alto del día: 1 flojo/débil, 2 moderado, 3 fuerte. */
export type EstadoNivel = EstadoPlaya & { nivel: 1 | 2 | 3 | null };

export type DiaPlaya = {
  fecha: string; // "YYYY-MM-DD"
  cielo: EstadoPlaya;
  viento: EstadoNivel;
  oleaje: EstadoNivel;
  tMax: number | null; // °C
  sensacion: Franja; // código 410-480 y texto ("suave", "calor agradable"…)
  tAgua: number | null; // °C
  uvMax: number | null;
};

export type Playa = PlayaMaestro & { elaborado: string | null /*UTC sin Z, tal cual AEMET*/; dias: DiaPlaya[] };

/** src/data/playas.json. Siempre trae las playas del maestro, con `dias: []` y `elaborado: null` si aún no hay datos. */
export type PlayasJson = { actualizado: string | null /*ISO de la última descarga con datos nuevos*/; playas: Playa[] };

/** meta.fuentes.playas. `comprobado`, `reintento` y `fallidas` son internos del módulo. */
export type MetaPlayas = {
  actualizado: string | null;
  elaborado: string | null; // la edición más reciente (UTC sin Z)
  comprobado?: string | null;
  reintento?: string | null;
  fallidas?: Record<string, string>; // id de playa -> ISO del último fallo
};

// ---------------------------------------------------------------------------------------------
// Códigos de AEMET (la descripción que llega en cada predicción manda; esto es el respaldo)
// ---------------------------------------------------------------------------------------------

export const TEXTO_CIELO: Record<number, string> = { 100: "despejado", 110: "nuboso", 120: "muy nuboso", 130: "chubascos", 140: "lluvia" };
export const TEXTO_VIENTO: Record<number, string> = { 210: "flojo", 220: "moderado", 230: "fuerte" };
export const TEXTO_OLEAJE: Record<number, string> = { 310: "débil", 320: "moderado", 330: "fuerte" };
export const TEXTO_SENSACION: Record<number, string> = {
  410: "muy frío",
  420: "frío",
  430: "muy fresco",
  440: "fresco",
  450: "suave",
  460: "calor agradable",
  470: "calor moderado",
  480: "calor fuerte",
};

/** Nivel 1-3 de un código de viento (210-230) u oleaje (310-330). */
export function nivelCodigo(codigo: number | null): 1 | 2 | 3 | null {
  if (codigo == null) return null;
  const n = Math.round((codigo % 100) / 10);
  return n === 1 || n === 2 || n === 3 ? n : null;
}

const mayuscula = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("es") + s.slice(1) : s);

/** "Despejado", o "Despejado por la mañana y nuboso por la tarde". */
export function fraseDia(manana: string | null, tarde: string | null): string | null {
  if (!manana && !tarde) return null;
  if (!tarde || manana === tarde) return mayuscula(manana!);
  if (!manana) return `${mayuscula(tarde)} por la tarde`;
  return `${mayuscula(manana)} por la mañana y ${tarde} por la tarde`;
}

// ---------------------------------------------------------------------------------------------
// Normalización de la respuesta de AEMET
// ---------------------------------------------------------------------------------------------

type Crudo = Record<string, unknown>;

/** Primer campo presente entre varios nombres (AEMET usa estadoCielo, estado_cielo, tMaxima, tmaxima…). */
function campo(d: Crudo, ...nombres: string[]): Crudo | null {
  for (const n of nombres) {
    const v = d[n];
    if (v && typeof v === "object") return v as Crudo;
  }
  return null;
}

function texto(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
  return s && s !== "nd" ? s : null;
}

function franja(c: Crudo | null, n: 1 | 2, mapa: Record<number, string>): Franja {
  const codigo = numONulo(c?.[`f${n}`]);
  const valido = codigo != null && codigo > 0 ? codigo : null;
  return { codigo: valido, texto: texto(c?.[`descripcion${n}`]) ?? (valido != null ? (mapa[valido] ?? null) : null) };
}

function estado(c: Crudo | null, mapa: Record<number, string>): EstadoPlaya {
  const manana = franja(c, 1, mapa);
  const tarde = franja(c, 2, mapa);
  return { manana, tarde, texto: fraseDia(manana.texto, tarde.texto) };
}

function estadoNivel(c: Crudo | null, mapa: Record<number, string>): EstadoNivel {
  const e = estado(c, mapa);
  const niveles = [nivelCodigo(e.manana.codigo), nivelCodigo(e.tarde.codigo)].filter((n): n is 1 | 2 | 3 => n != null);
  return { ...e, nivel: niveles.length ? (Math.max(...niveles) as 1 | 2 | 3) : null };
}

/** valor1 numérico; el 0 de "sin dato" de AEMET solo se acepta donde tiene sentido (UV). */
function valor(c: Crudo | null, ceroValido = false): number | null {
  const v = numONulo(c?.valor1);
  if (v == null) return null;
  return v === 0 && !ceroValido ? null : v;
}

function fechaIso(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function normalizarDia(d: Crudo): DiaPlaya | null {
  const fecha = fechaIso(d.fecha);
  if (!fecha) return null;
  const sTermica = campo(d, "sTermica", "stermica", "s_termica");
  const sensacion = franja(sTermica ? { f1: sTermica.valor1, descripcion1: sTermica.descripcion1 } : null, 1, TEXTO_SENSACION);
  return {
    fecha,
    cielo: estado(campo(d, "estadoCielo", "estadocielo", "estado_cielo"), TEXTO_CIELO),
    viento: estadoNivel(campo(d, "viento"), TEXTO_VIENTO),
    oleaje: estadoNivel(campo(d, "oleaje"), TEXTO_OLEAJE),
    tMax: valor(campo(d, "tMaxima", "tmaxima", "t_maxima")),
    sensacion,
    tAgua: valor(campo(d, "tAgua", "tagua", "t_agua")),
    uvMax: valor(campo(d, "uvMax", "uvmax", "uv_max"), true),
  };
}

/** Predicción de una playa normalizada, o el motivo por el que no vale. */
export function normalizarPrediccion(crudo: unknown, ahora: Date): { elaborado: string; dias: DiaPlaya[] } | string {
  const p = toArray(crudo as Crudo | Crudo[])[0];
  if (!p || typeof p !== "object") return "respuesta vacía";
  const elaborado = typeof p.elaborado === "string" ? p.elaborado.trim() : "";
  const t = msElaborado(elaborado);
  if (!Number.isFinite(t)) return `sin elaborado válido (${String(p.elaborado)})`;
  if (t > ahora.getTime() + 2 * H) return `elaborado en el futuro (${elaborado})`;
  const pred = (p.prediccion ?? {}) as Crudo;
  const dias = toArray(pred.dia as Crudo | Crudo[])
    .map(normalizarDia)
    .filter((d): d is DiaPlaya => d != null)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!dias.length) return "sin días de predicción";
  return { elaborado: elaborado.replace(/Z$/i, ""), dias };
}

// ---------------------------------------------------------------------------------------------
// Lectura del maestro y de playas.json
// ---------------------------------------------------------------------------------------------

export const rutaMaestro = (dirRaiz: string) => path.join(dirRaiz, "scripts", "playas-almeria.json");
export const rutaPlayas = (dirDatos: string) => path.join(dirDatos, "playas.json");

export async function leerMaestro(dirRaiz: string): Promise<PlayaMaestro[]> {
  const m = await leerJson<MaestroPlayas | null>(rutaMaestro(dirRaiz), null);
  const playas = m?.playas ?? [];
  if (!playas.length) throw new Error("scripts/playas-almeria.json no tiene playas");
  return playas;
}

/** Une el maestro con los datos guardados: siempre todas las playas del maestro, en su orden. */
export function unirConMaestro(maestro: PlayaMaestro[], previo: PlayasJson | null): Playa[] {
  const porId = new Map((previo?.playas ?? []).map((p) => [p.id, p]));
  return maestro.map((m) => {
    const p = porId.get(m.id);
    return { ...m, elaborado: p?.elaborado ?? null, dias: Array.isArray(p?.dias) ? p.dias : [] };
  });
}

/** Inicio (ms, 00:00 UTC) del día de la edición que debería estar publicada. */
export function inicioEdicionEsperada(ahora: Date): number {
  const hoy = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
  return ahora.getTime() >= hoy + MINUTO_EDICION_UTC * 60_000 ? hoy : hoy - 24 * H;
}

const msPlaya = (p: Playa) => {
  const t = msElaborado(p.elaborado);
  return Number.isFinite(t) && p.dias.length ? t : Number.NEGATIVE_INFINITY;
};

// ---------------------------------------------------------------------------------------------
// Módulo de descarga
// ---------------------------------------------------------------------------------------------

export type OpcionesPlayas = { lote?: number };

export async function actualizarPlayas(ctx: Ctx, op: OpcionesPlayas = {}): Promise<ResultadoFuente> {
  const ant = (ctx.meta.fuentes?.playas ?? {}) as Partial<MetaPlayas>;
  const ruta = rutaPlayas(ctx.dirDatos);
  const cliente = new ClienteAemet(ctx.aemetKey, ctx.log);
  const base = { fuente: "playas" };
  const metaAnt: MetaPlayas = {
    actualizado: ant.actualizado ?? null,
    elaborado: ant.elaborado ?? null,
    comprobado: ant.comprobado ?? null,
    reintento: ant.reintento ?? null,
    fallidas: { ...(ant.fallidas ?? {}) },
  };
  let previo: PlayasJson | null = null;
  let playas: Playa[] = [];
  try {
    const maestro = await leerMaestro(ctx.dirRaiz);
    previo = await leerJson<PlayasJson | null>(ruta, null);
    playas = unirConMaestro(maestro, previo);
    const asegurarArchivo = async () => {
      if (!existe(ruta)) await escribirJson(ruta, { actualizado: previo?.actualizado ?? null, playas } satisfies PlayasJson);
    };

    if (!ctx.aemetKey) {
      await asegurarArchivo();
      return { ...base, ok: false, cambiado: false, nota: "sin AEMET_API_KEY: se conserva lo que hubiera", metaFuente: metaAnt };
    }

    const ahora = ctx.ahora.getTime();
    const limite = Date.now() + PRESUPUESTO_MS;
    const tamLote = Math.max(1, op.lote ?? LOTE_PLAYAS);
    const objetivo = inicioEdicionEsperada(ctx.ahora);
    const nuevo: MetaPlayas = { ...metaAnt, fallidas: {} };
    // Las pausas por fallo de más de 2 h caducan
    for (const [id, iso] of Object.entries(metaAnt.fallidas ?? {})) if (ahora - msIso(iso) < PAUSA_FALLIDA_MS) nuevo.fallidas![id] = iso;
    const enPausa = (p: Playa) => !ctx.forzar && p.id in nuevo.fallidas!;

    const porAntiguedad = [...playas].sort((a, b) => msPlaya(a) - msPlaya(b) || a.id.localeCompare(b.id));
    const atrasadas = porAntiguedad.filter((p) => msPlaya(p) < objetivo && !enPausa(p));
    const frenado = !ctx.forzar && ahora < msIso(nuevo.reintento);
    const tocaComprobar = ctx.forzar || !(ahora - msIso(nuevo.comprobado) < COMPROBACION_MS);

    let candidatas: Playa[] = [];
    let motivo = "";
    if (ctx.forzar) {
      candidatas = porAntiguedad;
      motivo = "forzado";
    } else if (atrasadas.length && !frenado) {
      candidatas = atrasadas;
      motivo = `${atrasadas.length} atrasadas`;
    } else if (!atrasadas.length && tocaComprobar) {
      candidatas = porAntiguedad.filter((p) => !enPausa(p));
      motivo = "comprobación periódica";
    }
    if (!candidatas.length) {
      await asegurarArchivo();
      const nota = atrasadas.length
        ? `${atrasadas.length} playas esperan la edición de AEMET; nuevo intento a partir de ${horaLegible(nuevo.reintento)}`
        : `vigente (edición ${metaAnt.elaborado ?? "?"}, comprobado ${horaLegible(metaAnt.comprobado)})`;
      return { ...base, ok: true, cambiado: false, nota, metaFuente: nuevo };
    }

    const lote = candidatas.slice(0, tamLote);
    ctx.log(`  playas: ${lote.length} de ${candidatas.length} candidatas (${motivo})`);
    let escritas = 0;
    let fallos = 0;
    let seguidos = 0;
    let seguidosPlaya = 0;
    let sinEdicion = false;
    let cortado = "";
    for (const p of lote) {
      if (Date.now() > limite) {
        cortado = "sin tiempo";
        break;
      }
      try {
        const crudo = await cliente.json<unknown>(`/prediccion/especifica/playa/${p.id}`, OPCIONES_AEMET);
        const pred = normalizarPrediccion(crudo, ctx.ahora);
        if (typeof pred === "string") throw new Error(pred);
        seguidos = 0;
        seguidosPlaya = 0;
        delete nuevo.fallidas![p.id];
        const t = msElaborado(pred.elaborado);
        const teniamos = msPlaya(p);
        if (t > teniamos || ctx.forzar) {
          p.elaborado = pred.elaborado;
          p.dias = pred.dias;
          escritas++;
        }
        if (!(t > teniamos) && !ctx.forzar) {
          // AEMET sirve la misma edición que ya tenemos: no hay nada nuevo para el resto del lote
          sinEdicion = true;
          break;
        }
      } catch (e) {
        fallos++;
        ctx.log(`  fallo playa ${p.id} ${p.nombre}: ${mensajeError(e)}`);
        if (esFalloDeServicio(e)) {
          seguidos++;
          if (seguidos >= MAX_FALLOS_SEGUIDOS) {
            cortado = `${seguidos} fallos seguidos de AEMET`;
            break;
          }
        } else {
          seguidos = 0;
          nuevo.fallidas![p.id] = ctx.ahora.toISOString();
          if (++seguidosPlaya >= MAX_FALLOS_PLAYA_SEGUIDOS) {
            cortado = `${seguidosPlaya} playas seguidas sin predicción válida`;
            break;
          }
        }
      }
    }

    nuevo.comprobado = ctx.ahora.toISOString();
    const quedanAtrasadas = playas.some((p) => msPlaya(p) < objetivo && !(p.id in nuevo.fallidas!));
    nuevo.reintento = (sinEdicion || cortado) && quedanAtrasadas ? new Date(ahora + REINTENTO_MS).toISOString() : null;
    const edicion = Math.max(...playas.map(msPlaya));
    nuevo.elaborado = Number.isFinite(edicion) ? new Date(edicion).toISOString().slice(0, 19) : metaAnt.elaborado;
    if (escritas > 0) nuevo.actualizado = ctx.ahora.toISOString();
    if (escritas > 0 || !existe(ruta)) await escribirJson(ruta, { actualizado: nuevo.actualizado, playas } satisfies PlayasJson);

    const sinDatos = playas.filter((p) => !p.dias.length).length;
    const pendientes = playas.filter((p) => msPlaya(p) < objetivo).length;
    const notas = [
      `${escritas} playas con predicción nueva`,
      fallos ? `${fallos} fallos` : "",
      sinEdicion ? "AEMET sin edición nueva" : "",
      cortado ? `cortado (${cortado})` : "",
      pendientes ? `${pendientes} pendientes` : "",
      sinDatos ? `${sinDatos} sin datos` : "",
      `edición ${nuevo.elaborado ?? "?"}`,
    ].filter(Boolean);
    return {
      ...base,
      ok: fallos === 0 && !cortado,
      cambiado: escritas > 0,
      peticionesAemet: cliente.peticiones,
      nota: notas.join("; "),
      metaFuente: nuevo,
    };
  } catch (e) {
    if (!existe(ruta) && playas.length) await escribirJson(ruta, { actualizado: previo?.actualizado ?? null, playas }).catch(() => {});
    return {
      ...base,
      ok: false,
      cambiado: false,
      peticionesAemet: cliente.peticiones,
      nota: `error: ${mensajeError(e)}; se conservan los datos anteriores`,
      metaFuente: metaAnt,
    };
  }
}

export const actualizar: Fuente = (ctx) => actualizarPlayas(ctx);

// ---------------------------------------------------------------------------------------------
// Regeneración de scripts/playas-almeria.json desde el maestro de AEMET (a mano: --maestro)
// ---------------------------------------------------------------------------------------------

/** "36º 44' 39"" o "-03º 11' 06"" -> grados decimales (5 decimales). */
export function gradosDecimales(dms: string): number | null {
  const s = dms.trim();
  const n = s.match(/\d+(?:[.,]\d+)?/g)?.map((x) => Number(x.replace(",", ".")));
  if (!n?.length) return null;
  const abs = n[0] + (n[1] ?? 0) / 60 + (n[2] ?? 0) / 3600;
  return Math.round((s.startsWith("-") ? -abs : abs) * 1e5) / 1e5;
}

/** Coordenadas del CSV de AEMET que están mal, con el motivo (se comprueban con public/municipios.geojson). */
export const CORRECCIONES_PLAYAS: Record<string, { lat?: number; lon?: number; nota: string }> = {
  "0400308": {
    lon: -3.01833,
    nota:
      "El CSV de AEMET da la longitud -03º 11' 06\", 5 km al oeste del término de Adra, ya en Granada. Se usa -03º 01' 06\", junto a los Jardines de Poniente de Adra (errata de un dígito).",
  },
};
const MAX_KM_TERMINO = 2;

type Anillo = [number, number][];
type TerminoGeo = { id: string; poligonos: Anillo[][] };

async function leerTerminosGeo(dirRaiz: string): Promise<TerminoGeo[]> {
  const g = JSON.parse(await readFile(path.join(dirRaiz, "public", "municipios.geojson"), "utf8")) as {
    features: { properties: { id: string }; geometry: { type: string; coordinates: unknown } }[];
  };
  return g.features.map((f) => ({
    id: String(f.properties.id),
    poligonos: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates) as Anillo[][],
  }));
}
function enAnillo([x, y]: [number, number], anillo: Anillo): boolean {
  let d = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const enTermino = (p: [number, number], t: TerminoGeo) => t.poligonos.some((pol) => enAnillo(p, pol[0]) && !pol.slice(1).some((h) => enAnillo(p, h)));
/** Distancia aproximada (km) de un punto al borde de un término (0 si está dentro). */
function kmATermino(p: [number, number], t: TerminoGeo): number {
  if (enTermino(p, t)) return 0;
  const cos = Math.cos((p[1] * Math.PI) / 180);
  let min = Number.POSITIVE_INFINITY;
  for (const pol of t.poligonos)
    for (const an of pol)
      for (let i = 1; i < an.length; i++) {
        const dx = (an[i][0] - an[i - 1][0]) * cos;
        const dy = an[i][1] - an[i - 1][1];
        const px = (p[0] - an[i - 1][0]) * cos;
        const py = p[1] - an[i - 1][1];
        const k = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
        min = Math.min(min, Math.hypot(px - k * dx, py - k * dy) * 111.32);
      }
  return min;
}

export async function generarMaestro(dirRaiz: string, log: (m: string) => void = console.log): Promise<MaestroPlayas> {
  const r = await pedir(URL_MAESTRO_PLAYAS, { intentos: 3, timeoutMs: 30_000, log });
  const lineas = decodificarMixto(r.bytes).split(/\r?\n/).filter((l) => l.trim());
  const cab = lineas[0].split(";").map((c) => c.trim().toUpperCase());
  const col = (n: string) => {
    const i = cab.indexOf(n);
    if (i < 0) throw new Error(`el maestro no tiene la columna ${n}`);
    return i;
  };
  const c = {
    id: col("ID_PLAYA"),
    nombre: col("NOMBRE_PLAYA"),
    provincia: col("ID_PROVINCIA"),
    municipio: col("ID_MUNICIPIO"),
    lat: col("LATITUD"),
    lon: col("LONGITUD"),
  };
  const municipios = new Map((await municipiosDesdeSemilla(dirRaiz)).map((m) => [m.id, m]));
  const terminos = await leerTerminosGeo(dirRaiz);
  const playas: PlayaMaestro[] = [];
  for (const l of lineas.slice(1)) {
    const f = l.split(";").map((x) => x.trim());
    if (f[c.provincia]?.padStart(2, "0") !== PROVINCIA) continue;
    const id = f[c.id].padStart(7, "0");
    const idMun = f[c.municipio].padStart(5, "0");
    const corr = CORRECCIONES_PLAYAS[id];
    const lat = corr?.lat ?? gradosDecimales(f[c.lat] ?? "");
    const lon = corr?.lon ?? gradosDecimales(f[c.lon] ?? "");
    if (!municipios.get(idMun)) throw new Error(`playa ${id}: el municipio ${idMun} no está en scripts/municipios-almeria.json`);
    if (lat == null || lon == null) throw new Error(`playa ${id}: coordenadas no válidas (${f[c.lat]}; ${f[c.lon]})`);
    // Término en el que cae la playa. Si cae en el mar (la costa simplificada del IGN va unos metros tierra adentro), se
    // queda el de AEMET: elegir el más cercano equivocaría las playas junto a un límite (Pozo del Esparto y Pulpí).
    const punto: [number, number] = [lon, lat];
    const idReal = terminos.find((t) => enTermino(punto, t))?.id ?? idMun;
    const termino = terminos.find((t) => t.id === idReal);
    const km = termino ? kmATermino(punto, termino) : Number.POSITIVE_INFINITY;
    if (km > MAX_KM_TERMINO) throw new Error(`playa ${id} (${f[c.nombre]}): a ${km.toFixed(1)} km del término de su municipio; revisa CORRECCIONES_PLAYAS`);
    const m = municipios.get(idReal);
    if (!m) throw new Error(`playa ${id}: el término ${idReal} no está en scripts/municipios-almeria.json`);
    const notas = [corr?.nota];
    if (idReal !== idMun) {
      const nombreAemet = municipios.get(idMun)?.nombre ?? idMun;
      notas.push(`AEMET la asigna a ${nombreAemet} (${idMun}), pero está en el término de ${m.nombre} (${m.id}).`);
      log(`  playa ${id} (${f[c.nombre]}): ${nombreAemet} -> ${m.nombre}`);
    }
    const nota = notas.filter(Boolean).join(" ");
    playas.push({ id, nombre: f[c.nombre], slug: "", municipio: { id: m.id, slug: m.slug, nombre: m.nombre }, lat, lon, ...(nota ? { nota } : {}) });
  }
  if (playas.length < 10) throw new Error(`solo ${playas.length} playas de Almería en el maestro`);
  playas.sort((a, b) => a.municipio.nombre.localeCompare(b.municipio.nombre, "es") || a.nombre.localeCompare(b.nombre, "es"));
  // Slug del nombre; si se repite, se le añade el del municipio
  const usados = new Set<string>();
  for (const p of playas) {
    let slug = slugify(p.nombre);
    if (usados.has(slug)) slug = `${slug}-${p.municipio.slug}`;
    for (let i = 2; usados.has(slug); i++) slug = `${slugify(p.nombre)}-${p.municipio.slug}-${i}`;
    usados.add(slug);
    p.slug = slug;
  }
  const maestro: MaestroPlayas = {
    _comentario:
      "Playas de AEMET de la provincia de Almería (fichero maestro Playas_codigos.csv, ID_PROVINCIA = 04) con el término municipal en el que caen (public/municipios.geojson) y las coordenadas corregidas donde el CSV está mal (campo nota). Se regenera con: npx tsx scripts/fuentes/playas.ts --maestro",
    fuente: URL_MAESTRO_PLAYAS,
    generado: new Date().toISOString().slice(0, 10),
    playas,
  };
  log(`${playas.length} playas de Almería en ${new Set(playas.map((p) => p.municipio.id)).size} municipios`);
  return maestro;
}

// Ejecución directa: npx tsx scripts/fuentes/playas.ts --maestro
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.includes("--maestro")) {
  const dirRaiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  generarMaestro(dirRaiz)
    .then(async (m) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(rutaMaestro(dirRaiz), JSON.stringify(m, null, 2) + "\n");
      console.log(`Escrito ${rutaMaestro(dirRaiz)}`);
    })
    .catch((e) => {
      console.error(mensajeError(e));
      process.exit(1);
    });
}
