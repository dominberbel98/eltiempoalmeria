// scripts/fuentes/radar.ts
// Radar regional de AEMET "am" (Almería-Níjar, código NJR): GIF de 480x530 con la hora UTC dibujada.
// En cada ejecución: endpoint -> URL de "datos" (caduca a los ~5 min, se pide al momento) -> GIF.
// Se acepta solo image/gif, se deduplica por sha256, se fecha leyendo la franja inferior (ocr-radar.ts)
// y se conservan las 8 últimas imágenes distintas de las 2 últimas horas en src/data/radar/, copiadas también a
// public/radar/. Una imagen cuya marca de hora no encaja con la descarga ni con los últimos días no se publica.
// Los glifos de dígitos que se identifican por coherencia se guardan en src/data/radar/glifos.json y se usan como
// plantillas en las ejecuciones siguientes (así el 7, que aún no tiene plantilla fija, se aprende solo).
// Nunca lanza: ante cualquier fallo devuelve ok=false y deja las imágenes anteriores como estaban.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dimensionesGif, esGif, leerHoraRadar, plantillasCon, VENTANA_MIN, type LecturaHora } from "./ocr-radar";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos";

const ENDPOINT = "https://opendata.aemet.es/opendata/api/red/radar/regional/am";
const MAX_IMAGENES = 8; // 2 h con la cadencia de 15 min del workflow
/** Solo se conservan (y se animan) las imágenes de las 2 h anteriores a la más reciente. */
export const VENTANA_IMAGENES_MIN = 120;
const TIMEOUT_MS = 20_000;
const PAUSA_REINTENTO_MS = 5_000;
const ANCHO = 480;
const ALTO = 530;

