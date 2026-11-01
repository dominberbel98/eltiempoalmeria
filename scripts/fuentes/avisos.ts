// scripts/fuentes/avisos.ts
// Avisos meteorológicos de AEMET (Meteoalerta, CAP 1.2) para las zonas de Almería -> src/data/avisos.json.
//
// Comprobado en vivo el 2026-10-31 (área 61, Andalucía):
// - OpenData `avisos_cap/ultimoelaborado/area/61`: 2 peticiones (endpoint -> { estado, datos, metadatos } y datos).
//   Los datos llegan como `application/x-gtar;charset=ISO-8859-15` con Content-Disposition
//   `Z_CAP_C_LEMM_20261031104031_AFAC61.tar.gz`, pero NO vienen comprimidos: es un tar ustar plano (~450 KB).
//   El nombre lleva la hora de elaboración en UTC (AAAAMMDDhhmmss).
// - El tar es el "estado completo" de avisos de la comunidad (de ahora a pasado mañana): un XML CAP por zona y
//   fenómeno (p. ej. `..._AFAZ610402PRP10102.xml`) y, para los fenómenos sin avisos en algún día, un XML de nivel
//   verde con todas las zonas (`..._AFAZ61VV61VIRM0223.xml`). Cada XML declara UTF-8 y trae dos <info>: es-ES y en-GB.
//   Las actualizaciones llegan como msgType Update con <references> "remitente,identificador,enviado" separados por
//   espacios. Polígonos en "lat,lon" separados por espacios, con 2 decimales; geocódigo "AEMET-Meteoalerta zona"
//   (610401..610404 tierra, 610403C/610404C costa). Nivel en el parámetro "AEMET-Meteoalerta nivel".
// - Detección barata de cambios: el RSS público de la web de AEMET
//   https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAC61_RSS.xml (3 KB, CloudFront,
//   max-age 60, sin clave y fuera del cupo de OpenData) cambia a la vez que el tar: su Last-Modified y su
//   lastBuildDate coinciden con la hora del nombre del tar, responde 304 a If-Modified-Since y su primer <item>
//   enlaza el mismo tar en la web (este sí en gzip, ~22 KB), que se usa de respaldo si OpenData falla.
//
// Cadencia: en cada ejecución (cada 15 min) se pide el RSS con If-Modified-Since. Solo si hay edición nueva, no hay
// avisos.json o el último tiene más de 6 h se hacen las 2 peticiones a OpenData.
// Nunca lanza: ante un fallo conserva el avisos.json anterior y devuelve ok=false.

import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ClienteAemet, decodificarMixto, escribirJson, leerJson, mensajeError, msIso, pedir, horaLegible } from "./comun";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos";

const AREA = "61"; // Andalucía
const ENDPOINT = `/avisos_cap/ultimoelaborado/area/${AREA}`;
const RSS = `https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAC${AREA}_RSS.xml`;
const PREFIJO_ALMERIA = "6104"; // geocódigos Meteoalerta de las zonas de Almería
const REFRESCO_MS = 6 * 3600_000; // aunque el RSS no cambie, se vuelve a pedir el tar cada 6 h
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// Contrato de src/data/avisos.json
// ---------------------------------------------------------------------------------------------

export type NivelAviso = "amarillo" | "naranja" | "rojo";
/** Fenómenos de Meteoalerta (código AEMET entre paréntesis). "otro" si llega uno desconocido. */
export type Fenomeno =
  | "viento" // VI
  | "lluvia" // PR
  | "tormentas" // TO
  | "costeros" // CO
  | "temperaturas-maximas" // AT
  | "temperaturas-minimas" // BT
  | "nieve" // NE
  | "niebla" // NI
  | "polvo" // VS
  | "aludes" // AV
  | "galernas" // GA
  | "otro";

export type ZonaDeAviso = { codigo: string; nombre: string; costera: boolean };

