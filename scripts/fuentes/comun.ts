// Utilidades compartidas por los módulos de descarga: HTTP con reintentos, cliente de AEMET OpenData
// (dos pasos y ritmo máximo de 40 peticiones/min), Open-Meteo (cuota y pesos), decodificación de texto,
// fechas en Europe/Madrid y lectura/escritura de JSON en src/data/.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const mensajeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Texto ---

// Decodifica cada secuencia UTF-8 válida como UTF-8 y cada byte suelto no válido como Latin-1.
// AEMET declara ISO-8859-15 pero envía UTF-8, Latin-1 o ambos mezclados en el mismo archivo.
export function decodificarMixto(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8");
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    const largo = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1;
    if (b >= 0x80 && largo > 1 && i + largo <= bytes.length) {
      const seq = bytes.subarray(i, i + largo);
      if (seq.subarray(1).every((c) => c >= 0x80 && c <= 0xbf)) {
        out += utf8.decode(seq);
        i += largo;
        continue;
      }
    }
    out += String.fromCharCode(b);
    i += 1;
  }
  return out;
}

export function decodificarTexto(bytes: Uint8Array, contentType?: string | null): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const charset = /charset=([^;]+)/i.exec(contentType ?? "")?.[1]?.trim().toLowerCase() ?? "";
    return charset.startsWith("utf") ? new TextDecoder("utf-8").decode(bytes) : decodificarMixto(bytes);
  }
}

// --- Normalización ---

// Las listas convertidas desde XML llegan como objeto o texto suelto cuando tienen un solo elemento.
export const toArray = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Número desde número o texto. Ausente o vacío => null (nunca 0).
export function numONulo(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// --- Fechas ---

export const ZONA = "Europe/Madrid";

export function partesMadrid(fecha: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(fecha)
      .map((x) => [x.type, x.value])
  );
  return { anio: p.year, mes: p.month, dia: p.day, hora: p.hour, minuto: p.minute };
}

/** "YYYY-MM-DD" en Europe/Madrid */
export function fechaMadrid(fecha: Date): string {
  const p = partesMadrid(fecha);
  return `${p.anio}-${p.mes}-${p.dia}`;
}

/** "YYYY-MM-DDTHH:00" en Europe/Madrid */
export function horaMadrid(fecha: Date): string {
  const p = partesMadrid(fecha);
  return `${p.anio}-${p.mes}-${p.dia}T${p.hora}:00`;
}

/** Hora legible en Europe/Madrid para los registros: "29/10 08:15" */
export function horaLegible(fecha: Date | string | null | undefined): string {
  if (!fecha) return "—";
  const d = typeof fecha === "string" ? new Date(fecha) : fecha;
  if (Number.isNaN(d.getTime())) return "—";
  const p = partesMadrid(d);
  return `${p.dia}/${p.mes} ${p.hora}:${p.minuto}`;
}

/** Instante (ms) de un `elaborado` de AEMET: está en UTC aunque no lleva "Z". */
export function msElaborado(elaborado: string | null | undefined): number {
  if (!elaborado) return Number.NaN;
  const s = String(elaborado).trim();
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s + "Z");
}