export type ImagenRadar = {
  archivo: string; // "2026-10-28T1930Z.gif" (si choca con otra imagen distinta: "2026-10-28T1930Z-1a2b3c4d.gif")
  hora: string | null; // ISO UTC de la observación (leída de la imagen o aproximada)
  aprox: boolean; // true: no se pudo leer la hora y es la de descarga − 10 min redondeada a la decena
  sha256: string;
  descargada: string; // ISO UTC de la descarga
};
export type RadarJson = { actualizado: string | null; imagenes: ImagenRadar[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vacio = (): RadarJson => ({ actualizado: null, imagenes: [] });

async function leerJson<T>(ruta: string, siFalta: T): Promise<T> {
  try {
    return JSON.parse(await readFile(ruta, "utf8")) as T;
  } catch {
    return siFalta;
  }
}

async function escribirAtomico(ruta: string, datos: string | Uint8Array): Promise<void> {
  const tmp = `${ruta}.tmp-${process.pid}`;
  await writeFile(tmp, datos);
  await rename(tmp, ruta);
}

function normalizar(r: RadarJson): RadarJson {
  const imagenes = Array.isArray(r?.imagenes)
    ? r.imagenes.filter((i) => i && typeof i.archivo === "string" && /^[\w-]+\.gif$/.test(i.archivo) && typeof i.sha256 === "string")
    : [];
  return { actualizado: typeof r?.actualizado === "string" ? r.actualizado : null, imagenes };
}

const ordenar = (a: ImagenRadar, b: ImagenRadar) =>
  (a.hora ?? a.descargada).localeCompare(b.hora ?? b.descargada) || a.descargada.localeCompare(b.descargada);

/** Hora aproximada cuando no se puede leer la de la imagen: descarga − 10 min, redondeada a la decena de minutos. */
export function horaAproximada(descarga: Date): string {
  const paso = 10 * 60_000;
  return new Date(Math.round((descarga.getTime() - paso) / paso) * paso).toISOString();
}

/**
 * Imágenes ordenadas de la más antigua a la más reciente, sin las que son de más de VENTANA_IMAGENES_MIN antes de
 * la más reciente (una imagen nueva tras horas sin radar no se anima junto a las de antes del corte) y como mucho
 * MAX_IMAGENES. La usa también src/lib/radar.ts por si en la caché quedan restos antiguos.
 */
export function recortarImagenes<T extends Pick<ImagenRadar, "hora" | "descargada">>(imagenes: T[]): T[] {
  const ms = (i: T) => Date.parse(i.hora ?? i.descargada);
  const orden = imagenes.filter((i) => Number.isFinite(ms(i))).sort((a, b) => ms(a) - ms(b) || a.descargada.localeCompare(b.descargada));
  const ultima = orden.length ? ms(orden[orden.length - 1]) : 0;
  return orden.filter((i) => ultima - ms(i) <= VENTANA_IMAGENES_MIN * 60_000).slice(-MAX_IMAGENES);
}

/** Hora (ISO UTC) de la imagen más reciente, o null si no hay ninguna. */
const ultimaHora = (r: RadarJson): string | null => r.imagenes.slice().sort(ordenar).at(-1)?.hora ?? null;

const nombreArchivo = (iso: string) => `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.gif`;

type Descarga = { gif: Uint8Array; descarga: Date };

class ErrorRadar extends Error {}

/** Endpoint + datos, con un reintento del endpoint si la URL de datos ya ha caducado o hay 429/5xx/red. */
async function descargar(ctx: Ctx, cuenta: { n: number }): Promise<Descarga> {
  let ultimoError = "";
  for (let intento = 1; intento <= 2; intento++) {
    if (intento > 1) await sleep(PAUSA_REINTENTO_MS);
    // Paso 1: endpoint
    let r: Response;
    try {
      cuenta.n++;
      r = await fetch(ENDPOINT, {
        headers: { api_key: ctx.aemetKey ?? "", accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      ultimoError = `endpoint sin respuesta (${(e as Error).name})`;
      continue;
    }
    const restantes = r.headers.get("remaining-request-endpoint");
    if (restantes && Number(restantes) < 5) ctx.log(`  radar: AEMET avisa de que quedan ${restantes} peticiones en este minuto`);
    const texto = await r.text().catch(() => "");
    if (r.status === 429 || r.status >= 500) {
      ultimoError = `endpoint HTTP ${r.status}`;
      continue;
    }
    if (!r.ok) throw new ErrorRadar(`endpoint HTTP ${r.status}`);
    let cuerpo: { estado?: number; datos?: string; descripcion?: string };
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      throw new ErrorRadar("el endpoint no devolvió JSON");
    }
    if (cuerpo.estado === 429) {
      ultimoError = "AEMET estado 429";
      continue;
    }
    if (cuerpo.estado !== 200 || typeof cuerpo.datos !== "string" || !cuerpo.datos.startsWith("https://opendata.aemet.es/")) {
      throw new ErrorRadar(`AEMET estado ${cuerpo.estado ?? "?"}: ${cuerpo.descripcion ?? "sin URL de datos"}`);
    }
    // Paso 2: datos, al momento (la URL caduca a los ~5 min y entonces devuelve 200 con un JSON)
    let d: Response;
    try {
      cuenta.n++;
      d = await fetch(cuerpo.datos, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      ultimoError = `datos sin respuesta (${(e as Error).name})`;
      continue;
    }
    const tipo = (d.headers.get("content-type") ?? "").toLowerCase();
    const bytes = new Uint8Array(await d.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const descarga = new Date();
    if (d.status === 429 || d.status >= 500) {
      ultimoError = `datos HTTP ${d.status}`;
      continue;
    }
    if (!d.ok) throw new ErrorRadar(`datos HTTP ${d.status}`);
    if (!tipo.startsWith("image/gif")) {
      // "datos expirados" o {estado: 404} con HTTP 200: se repite el endpoint una vez
      ultimoError = `datos con Content-Type ${tipo || "vacío"}`;
      continue;
    }
    if (!esGif(bytes) || bytes.length < 1000) throw new ErrorRadar("la respuesta no es un GIF válido");
    return { gif: bytes, descarga };
  }
  throw new ErrorRadar(ultimoError || "no se pudo descargar el radar");
}

/** Copia a public/radar/ las imágenes de radar.json y borra las que sobran. Nunca lanza. */
export async function sincronizarPublico(dirDatos: string, dirRaiz: string, log?: (m: string) => void): Promise<void> {
  try {
    const origen = path.join(dirDatos, "radar");
    const destino = path.join(dirRaiz, "public", "radar");
    const radar = normalizar(await leerJson<RadarJson>(path.join(origen, "radar.json"), vacio()));
    await mkdir(destino, { recursive: true });
    const quedan = new Set<string>();
    for (const img of radar.imagenes) {
      const de = path.join(origen, img.archivo);
      const a = path.join(destino, img.archivo);
      try {
        const sd = await stat(de);
        const sa = await stat(a).catch(() => null);
        if (!sa || sa.size !== sd.size) await copyFile(de, a);
        quedan.add(img.archivo);
      } catch {
        // falta el GIF en src/data/radar: la página lo filtra
      }
    }
    for (const f of await readdir(destino)) if (f.endsWith(".gif") && !quedan.has(f)) await unlink(path.join(destino, f)).catch(() => {});
  } catch (e) {
    log?.(`  radar: no se pudo copiar a public/radar (${(e as Error).message})`);
  }
}

export const actualizar: Fuente = async (ctx: Ctx): Promise<ResultadoFuente> => {
  const dir = path.join(ctx.dirDatos, "radar");
  const rutaJson = path.join(dir, "radar.json");
  const cuenta = { n: 0 };
  const metaPrevia: Record<string, any> = ctx.meta?.fuentes?.radar ?? {};
  try {
    await mkdir(dir, { recursive: true });
    const previo = normalizar(await leerJson<RadarJson>(rutaJson, vacio()));
    if (!ctx.aemetKey) {
      await sincronizarPublico(ctx.dirDatos, ctx.dirRaiz, ctx.log);
      return { fuente: "radar", ok: false, cambiado: false, nota: "sin AEMET_API_KEY: se conservan las imágenes anteriores", peticionesAemet: 0 };
    }

    const { gif, descarga } = await descargar(ctx, cuenta);
    const sha256 = createHash("sha256").update(gif).digest("hex");
    const comprobado = descarga.toISOString();

    if (previo.imagenes.some((i) => i.sha256 === sha256)) {
      await escribirAtomico(rutaJson, JSON.stringify({ ...previo, actualizado: comprobado }));
      await sincronizarPublico(ctx.dirDatos, ctx.dirRaiz, ctx.log);
      return {
        fuente: "radar",
        ok: true,
        cambiado: false,
        nota: "AEMET no ha publicado una imagen nueva",
        peticionesAemet: cuenta.n,
        metaFuente: { ...metaPrevia, actualizado: metaPrevia.actualizado ?? null, comprobado, ultimaImagen: ultimaHora(previo) },
      };
    }

    const dim = dimensionesGif(gif);
    if (dim && (dim.ancho !== ANCHO || dim.alto !== ALTO)) ctx.log(`  radar: el GIF mide ${dim.ancho}x${dim.alto} (se esperaba ${ANCHO}x${ALTO})`);

    const rutaGlifos = path.join(dir, "glifos.json");
    const aprendidos = await leerJson<Record<string, string[]>>(rutaGlifos, {});
    const lectura: LecturaHora = leerHoraRadar(gif, descarga, plantillasCon(aprendidos));
    for (const g of lectura.glifosNuevos) ctx.log(`  radar: glifo sin plantilla resuelto como "${g.caracter}": ${JSON.stringify(g.filas)}`);
    const nuevosGlifos = Object.fromEntries(lectura.glifosNuevos.filter((g) => !(g.caracter in aprendidos)).map((g) => [g.caracter, g.filas]));
    if (Object.keys(nuevosGlifos).length) await escribirAtomico(rutaGlifos, JSON.stringify({ ...aprendidos, ...nuevosGlifos }));

    if (!lectura.hora && lectura.reciente === false) {
      // La marca de hora se lee, pero no encaja con la descarga ni (de forma única) con los últimos días: es una imagen
      // antigua sin fecha segura. No se publica como reciente; se conservan las anteriores.
      ctx.log(`  radar: imagen descartada (${lectura.motivo ?? "sin fecha"})`);
      await escribirAtomico(rutaJson, JSON.stringify({ ...previo, actualizado: comprobado }));
      await sincronizarPublico(ctx.dirDatos, ctx.dirRaiz, ctx.log);
      return {
        fuente: "radar",
        ok: true,
        cambiado: false,
        nota: `imagen sin fecha fiable descartada: ${lectura.motivo ?? "?"}`,
        peticionesAemet: cuenta.n,
        metaFuente: { ...metaPrevia, actualizado: metaPrevia.actualizado ?? null, comprobado, ultimaImagen: ultimaHora(previo) },
      };
    }
    const aprox = !lectura.hora;
    const hora = lectura.hora ?? horaAproximada(descarga);
    if (aprox) ctx.log(`  radar: no se pudo leer la hora (${lectura.motivo ?? "?"}); se guarda como aproximada ${hora}`);
    if (lectura.atrasada) ctx.log(`  radar: la imagen es de ${hora}, más de 40 min antes de la descarga (radar sin imágenes nuevas)`);

    // Misma hora exacta que una imagen guardada pero contenido distinto: AEMET la ha regenerado, se sustituye
    let imagenes = previo.imagenes.filter((i) => !(!aprox && !i.aprox && i.hora === hora));
    let archivo = nombreArchivo(hora);
    if (imagenes.some((i) => i.archivo === archivo)) archivo = archivo.replace(/\.gif$/, `-${sha256.slice(0, 8)}.gif`);
    await escribirAtomico(path.join(dir, archivo), gif);
    imagenes.push({ archivo, hora, aprox, sha256, descargada: comprobado });
    imagenes = recortarImagenes(imagenes);

    await escribirAtomico(rutaJson, JSON.stringify({ actualizado: comprobado, imagenes } satisfies RadarJson));
    const quedan = new Set(imagenes.map((i) => i.archivo));
    for (const f of await readdir(dir)) if (f.endsWith(".gif") && !quedan.has(f)) await unlink(path.join(dir, f)).catch(() => {});
    await sincronizarPublico(ctx.dirDatos, ctx.dirRaiz, ctx.log);

    const metodo = aprox ? "hora aproximada" : lectura.metodo === "coherencia" ? "hora leída por coherencia" : "hora leída";
    ctx.log(`  radar: imagen nueva ${archivo} (${metodo}${lectura.texto ? `: "${lectura.texto}"` : ""}); ${imagenes.length} guardadas`);
    return {
      fuente: "radar",
      ok: true,
      cambiado: true,
      nota: `imagen nueva de ${hora}${aprox ? " (aprox.)" : ""}${lectura.atrasada ? `, con más de ${VENTANA_MIN} min de retraso` : ""}`,
      peticionesAemet: cuenta.n,
      // actualizado: última descarga con imagen nueva; ultimaImagen: hora de la imagen más reciente guardada
      metaFuente: { actualizado: comprobado, comprobado, ultimaImagen: ultimaHora({ actualizado: comprobado, imagenes }) },
    };
  } catch (e) {
    await sincronizarPublico(ctx.dirDatos, ctx.dirRaiz, ctx.log);
    const motivo = e instanceof Error ? e.message : String(e);
    ctx.log(`  radar: fallo (${motivo}); se conservan las imágenes anteriores`);
    return { fuente: "radar", ok: false, cambiado: false, nota: motivo, peticionesAemet: cuenta.n };
  }
};