export type Aviso = {
  /** Identificador CAP del primer mensaje (por código de zona) del grupo; estable mientras AEMET no lo actualice. */
  id: string;
  /** Todos los identificadores CAP agrupados en este aviso (uno por zona). */
  identificadores: string[];
  nivel: NivelAviso;
  fenomeno: Fenomeno;
  /** Nombre del fenómeno según AEMET: "Lluvias", "Vientos", "Temperaturas máximas"… */
  fenomenoNombre: string;
  /** <event> en español: "Aviso de lluvias de nivel amarillo" */
  titulo: string;
  /** <description>: "Precipitación acumulada en una hora: 15 mm." */
  descripcion: string;
  /** <instruction> (texto genérico del nivel), si viene */
  instruccion?: string;
  /** <onset> en ISO UTC */
  inicio: string;
  /** <expires> en ISO UTC (AEMET usa hh:59:59; para mostrar se redondea al minuto siguiente) */
  fin: string;
  /** <sent> más reciente del grupo, ISO UTC */
  emitido: string;
  /** Es una actualización de un aviso anterior (msgType Update) */
  esActualizacion: boolean;
  /** "40%-70%" (parámetro "AEMET-Meteoalerta probabilidad"), si viene */
  probabilidad?: string;
  /** Umbrales: [{ codigo: "P1", nombre: "Precipitación acumulada en una hora", valor: "15 mm" }] */
  parametros: { codigo: string; nombre: string; valor: string }[];
  /** Zonas de Almería afectadas, ordenadas por código */
  zonas: ZonaDeAviso[];
  /** Polígono de cada zona en el mismo orden que `zonas`: anillo de [lon, lat] (orden GeoJSON) */
  poligonos?: number[][][];
};

export type AvisosJson = {
  /** ISO UTC de la descarga correcta más reciente */
  actualizado: string;
  /** ISO UTC de elaboración del tar de AEMET (de su nombre de archivo) o null si no se pudo leer */
  elaborado: string | null;
  /** De dónde salió el tar: OpenData (normal) o la web de AEMET (respaldo) */
  origen: "opendata" | "web";
  /** Avisos de nivel amarillo, naranja o rojo en zonas de Almería que no habían expirado al descargar */
  avisos: Aviso[];
};

// ---------------------------------------------------------------------------------------------
// Zonas versionadas (scripts/avisos-zonas-almeria.json)
// ---------------------------------------------------------------------------------------------

export type ZonaAvisoAlmeria = {
  codigo: string; // "610401" o "610403C"
  nombre: string; // para mostrar, en frase normal
  nombreAemet: string;
  tipo: "tierra" | "costa";
  zonaTierra?: string; // en las costeras, la de tierra correspondiente
  poligono: number[][]; // [lon, lat]
};
export type MunicipioZonaAviso = { nombre: string; zona: string; costa: string[] };
export type ZonasAvisoJson = {
  fuente: string;
  metodo: string;
  generado: string;
  coordenadas: string;
  zonas: ZonaAvisoAlmeria[];
  municipios: Record<string, MunicipioZonaAviso>;
  revisados: { id: string; nombre: string; zona: string; nota: string }[];
};

export function leerZonasAviso(dirRaiz: string): ZonasAvisoJson {
  return JSON.parse(readFileSync(path.join(dirRaiz, "scripts", "avisos-zonas-almeria.json"), "utf8")) as ZonasAvisoJson;
}

// ---------------------------------------------------------------------------------------------
// tar (plano o gzip) en memoria
// ---------------------------------------------------------------------------------------------

function octal(b: Uint8Array): number {
  const s = Buffer.from(b).toString("latin1").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}
const cadena = (b: Uint8Array) => Buffer.from(b).toString("utf8").replace(/\0.*$/s, "");