/** Instante (ms) de un ISO con zona (admite "+0100" sin dos puntos). */
export function msIso(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(String(iso).trim().replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
}

/** Minutos transcurridos desde un ISO; Infinity si no hay fecha válida. */
export function minutosDesde(iso: string | null | undefined, ahora: Date): number {
  const t = msIso(iso);
  return Number.isFinite(t) ? (ahora.getTime() - t) / 60_000 : Number.POSITIVE_INFINITY;
}

// --- JSON en disco ---

export const existe = (ruta: string) => existsSync(ruta);

export async function leerJson<T>(ruta: string, siFalta: T): Promise<T> {
  try {
    return JSON.parse(await readFile(ruta, "utf8")) as T;
  } catch {
    return siFalta;
  }
}

// Escritura atómica (temporal + rename) para no dejar JSON a medias si el proceso se corta.
export async function escribirJson(ruta: string, datos: unknown): Promise<void> {
  await mkdir(path.dirname(ruta), { recursive: true });
  const texto = JSON.stringify(datos);
  const tmp = `${ruta}.${process.pid}.tmp`;
  await writeFile(tmp, texto);
  try {
    await rename(tmp, ruta);
  } catch {
    // En Windows/OneDrive el rename puede fallar si otro proceso tiene el archivo abierto
    await writeFile(ruta, texto);
    await rm(tmp, { force: true });
  }
}

// --- Municipios ---

export type Municipio = { id: string; nombre: string; slug: string; lat: number; lon: number; altitud: number };
export type DatosMunicipio = { aemetDiaria: unknown; aemetHoraria: unknown; openMeteo: unknown };

/** Lista de municipios desde la semilla versionada scripts/municipios-almeria.json (ya no se usa /maestro/municipios). */
export async function municipiosDesdeSemilla(dirRaiz: string): Promise<Municipio[]> {
  const semilla = JSON.parse(await readFile(path.join(dirRaiz, "scripts", "municipios-almeria.json"), "utf8")) as Omit<
    Municipio,
    "slug"
  >[];
  return semilla
    .map((m) => ({
      id: String(m.id),
      nombre: m.nombre,
      slug: slugify(m.nombre),
      lat: Number(m.lat),
      lon: Number(m.lon),
      altitud: Number(m.altitud),
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/** municipios.json de src/data (lo escribe el orquestador al empezar); si no existe, la semilla. */
export async function leerMunicipios(ctx: { dirDatos: string; dirRaiz: string }): Promise<Municipio[]> {
  const lista = await leerJson<Municipio[]>(path.join(ctx.dirDatos, "municipios.json"), []);
  return lista.length ? lista : municipiosDesdeSemilla(ctx.dirRaiz);
}

export const rutaMunicipio = (dirDatos: string, id: string) => path.join(dirDatos, "municipios", `${id}.json`);

export async function leerDatosMunicipio(dirDatos: string, id: string): Promise<DatosMunicipio> {
  const d = await leerJson<Partial<DatosMunicipio> | null>(rutaMunicipio(dirDatos, id), null);
  return { aemetDiaria: d?.aemetDiaria ?? null, aemetHoraria: d?.aemetHoraria ?? null, openMeteo: d?.openMeteo ?? null };
}

/** Actualiza solo las partes indicadas del JSON del municipio y conserva el resto. */
export async function guardarDatosMunicipio(dirDatos: string, id: string, parcial: Partial<DatosMunicipio>): Promise<void> {
  const actual = await leerDatosMunicipio(dirDatos, id);
  await escribirJson(rutaMunicipio(dirDatos, id), { ...actual, ...parcial });
}

// --- HTTP ---

export class ErrorHttp extends Error {
  constructor(
    mensaje: string,
    readonly status: number,
    readonly cuerpo = ""
  ) {
    super(mensaje);
  }
}

export type Respuesta = {
  status: number;
  url: string;
  headers: Headers;
  bytes: Uint8Array;
  texto: () => string;
};

export type OpcionesPedir = {
  metodo?: "GET" | "POST";
  cabeceras?: Record<string, string>;
  cuerpo?: string;
  /** Intentos totales (1 = sin reintentos). */
  intentos?: number;
  timeoutMs?: number;
  /** Estados no 2xx que se devuelven sin lanzar (p. ej. 304). */
  aceptar?: number[];
  /** Ante un 429: ms que esperar antes de reintentar, o null para no reintentar. */
  ante429?: (r: Respuesta, intento: number) => number | null;
  /** Se ejecuta antes de cada intento (ritmo y recuento de peticiones). */
  antes?: () => Promise<void> | void;
  log?: (msg: string) => void;
  /** Texto para los registros en lugar de la URL (nunca debe contener claves). */
  etiqueta?: string;
};

const recortar = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\s+/g, " ");

export async function pedir(url: string, op: OpcionesPedir = {}): Promise<Respuesta> {
  const intentos = Math.max(1, op.intentos ?? 4);
  const etiqueta = op.etiqueta ?? url;
  let ultimoError: unknown = null;
  for (let intento = 1; intento <= intentos; intento++) {
    await op.antes?.();
    let r: Respuesta;
    try {
      const res = await fetch(url, {
        method: op.metodo ?? "GET",
        headers: op.cabeceras,
        body: op.cuerpo,
        signal: AbortSignal.timeout(op.timeoutMs ?? 30_000),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      r = { status: res.status, url: res.url || url, headers: res.headers, bytes, texto: () => decodificarTexto(bytes, res.headers.get("content-type")) };
    } catch (e) {
      ultimoError = e;
      op.log?.(`  error de red en ${etiqueta} (intento ${intento}/${intentos}): ${mensajeError(e)}`);
      if (intento < intentos) await sleep(3_000 * intento);
      continue;
    }
    if ((r.status >= 200 && r.status < 300) || op.aceptar?.includes(r.status)) return r;
    const cuerpo = recortar(r.texto());
    if (r.status === 429) {
      const espera = op.ante429 ? op.ante429(r, intento) : 15_000 * intento;
      ultimoError = new ErrorHttp(`429 en ${etiqueta}: ${cuerpo}`, 429, cuerpo);
      if (espera == null || intento >= intentos) throw ultimoError;
      op.log?.(`  429 en ${etiqueta}; espero ${Math.round(espera / 1000)} s (intento ${intento}/${intentos})`);
      await sleep(espera);
      continue;
    }
    if (r.status >= 500) {
      ultimoError = new ErrorHttp(`${r.status} en ${etiqueta}: ${cuerpo}`, r.status, cuerpo);
      op.log?.(`  ${r.status} en ${etiqueta} (intento ${intento}/${intentos})`);
      if (intento < intentos) await sleep(5_000 * intento);
      continue;
    }
    throw new ErrorHttp(`${r.status} en ${etiqueta}: ${cuerpo}`, r.status, cuerpo);
  }
  throw ultimoError instanceof Error ? ultimoError : new Error(`Demasiados reintentos: ${etiqueta}`);
}

// --- AEMET OpenData ---

export const AEMET_API = "https://opendata.aemet.es/opendata/api";
/** Pausa mínima entre peticiones a AEMET: 40/min por usuario => 1,5 s; se deja margen. */
export const PAUSA_AEMET_MS = 1_600;
let ultimaPeticionAemet = 0; // compartida por todos los clientes del proceso

/** Ajustes de reintento para una llamada concreta (p. ej. el respaldo por municipio, más corto). */
export type OpcionesAemet = Pick<OpcionesPedir, "intentos" | "timeoutMs" | "ante429">;

/**
 * El fallo es transitorio y de todo el servicio (red, tiempo agotado, 5xx o 429, incluido el {estado: 429} que AEMET
 * devuelve con HTTP 200): seguir pidiendo en la misma ejecución solo alarga el job.
 */
export function esFalloDeServicio(e: unknown): boolean {
  if (e instanceof ErrorHttp) return e.status === 429 || e.status >= 500;
  if (!(e instanceof Error)) return false;
  if (e.name === "TimeoutError" || e.name === "AbortError" || e.name === "TypeError") return true;
  return /estado (429|5\d\d)\b|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket/i.test(e.message);
}

export class ClienteAemet {
  peticiones = 0;
  constructor(
    private readonly key: string | undefined,
    private readonly log: (msg: string) => void
  ) {}

  private async turno() {
    const espera = ultimaPeticionAemet + PAUSA_AEMET_MS - Date.now();
    if (espera > 0) await sleep(espera);
    ultimaPeticionAemet = Date.now();
    this.peticiones++;
  }

  /** Petición a AEMET (con o sin clave) respetando el ritmo y contando cada intento. */
  pedir(url: string, op: OpcionesPedir = {}): Promise<Respuesta> {
    return pedir(url, {
      intentos: 3,
      ante429: (_r, intento) => 60_000 * intento,
      log: this.log,
      ...op,
      antes: () => this.turno(),
    });
  }

  /**
   * Dos pasos: endpoint (con clave) => { estado, datos } => GET datos (la URL caduca a ~5 min).
   * `tipo` valida el Content-Type de los datos. Una URL caducada responde 200 con JSON {estado: 404}.
   */
  async datos(endpoint: string, tipo: RegExp, timeoutMs = 60_000, op: OpcionesAemet = {}): Promise<Respuesta> {
    if (!this.key) throw new Error("Falta AEMET_API_KEY");
    const r1 = await this.pedir(`${AEMET_API}${endpoint}`, { ...op, cabeceras: { api_key: this.key }, etiqueta: endpoint });
    const restantes = r1.headers.get("remaining-request-endpoint");
    let paso1: { estado?: number; datos?: string; descripcion?: string };
    try {
      paso1 = JSON.parse(r1.texto());
    } catch {
      throw new Error(`AEMET ${endpoint}: respuesta no JSON (${r1.headers.get("content-type")})`);
    }
    if (paso1.estado !== 200 || typeof paso1.datos !== "string") {
      throw new Error(`AEMET ${endpoint}: estado ${paso1.estado ?? "?"} ${paso1.descripcion ?? ""}`.trim());
    }
    if (restantes != null && Number(restantes) < 5) this.log(`  aviso: AEMET remaining-request-endpoint=${restantes} en ${endpoint}`);
    const r2 = await this.pedir(paso1.datos, { ...op, timeoutMs, etiqueta: `${endpoint} (datos)` });
    const ct = r2.headers.get("content-type") ?? "";
    if (!tipo.test(ct)) {
      let detalle = "";
      if (/json/i.test(ct)) {
        try {
          const j = JSON.parse(r2.texto());
          detalle = `estado ${j.estado ?? "?"} ${j.descripcion ?? ""}`;
        } catch {
          /* sin detalle */
        }
      }
      throw new Error(`AEMET ${endpoint}: datos con Content-Type inesperado "${ct}" ${detalle}`.trim());
    }
    return r2;
  }

  /** Datos JSON (dos pasos). Rechaza los objetos de error {estado, descripcion} que llegan con HTTP 200. */
  async json<T>(endpoint: string, op: OpcionesAemet = {}): Promise<T> {
    const r = await this.datos(endpoint, /json|text\/plain/i, op.timeoutMs ?? 60_000, op);
    const datos = JSON.parse(r.texto());
    if (datos && !Array.isArray(datos) && typeof datos === "object" && "estado" in datos && "descripcion" in datos && Object.keys(datos).length <= 3) {
      throw new Error(`AEMET ${endpoint}: estado ${datos.estado} ${datos.descripcion}`);
    }
    return datos as T;
  }
}

// --- Open-Meteo ---

/** Peso de una petición: Σ por ubicación de max(1, variables × modelos / 10 × max(1, días / 14)). */
export function pesoOpenMeteo(ubicaciones: number, variables: number, modelos = 1, dias = 7): number {
  return ubicaciones * Math.max(1, ((variables * modelos) / 10) * Math.max(1, dias / 14));
}

/**
 * Petición a Open-Meteo (plan gratuito, 1 petición simultánea por IP: llamar siempre en serie).
 * 429 por minuto o por concurrencia: espera 61 s y reintenta como mucho 2 veces. 429 por hora, día o mes: no reintenta.
 */
export function pedirOpenMeteo(url: string, op: Pick<OpcionesPedir, "metodo" | "cuerpo" | "cabeceras" | "log" | "timeoutMs"> = {}) {
  return pedir(url, {
    intentos: 3,
    timeoutMs: 90_000,
    ...op,
    etiqueta: url.split("?")[0],
    ante429: (r) => {
      const motivo = r.texto();
      if (/hour|daily|day|month/i.test(motivo)) return null;
      const retry = Number(r.headers.get("retry-after"));
      return Number.isFinite(retry) && retry > 0 ? Math.max(retry * 1000, 61_000) : 61_000;
    },
  });
}