/** Ficheros normales de un tar ustar (comprimido con gzip o no). Lanza si está corrupto o incompleto. */
export function leerTar(datos: Uint8Array): { nombre: string; bytes: Uint8Array }[] {
  const tar = datos[0] === 0x1f && datos[1] === 0x8b ? new Uint8Array(gunzipSync(datos)) : datos;
  const out: { nombre: string; bytes: Uint8Array }[] = [];
  let off = 0;
  let nombreLargo: string | null = null;
  let pax: Record<string, string> = {};
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return out; // fin del archivo
    let suma = 0;
    for (let i = 0; i < 512; i++) suma += i >= 148 && i < 156 ? 32 : h[i];
    if (suma !== octal(h.subarray(148, 156))) throw new Error("tar corrupto: suma de cabecera incorrecta");
    const tipo = String.fromCharCode(h[156] || 0x30);
    const tam = pax.size ? Number(pax.size) : octal(h.subarray(124, 136));
    const prefijo = Buffer.from(h.subarray(257, 262)).toString("latin1") === "ustar" ? cadena(h.subarray(345, 500)) : "";
    const nombre = pax.path ?? nombreLargo ?? (prefijo ? `${prefijo}/${cadena(h.subarray(0, 100))}` : cadena(h.subarray(0, 100)));
    const ini = off + 512;
    if (ini + tam > tar.length) throw new Error("tar incompleto");
    const cuerpo = tar.subarray(ini, ini + tam);
    if (tipo === "x") {
      pax = {};
      for (const linea of Buffer.from(cuerpo).toString("utf8").split("\n")) {
        const m = /^\d+ ([^=]+)=(.*)$/.exec(linea);
        if (m) pax[m[1]] = m[2];
      }
    } else if (tipo === "L") {
      nombreLargo = cadena(cuerpo);
    } else {
      if (tipo === "0" || tipo === "7") out.push({ nombre: nombre.split("/").pop() ?? nombre, bytes: cuerpo });
      pax = {};
      nombreLargo = null;
    }
    off = ini + Math.ceil(tam / 512) * 512;
  }
  throw new Error("tar incompleto");
}

/** "Z_CAP_C_LEMM_20261031104031_AFAC61.tar.gz" -> "2026-10-31T10:40:31.000Z" */
export function elaboradoDeNombre(nombre: string | null | undefined): string | null {
  const m = /_(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)_AFAC/.exec(nombre ?? "");
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// ---------------------------------------------------------------------------------------------
// CAP 1.2 (XML sencillo: se lee con expresiones regulares, sin dependencias)
// ---------------------------------------------------------------------------------------------

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function desescapar(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTIDADES[e.toLowerCase()]
    )
    .replace(/\s+/g, " ")
    .trim();
}
/** Contenido de la primera etiqueta `nombre` (sin espacio de nombres) o "" */
function etiqueta(xml: string, nombre: string): string {
  const m = new RegExp(`<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`).exec(xml);
  return m ? desescapar(m[1]) : "";
}
function bloques(xml: string, nombre: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${nombre}>`, "g"))].map((m) => m[1]);
}
/** Pares valueName/value de los bloques `nombre` (parameter, eventCode, geocode) */
function pares(xml: string, nombre: string): { clave: string; valor: string }[] {
  return bloques(xml, nombre).map((b) => ({ clave: etiqueta(b, "valueName"), valor: etiqueta(b, "value") }));
}

export type AreaCap = { descripcion: string; geocodigos: string[]; poligonos: number[][][] };
export type InfoCap = {
  idioma: string;
  evento: string;
  severidad: string;
  fenomenoCodigo: string; // "PR"
  fenomenoNombre: string; // "Lluvias"
  nivel: "verde" | NivelAviso | null;
  inicio: string | null; // ISO UTC
  fin: string | null;
  titular: string;
  descripcion: string;
  instruccion: string;
  probabilidad: string | null;
  parametros: { codigo: string; nombre: string; valor: string }[];
  areas: AreaCap[];
};
export type AlertaCap = {
  identificador: string;
  enviado: string | null; // ISO UTC
  estado: string; // Actual, Test, Exercise…
  tipo: string; // Alert, Update, Cancel
  referencias: string[]; // identificadores
  info: InfoCap[];
};

const isoUtc = (s: string): string | null => {
  const t = msIso(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const NIVEL_SEVERIDAD: Record<string, InfoCap["nivel"]> = { minor: "verde", moderate: "amarillo", severe: "naranja", extreme: "rojo" };
const NIVEL_TEXTO: Record<string, InfoCap["nivel"]> = {
  verde: "verde", green: "verde", amarillo: "amarillo", yellow: "amarillo", naranja: "naranja", orange: "naranja", rojo: "rojo", red: "rojo",
};

function leerNivel(params: { clave: string; valor: string }[], severidad: string): InfoCap["nivel"] {
  for (const p of params) {
    // AEMET: "AEMET-Meteoalerta nivel" = "amarillo"; Meteoalarm: "awareness_level" = "2; yellow; Moderate"
    if (/meteoalerta nivel|awareness_level/i.test(p.clave)) {
      for (const parte of p.valor.toLowerCase().split(/[;\s]+/)) if (NIVEL_TEXTO[parte]) return NIVEL_TEXTO[parte];
    }
  }
  return NIVEL_SEVERIDAD[severidad.toLowerCase()] ?? null;
}

function leerPoligono(texto: string): number[][] {
  const anillo = texto
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number))
    .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([lat, lon]) => [lon, lat]);
  return anillo.length >= 4 ? anillo : [];
}

export function parsearCap(xml: string): AlertaCap | null {
  const alerta = /<(?:\w+:)?alert[\s>][\s\S]*<\/(?:\w+:)?alert>/.exec(xml)?.[0];
  if (!alerta) return null;
  const sinInfo = alerta.replace(/<(?:\w+:)?info[\s>][\s\S]*<\/(?:\w+:)?info>/g, "");
  const referencias = etiqueta(sinInfo, "references")
    .split(/\s+/)
    .map((r) => r.split(",")[1])
    .filter((r): r is string => Boolean(r));
  const info: InfoCap[] = bloques(alerta, "info").map((b) => {
    const params = pares(b, "parameter");
    const fenomeno = pares(b, "eventCode").find((p) => /fenomeno/i.test(p.clave))?.valor ?? "";
    const [fenomenoCodigo = "", fenomenoNombre = ""] = fenomeno.split(";").map((s) => s.trim());
    const severidad = etiqueta(b, "severity");
    return {
      idioma: etiqueta(b, "language") || "es-ES",
      evento: etiqueta(b, "event"),
      severidad,
      fenomenoCodigo,
      fenomenoNombre,
      nivel: leerNivel(params, severidad),
      inicio: isoUtc(etiqueta(b, "onset") || etiqueta(b, "effective")),
      fin: isoUtc(etiqueta(b, "expires")),
      titular: etiqueta(b, "headline"),
      descripcion: etiqueta(b, "description"),
      instruccion: etiqueta(b, "instruction"),
      probabilidad: params.find((p) => /probabilidad/i.test(p.clave))?.valor || null,
      parametros: params
        .filter((p) => /meteoalerta parametro/i.test(p.clave))
        .map((p) => {
          const [codigo = "", nombre = "", ...valor] = p.valor.split(";").map((s) => s.trim());
          return { codigo, nombre, valor: valor.join("; ") };
        }),
      areas: bloques(b, "area").map((a) => ({
        descripcion: etiqueta(a, "areaDesc"),
        geocodigos: pares(a, "geocode").map((g) => g.valor).filter(Boolean),
        poligonos: bloques(a, "polygon").map((p) => leerPoligono(desescapar(p))).filter((p) => p.length),
      })),
    };
  });
  return {
    identificador: etiqueta(sinInfo, "identifier"),
    enviado: isoUtc(etiqueta(sinInfo, "sent")),
    estado: etiqueta(sinInfo, "status"),
    tipo: etiqueta(sinInfo, "msgType"),
    referencias,
    info,
  };
}

const FENOMENOS: Record<string, Fenomeno> = {
  VI: "viento", PR: "lluvia", TO: "tormentas", CO: "costeros", AT: "temperaturas-maximas", BT: "temperaturas-minimas",
  NE: "nieve", NI: "niebla", VS: "polvo", AV: "aludes", GA: "galernas",
};
/** Por si cambia el código: deducción por el nombre del fenómeno */
function fenomenoDe(codigo: string, nombre: string): Fenomeno {
  if (FENOMENOS[codigo.toUpperCase()]) return FENOMENOS[codigo.toUpperCase()];
  const n = nombre.toLowerCase();
  if (/viento/.test(n)) return "viento";
  if (/lluvia|precipit/.test(n)) return "lluvia";
  if (/tormenta/.test(n)) return "tormentas";
  if (/coster/.test(n)) return "costeros";
  if (/m[aá]xima/.test(n)) return "temperaturas-maximas";
  if (/m[ií]nima/.test(n)) return "temperaturas-minimas";
  if (/niev|nevad/.test(n)) return "nieve";
  if (/niebla/.test(n)) return "niebla";
  if (/polvo|calima/.test(n)) return "polvo";
  return "otro";
}

const ORDEN_NIVEL: Record<NivelAviso, number> = { amarillo: 1, naranja: 2, rojo: 3 };

/**
 * Avisos vigentes o futuros de Almería a partir de los CAP del tar: solo status Actual, info en español, zonas 6104xx
 * y niveles amarillo/naranja/rojo. Se descartan los mensajes Cancel, los que otro mensaje del conjunto actualiza o
 * cancela (references) y los ya expirados en `ahora`. Los mensajes con el mismo fenómeno, nivel, periodo y texto
 * (AEMET emite uno por zona) se agrupan en un solo aviso con varias zonas.
 */
export function avisosAlmeria(alertas: AlertaCap[], ahora: Date, zonasConocidas: ZonaAvisoAlmeria[] = []): Aviso[] {
  const reales = alertas.filter((a) => a.identificador && (!a.estado || a.estado === "Actual"));
  const referenciados = new Set(reales.flatMap((a) => a.referencias));
  const nombreZona = new Map(zonasConocidas.map((z) => [z.codigo, z]));
  const ahoraMs = ahora.getTime();

  type Pieza = { alerta: AlertaCap; info: InfoCap; zona: ZonaDeAviso; poligono: number[][] | null };
  const piezas: Pieza[] = [];
  for (const a of reales) {
    if (a.tipo === "Cancel" || referenciados.has(a.identificador)) continue;
    const info = a.info.find((i) => /^es/i.test(i.idioma)) ?? a.info[0];
    if (!info || !info.nivel || info.nivel === "verde" || !info.fin) continue;
    if (Date.parse(info.fin) <= ahoraMs) continue;
    for (const area of info.areas) {
      const codigo = area.geocodigos.find((g) => g.startsWith(PREFIJO_ALMERIA));
      if (!codigo) continue;
      const conocida = nombreZona.get(codigo);
      piezas.push({
        alerta: a,
        info,
        zona: { codigo, nombre: conocida?.nombre ?? area.descripcion.replace(/^Costa - /, "Costa de "), costera: conocida ? conocida.tipo === "costa" : /C$/i.test(codigo) },
        poligono: area.poligonos[0] ?? conocida?.poligono ?? null,
      });
    }
  }

  const grupos = new Map<string, Pieza[]>();
  for (const p of piezas) {
    const i = p.info;
    const clave = [i.fenomenoCodigo, i.nivel, i.inicio, i.fin, i.descripcion, JSON.stringify(i.parametros), i.probabilidad].join("|");
    grupos.set(clave, [...(grupos.get(clave) ?? []), p]);
  }

  const avisos: Aviso[] = [];
  for (const grupo of grupos.values()) {
    // una zona solo una vez por grupo (si dos mensajes repiten zona, gana el enviado más tarde)
    const porZona = new Map<string, Pieza>();
    for (const p of grupo) {
      const previa = porZona.get(p.zona.codigo);
      if (!previa || (p.alerta.enviado ?? "") > (previa.alerta.enviado ?? "")) porZona.set(p.zona.codigo, p);
    }
    const lista = [...porZona.values()].sort((a, b) => a.zona.codigo.localeCompare(b.zona.codigo));
    const i = lista[0].info;
    const poligonos = lista.map((p) => p.poligono);
    avisos.push({
      id: lista[0].alerta.identificador,
      identificadores: [...new Set(lista.map((p) => p.alerta.identificador))],
      nivel: i.nivel as NivelAviso,
      fenomeno: fenomenoDe(i.fenomenoCodigo, i.fenomenoNombre),
      fenomenoNombre: i.fenomenoNombre || i.evento,
      titulo: i.evento,
      descripcion: i.descripcion,
      ...(i.instruccion ? { instruccion: i.instruccion } : {}),
      inicio: i.inicio ?? lista[0].alerta.enviado ?? ahora.toISOString(),
      fin: i.fin as string,
      emitido: lista.map((p) => p.alerta.enviado ?? "").sort().at(-1) || ahora.toISOString(),
      esActualizacion: lista.some((p) => p.alerta.tipo === "Update"),
      ...(i.probabilidad ? { probabilidad: i.probabilidad } : {}),
      parametros: i.parametros,
      zonas: lista.map((p) => p.zona),
      ...(poligonos.every((p): p is number[][] => p != null) ? { poligonos } : {}),
    });
  }
  return avisos.sort(
    (a, b) => ORDEN_NIVEL[b.nivel] - ORDEN_NIVEL[a.nivel] || a.inicio.localeCompare(b.inicio) || a.fenomeno.localeCompare(b.fenomeno) || a.id.localeCompare(b.id)
  );
}

/** Lee los XML de un tar y devuelve las alertas CAP (los XML que no se pueden leer se ignoran y se cuentan). */
export function alertasDeTar(datos: Uint8Array): { alertas: AlertaCap[]; ficheros: number; ilegibles: number } {
  const ficheros = leerTar(datos).filter((f) => /\.xml$/i.test(f.nombre));
  const alertas: AlertaCap[] = [];
  let ilegibles = 0;
  for (const f of ficheros) {
    const a = parsearCap(decodificarMixto(f.bytes));
    if (a) alertas.push(a);
    else ilegibles++;
  }
  return { alertas, ficheros: ficheros.length, ilegibles };
}

// ---------------------------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------------------------

type Rss = { estado: 200 | 304; lastModified: string | null; elaborado: string | null; enlaceTar: string | null };

async function pedirRss(lastModified: string | null, log: (m: string) => void): Promise<Rss> {
  const r = await pedir(RSS, {
    cabeceras: lastModified ? { "If-Modified-Since": lastModified } : {},
    aceptar: [304],
    intentos: 2,
    timeoutMs: 15_000,
    log,
    etiqueta: "RSS de avisos",
  });
  const lm = r.headers.get("last-modified");
  if (r.status === 304) return { estado: 304, lastModified: lm ?? lastModified, elaborado: null, enlaceTar: null };
  const xml = r.texto();
  const enlaces = bloques(xml, "item").map((it) => etiqueta(it, "link"));
  const enlaceTar = enlaces.find((l) => /_AFAC\d+\.tar(\.gz)?$/i.test(l)) ?? null;
  const elaborado = elaboradoDeNombre(enlaceTar) ?? isoUtc(etiqueta(xml, "lastBuildDate"));
  return { estado: 200, lastModified: lm, elaborado, enlaceTar: enlaceTar && /^https:\/\/www\.aemet\.es\//.test(enlaceTar) ? enlaceTar : null };
}

type Descarga = { bytes: Uint8Array; elaborado: string | null; origen: AvisosJson["origen"] };

async function descargarOpenData(cliente: ClienteAemet): Promise<Descarga> {
  const r = await cliente.datos(ENDPOINT, /x-gtar|x-tar|gzip|octet-stream/i, 60_000, { intentos: 2 });
  const disp = r.headers.get("content-disposition") ?? "";
  return { bytes: r.bytes, elaborado: elaboradoDeNombre(/filename="?([^";]+)/i.exec(disp)?.[1]), origen: "opendata" };
}

async function descargarWeb(url: string, log: (m: string) => void): Promise<Descarga> {
  const r = await pedir(url, { intentos: 2, timeoutMs: TIMEOUT_MS, log, etiqueta: "tar de avisos (web)" });
  return { bytes: r.bytes, elaborado: elaboradoDeNombre(url), origen: "web" };
}

export const actualizar: Fuente = async (ctx: Ctx): Promise<ResultadoFuente> => {
  const ruta = path.join(ctx.dirDatos, "avisos.json");
  const previoMeta = (ctx.meta.fuentes.avisos ?? {}) as { rss?: { lastModified?: string | null } };
  const cliente = new ClienteAemet(ctx.aemetKey, ctx.log);
  const res = (r: Omit<ResultadoFuente, "fuente" | "peticionesAemet">): ResultadoFuente => ({ fuente: "avisos", peticionesAemet: cliente.peticiones, ...r });
  try {
    const previo = await leerJson<AvisosJson | null>(ruta, null);
    const valido = previo && Array.isArray(previo.avisos) ? previo : null;
    const edad = valido ? ctx.ahora.getTime() - Date.parse(valido.actualizado) : Number.POSITIVE_INFINITY;
    const fresco = valido != null && edad < REFRESCO_MS && !ctx.forzar;

    // 1. RSS público: detecta si hay edición nueva sin gastar cupo de OpenData
    let rss: Rss | null = null;
    try {
      rss = await pedirRss(valido ? previoMeta.rss?.lastModified ?? null : null, ctx.log);
    } catch (e) {
      ctx.log(`  avisos: RSS no disponible (${mensajeError(e)}); se pide OpenData`);
    }
    // El Last-Modified del RSS solo se guarda cuando ya tenemos esa edición: si no, el 304 siguiente la daría por vista
    const lmPrevio = previoMeta.rss?.lastModified ?? null;
    const metaRss = (alDia: boolean) => ({ rss: { lastModified: (alDia ? rss?.lastModified : null) ?? lmPrevio } });
    if (fresco && valido && rss && (rss.estado === 304 || (rss.elaborado != null && rss.elaborado === valido.elaborado))) {
      return res({ ok: true, cambiado: false, nota: `sin edición nueva (${horaLegible(valido.elaborado)})`, metaFuente: metaRss(true) });
    }

    // 2. Tar: OpenData; si falla (o trae una edición anterior a la del RSS), el tar enlazado desde el RSS
    let descarga: Descarga | null = null;
    const errores: string[] = [];
    if (ctx.aemetKey) {
      try {
        descarga = await descargarOpenData(cliente);
      } catch (e) {
        errores.push(`OpenData: ${mensajeError(e)}`);
      }
    } else errores.push("OpenData: sin AEMET_API_KEY");
    const atrasado = descarga && rss?.elaborado && descarga.elaborado && descarga.elaborado < rss.elaborado;
    if ((!descarga || atrasado) && rss?.enlaceTar) {
      try {
        const web = await descargarWeb(rss.enlaceTar, ctx.log);
        if (!descarga || (web.elaborado ?? "") > (descarga.elaborado ?? "")) descarga = web;
      } catch (e) {
        errores.push(`web: ${mensajeError(e)}`);
      }
    }
    if (!descarga) {
      return res({ ok: false, cambiado: false, nota: `se conservan los avisos anteriores: ${errores.join("; ")}`, metaFuente: metaRss(false) });
    }

    // 3. Parseo y filtro
    const { alertas, ficheros, ilegibles } = alertasDeTar(descarga.bytes);
    if (!ficheros || !alertas.length) throw new Error(`tar sin CAP legibles (${ficheros} XML)`);
    let zonas: ZonaAvisoAlmeria[] = [];
    try {
      zonas = leerZonasAviso(ctx.dirRaiz).zonas;
    } catch (e) {
      ctx.log(`  avisos: no se pudo leer scripts/avisos-zonas-almeria.json (${mensajeError(e)})`);
    }
    const avisos = avisosAlmeria(alertas, ctx.ahora, zonas);
    const elaborado = descarga.elaborado ?? (alertas.map((a) => a.enviado ?? "").sort().at(-1) || null);
    const datos: AvisosJson = { actualizado: ctx.ahora.toISOString(), elaborado, origen: descarga.origen, avisos };
    await escribirJson(ruta, datos);

    const cambiado = !valido || valido.elaborado !== elaborado || JSON.stringify(valido.avisos) !== JSON.stringify(avisos);
    const resumen = avisos.length
      ? avisos.map((a) => `${a.nivel} ${a.fenomeno} (${a.zonas.length} zona${a.zonas.length === 1 ? "" : "s"})`).join(", ")
      : "ninguno en Almería";
    const notas = [
      `${ficheros} CAP de ${descarga.origen === "web" ? "la web" : "OpenData"}, elaborado ${horaLegible(elaborado)}`,
      `avisos: ${resumen}`,
      ilegibles ? `${ilegibles} XML ilegibles` : "",
      errores.length ? errores.join("; ") : "",
    ].filter(Boolean);
    return res({
      ok: true,
      cambiado,
      nota: notas.join("; "),
      metaFuente: {
        actualizado: datos.actualizado,
        elaborado,
        origen: descarga.origen,
        avisos: avisos.length,
        ...metaRss(!rss?.elaborado || (elaborado ?? "") >= rss.elaborado),
      },
    });
  } catch (e) {
    return res({ ok: false, cambiado: false, nota: `se conservan los avisos anteriores: ${mensajeError(e)}` });
  }
};
