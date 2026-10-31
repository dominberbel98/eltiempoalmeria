// Predicción municipal de AEMET (diaria y horaria) para los 103 municipios.
//
// En cada ejecución se pide el feed ATOM de "Predicción municipio" (sin clave, admite 304). Solo si hay
// edición nueva, faltan municipios o los datos tienen más de 6 h se descargan horaria/todos y diaria/todos
// (dos tar.gz con toda España, 4 peticiones en total), se extraen los 103 de Almería, se normalizan y se
// adaptan al formato JSON del endpoint por municipio, que es el que leen src/lib/datos.ts y tiempo.ts.
// Si el tar falla o le faltan municipios: respaldo por municipio en lotes de ≤35 por ejecución.
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import {
  ClienteAemet,
  guardarDatosMunicipio,
  horaLegible,
  leerDatosMunicipio,
  leerMunicipios,
  mensajeError,
  msElaborado,
  msIso,
  numONulo,
  toArray,
  type Municipio,
} from "./comun";
import type { Ctx, Fuente, ResultadoFuente } from "./tipos";

const ATOM = "https://opendata.aemet.es/rss/predesp_mun_opendata_todos_ATOM.xml";
const H = 3_600_000;
const MAX_EDAD_MS = 6 * H; // descarga completa como mínimo cada 6 h aunque el ATOM no avise
const REINTENTO_TODOS_MS = 30 * 60_000;
const REINTENTO_MUNICIPIOS_MS = 60 * 60_000;
const LOTE_MUNICIPIOS = 35;
const MAX_INTENTOS_PUBLICADO = 4; // tras 4 descargas sin alcanzar la edición anunciada, se deja de perseguir
const PROVINCIA = "Almería";

type Tipo = "horaria" | "diaria";
type Valor = string | number | null;

// ---------------------------------------------------------------------------------------------
// Lector ustar mínimo sobre gunzip en streaming: solo guarda los ficheros pedidos y para en cuanto los tiene.

function octal(campo: Buffer): number {
  if (campo[0] & 0x80) {
    // codificación base-256 (GNU) para tamaños enormes
    let n = 0;
    for (let i = 1; i < campo.length; i++) n = n * 256 + campo[i];
    return n;
  }
  const s = campo.toString("latin1").replace(/\0.*$/s, "").trim();
  return s ? parseInt(s, 8) : 0;
}

const texto = (campo: Buffer) => campo.toString("utf8").replace(/\0.*$/s, "");

function sumaCabeceraOk(h: Buffer): boolean {
  let suma = 0;
  for (let i = 0; i < 512; i++) suma += i >= 148 && i < 156 ? 32 : h[i];
  return suma === octal(h.subarray(148, 156));
}

function leerPax(datos: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < datos.length) {
    const esp = datos.indexOf(0x20, i);
    if (esp < 0) break;
    const largo = parseInt(datos.subarray(i, esp).toString("latin1"), 10);
    if (!largo) break;
    const registro = datos.subarray(esp + 1, i + largo - 1).toString("utf8");
    const igual = registro.indexOf("=");
    if (igual > 0) out[registro.slice(0, igual)] = registro.slice(igual + 1);
    i += largo;
  }
  return out;
}

/** Extrae de un tar.gz los ficheros cuyo nombre base está en `quiero`. */
export async function extraerTar(gz: Uint8Array, quiero: Set<string>): Promise<Map<string, Buffer>> {
  const salida = new Map<string, Buffer>();
  const flujo = Readable.from([Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength)]).pipe(createGunzip());
  let resto: Buffer = Buffer.alloc(0);
  let estado: "cabecera" | "datos" | "relleno" = "cabecera";
  let restantes = 0;
  let relleno = 0;
  let nombre = "";
  let tipo = "";
  let trozos: Buffer[] | null = null;
  let pax: Record<string, string> = {};
  let nombreLargo: string | null = null;
  let fin = false;

  try {
    for await (const trozo of flujo as AsyncIterable<Buffer>) {
      let buf = resto.length ? Buffer.concat([resto, trozo]) : trozo;
      let off = 0;
      while (!fin) {
        if (estado === "cabecera") {
          if (buf.length - off < 512) break;
          const h = buf.subarray(off, off + 512);
          off += 512;
          if (h[0] === 0 && h.every((b) => b === 0)) {
            fin = true; // bloque de ceros: fin del archivo
            break;
          }
          if (!sumaCabeceraOk(h)) throw new Error("tar corrupto: suma de cabecera incorrecta");
          tipo = String.fromCharCode(h[156] || 0x30);
          const base = texto(h.subarray(0, 100));
          const prefijo = h.subarray(257, 262).toString("latin1") === "ustar" ? texto(h.subarray(345, 500)) : "";
          nombre = pax.path ?? nombreLargo ?? (prefijo ? `${prefijo}/${base}` : base);
          restantes = pax.size ? Number(pax.size) : octal(h.subarray(124, 136));
          if (tipo !== "x" && tipo !== "g" && tipo !== "L") {
            pax = {};
            nombreLargo = null;
          }
          relleno = (512 - (restantes % 512)) % 512;
          const nombreBase = nombre.split("/").pop() ?? nombre;
          const esFichero = tipo === "0" || tipo === "7";
          trozos = tipo === "x" || tipo === "L" || (esFichero && quiero.has(nombreBase)) ? [] : null;
          estado = "datos";
        }
        if (estado === "datos") {
          const n = Math.min(restantes, buf.length - off);
          if (trozos && n > 0) trozos.push(Buffer.from(buf.subarray(off, off + n)));
          off += n;
          restantes -= n;
          if (restantes > 0) break;
          if (trozos) {
            const datos = Buffer.concat(trozos);
            if (tipo === "x") pax = leerPax(datos);
            else if (tipo === "L") nombreLargo = texto(datos);
            else salida.set(nombre.split("/").pop() ?? nombre, datos);
          }
          trozos = null;
          estado = "relleno";
        }
        if (estado === "relleno") {
          const n = Math.min(relleno, buf.length - off);
          off += n;
          relleno -= n;
          if (relleno > 0) break;
          estado = "cabecera";
          if (salida.size === quiero.size) fin = true; // ya están todos: no hace falta descomprimir el resto
        }
      }
      resto = Buffer.from(buf.subarray(off));
      if (fin) break;
    }
  } finally {
    flujo.destroy();
  }
  if (!fin && estado !== "cabecera") throw new Error("tar incompleto");
  return salida;
}

// ---------------------------------------------------------------------------------------------
// Normalización y adaptación del formato de los tar (JSON derivado del XML) al del endpoint por municipio.
// En el tar: claves con guion bajo, "valor" en vez de "value", todo en texto, listas de un elemento
// colapsadas a objeto o texto, periodos pasados sin "valor" y nombres con doble codificación.

type Nodo = Record<string, unknown>;
const esObjeto = (x: unknown): x is Nodo => x != null && typeof x === "object" && !Array.isArray(x);

/** Lista de {periodo?, valor?, ...}: admite array, objeto suelto o texto suelto (= solo valor). */
function elementos(x: unknown): Nodo[] {
  return toArray(x as unknown).map((e) => (esObjeto(e) ? e : { valor: e }));
}

const textoONulo = (v: unknown): string | null => (v == null || v === "" ? null : String(v).trim());
const fechaDia = (f: unknown) => `${String(f).slice(0, 10)}T00:00:00`;

/** Ordena por la hora del periodo ("07", "23"...) sin perder el orden original en empates. */
const horaPeriodo = (p: unknown) => {
  const n = Number(String(p ?? "").slice(0, 2));
  return Number.isFinite(n) ? n : 99;
};

function origen(o: unknown, id: string, tipo: Tipo, nombre: string) {
  const x = esObjeto(o) ? o : {};
  return {
    productor: textoONulo(x.productor) ?? "Agencia Estatal de Meteorología - AEMET. Gobierno de España",
    web: textoONulo(x.web) ?? "https://www.aemet.es",
    enlace:
      textoONulo(x.enlace) ??
      `https://www.aemet.es/es/eltiempo/prediccion/municipios/${tipo === "horaria" ? "horas/" : ""}${nombre}-id${id}`,
    language: textoONulo(x.language) ?? "es",
    copyright:
      textoONulo(x.copyright) ?? "© AEMET. Autorizado el uso de la información y su reproducción citando a AEMET como autora de la misma.",
    notaLegal: textoONulo(x.nota_legal ?? x.notaLegal) ?? "https://www.aemet.es/es/nota_legal",
  };
}

/** Lista horaria o de bloques en formato por municipio: [{ value, periodo, descripcion? }] (valores en texto, ausente = null). */
function serie(x: unknown, conDescripcion = false) {
  return elementos(x).map((e) => {
    const out: { value: string | null; periodo?: string; descripcion?: string } = { value: textoONulo(e.valor ?? e.value) };
    if (e.periodo != null) out.periodo = String(e.periodo);
    if (conDescripcion) out.descripcion = String(e.descripcion ?? "");
    return out;
  });
}

/** vientoAndRachaMax: por cada hora, {direccion:[d], velocidad:[v], periodo} seguido de {value: racha, periodo}. */
function vientoYRacha(viento: unknown, racha: unknown) {
  const vientos = elementos(viento);
  const rachas = elementos(racha);
  const periodos = [...new Set([...vientos, ...rachas].map((e) => String(e.periodo ?? "")))].sort((a, b) => horaPeriodo(a) - horaPeriodo(b));
  const out: unknown[] = [];
  for (const p of periodos) {
    const v = vientos.find((e) => String(e.periodo ?? "") === p);
    if (v) out.push({ direccion: [textoONulo(v.direccion) ?? ""], velocidad: [textoONulo(v.velocidad)], periodo: p });
    const r = rachas.find((e) => String(e.periodo ?? "") === p);
    if (r) out.push({ value: textoONulo(r.valor ?? r.value), periodo: p });
  }
  return out;
}

export function adaptarHoraria(root: Nodo, m: Pick<Municipio, "id" | "nombre" | "slug">) {
  const pred = esObjeto(root.prediccion) ? root.prediccion : {};
  const dias = elementos(pred.dia).map((d) => ({
    estadoCielo: serie(d.estado_cielo, true),
    precipitacion: serie(d.precipitacion),
    probPrecipitacion: serie(d.prob_precipitacion),
    probTormenta: serie(d.prob_tormenta),
    nieve: serie(d.nieve),
    probNieve: serie(d.prob_nieve),
    temperatura: serie(d.temperatura),
    sensTermica: serie(d.sens_termica),
    humedadRelativa: serie(d.humedad_relativa),
    vientoAndRachaMax: vientoYRacha(d.viento, d.racha_max),
    fecha: fechaDia(d.fecha),
    orto: textoONulo(d.orto),
    ocaso: textoONulo(d.ocaso),
  }));
  return {
    origen: origen(root.origen, m.id, "horaria", m.slug),
    elaborado: String(root.elaborado ?? ""),
    nombre: m.nombre,
    provincia: PROVINCIA,
    prediccion: { dia: dias },
    id: m.id,
    version: String(root.version ?? "1.0"),
  };
}

/** Bloques de la diaria. Como en el endpoint por municipio: texto ausente = "", número ausente = null (nunca 0). */
function bloques(x: unknown, valor: (v: unknown) => Valor, conDescripcion = false) {
  return elementos(x).map((e) => {
    const out: { value: Valor; periodo?: string; descripcion?: string } = { value: valor(e.valor ?? e.value) };
    if (e.periodo != null) out.periodo = String(e.periodo);
    if (conDescripcion) out.descripcion = String(e.descripcion ?? "");
    return out;
  });
}
const textoOVacio = (v: unknown) => textoONulo(v) ?? "";

function extremos(x: unknown) {
  const e = esObjeto(x) ? x : {};
  return {
    maxima: numONulo(e.maxima),
    minima: numONulo(e.minima),
    dato: elementos(e.dato).map((d) => ({ value: numONulo(d.valor ?? d.value), hora: numONulo(d.hora) })),
  };
}

export function adaptarDiaria(root: Nodo, m: Pick<Municipio, "id" | "nombre" | "slug">) {
  const pred = esObjeto(root.prediccion) ? root.prediccion : {};
  const dias = elementos(pred.dia).map((d) => {
    const dia: Record<string, unknown> = {
      probPrecipitacion: bloques(d.prob_precipitacion, numONulo),
      cotaNieveProv: bloques(d.cota_nieve_prov, textoOVacio),
      estadoCielo: bloques(d.estado_cielo, textoOVacio, true),
      viento: elementos(d.viento).map((e) => {
        const out: { direccion: string; velocidad: number | null; periodo?: string } = {
          direccion: textoOVacio(e.direccion),
          velocidad: numONulo(e.velocidad),
        };
        if (e.periodo != null) out.periodo = String(e.periodo);
        return out;
      }),
      // racha_max: null en los días sin bloques; el endpoint por municipio pone [{ value: "" }]
      rachaMax: d.racha_max == null ? [{ value: "" }] : bloques(d.racha_max, textoOVacio),
      temperatura: extremos(d.temperatura),
      sensTermica: extremos(d.sens_termica),
      humedadRelativa: extremos(d.humedad_relativa),
    };
    const uv = numONulo(d.uv_max);
    if (uv != null) dia.uvMax = uv;
    dia.fecha = fechaDia(d.fecha);
    return dia;
  });
  return {
    origen: origen(root.origen, m.id, "diaria", m.slug),
    elaborado: String(root.elaborado ?? ""),
    nombre: m.nombre,
    provincia: PROVINCIA,
    prediccion: { dia: dias },
    id: Number(m.id),
    version: numONulo(root.version) ?? 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Validación (formato por municipio)

type Prediccion = { elaborado?: string; prediccion?: { dia?: { fecha?: string; temperatura?: unknown }[] } };

/** null si es válida; si no, el motivo. */
export function validar(p: unknown, tipo: Tipo, ahora: Date): string | null {
  const x = p as Prediccion;
  const t = msElaborado(x?.elaborado);
  if (!Number.isFinite(t)) return "sin elaborado";
  if (t > ahora.getTime() + H) return `elaborado en el futuro (${x.elaborado})`;
  if (t < ahora.getTime() - 4 * 24 * H) return `elaborado demasiado antiguo (${x.elaborado})`;
  const dias = toArray(x.prediccion?.dia);
  if (dias.length < (tipo === "horaria" ? 2 : 5)) return `solo ${dias.length} días`;
  const fechas = dias.map((d) => Date.parse(String(d.fecha ?? "").slice(0, 10) + "T00:00:00Z"));
  if (fechas.some((f) => !Number.isFinite(f))) return "fecha no válida";
  for (let i = 1; i < fechas.length; i++) if (fechas[i] - fechas[i - 1] !== 24 * H) return "días no consecutivos";
  const primerDia = Date.parse(String(x.elaborado).slice(0, 10) + "T00:00:00Z");
  if (Math.abs(fechas[0] - primerDia) > 24 * H) return `el primer día (${dias[0].fecha}) no cuadra con elaborado`;
  if (tipo === "horaria") {
    const horas = dias.reduce((n, d) => n + toArray(d.temperatura as unknown[]).length, 0);
    if (horas < 24) return `solo ${horas} horas de temperatura`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// ATOM

type EstadoAemet = {
  actualizado?: string | null;
  elaborado?: string | null;
  modo?: "todos" | "municipio" | "cache";
  atom?: { etag: string | null; lastModified: string | null };
  publicado?: string | null;
  comprobado?: string | null;
  reintentoTodos?: string | null;
  reintentoMunicipios?: string | null;
  publicadoIntentado?: string | null;
  intentosPublicado?: number;
  peticiones?: number;
};

/** Hora de publicación más reciente del feed (<published> de las entradas; nunca <updated>). */
export function leerPublicado(xml: string): string | null {
  const fechas: number[] = [];
  for (const entrada of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const pub = /<published>([^<]+)<\/published>/.exec(entrada)?.[1] ?? /"[^"]*actualizaci[^"]*"\s*:\s*"([^"]+)"/i.exec(entrada)?.[1];
    const t = msIso(pub);
    if (Number.isFinite(t)) fechas.push(t);
  }
  return fechas.length ? new Date(Math.max(...fechas)).toISOString() : null;
}

// ---------------------------------------------------------------------------------------------
// Módulo

const ARCHIVO: Record<Tipo, (id: string) => string> = {
  horaria: (id) => `localidad_h_${id}.json`,
  diaria: (id) => `localidad_${id}.json`,
};

type Estado = Map<string, Record<Tipo, number>>; // ms del elaborado guardado por municipio y tipo (NaN si falta)

async function leerEstado(ctx: Ctx, municipios: Municipio[]): Promise<Estado> {
  const estado: Estado = new Map();
  for (const m of municipios) {
    const d = await leerDatosMunicipio(ctx.dirDatos, m.id);
    estado.set(m.id, {
      horaria: msElaborado((d.aemetHoraria as Prediccion | null)?.elaborado),
      diaria: msElaborado((d.aemetDiaria as Prediccion | null)?.elaborado),
    });
  }
  return estado;
}

const maxElaborado = (estado: Estado) =>
  Math.max(...[...estado.values()].flatMap((e) => [e.horaria, e.diaria]).filter(Number.isFinite), Number.NEGATIVE_INFINITY);

/** Municipios con alguna predicción ausente o anterior al objetivo, del más antiguo al más reciente. */
function rezagados(estado: Estado, objetivo: number): { id: string; tipos: Tipo[]; antiguedad: number }[] {
  const out: { id: string; tipos: Tipo[]; antiguedad: number }[] = [];
  for (const [id, e] of estado) {
    const tipos = (["horaria", "diaria"] as const).filter((t) => !Number.isFinite(e[t]) || e[t] < objetivo);
    if (tipos.length) out.push({ id, tipos: [...tipos], antiguedad: Math.min(...tipos.map((t) => (Number.isFinite(e[t]) ? e[t] : -1))) });
  }
  return out.sort((a, b) => a.antiguedad - b.antiguedad);
}

const elaboradoDe = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19) : null);

export const actualizar: Fuente = async (ctx) => {
  const ant: EstadoAemet = { ...(ctx.meta.fuentes?.aemet ?? {}) };
  const cliente = new ClienteAemet(ctx.aemetKey, ctx.log);
  const resultado = (r: Omit<ResultadoFuente, "fuente" | "peticionesAemet">): ResultadoFuente => ({
    fuente: "aemet",
    peticionesAemet: cliente.peticiones,
    ...r,
    metaFuente: { ...r.metaFuente, peticiones: cliente.peticiones },
  });
  try {
    return await actualizarAemet(ctx, ant, cliente, resultado);
  } catch (e) {
    return resultado({ ok: false, cambiado: false, nota: `error: ${mensajeError(e)}`, metaFuente: { ...ant, modo: "cache" } });
  }
};

async function actualizarAemet(
  ctx: Ctx,
  ant: EstadoAemet,
  cliente: ClienteAemet,
  resultado: (r: Omit<ResultadoFuente, "fuente" | "peticionesAemet">) => ResultadoFuente
): Promise<ResultadoFuente> {
  const ahora = ctx.ahora.getTime();
  const nuevo: EstadoAemet = {
    actualizado: ant.actualizado ?? null,
    elaborado: ant.elaborado ?? null,
    modo: "cache",
    atom: ant.atom ?? { etag: null, lastModified: null },
    publicado: ant.publicado ?? null,
    comprobado: ant.comprobado ?? null,
    reintentoTodos: ant.reintentoTodos ?? null,
    reintentoMunicipios: ant.reintentoMunicipios ?? null,
    publicadoIntentado: ant.publicadoIntentado ?? null,
    intentosPublicado: ant.intentosPublicado ?? 0,
  };
  if (!ctx.aemetKey) return resultado({ ok: false, cambiado: false, nota: "sin AEMET_API_KEY: se conserva lo que hubiera", metaFuente: nuevo });

  const municipios = await leerMunicipios(ctx);
  const porId = new Map(municipios.map((m) => [m.id, m]));
  const estado = await leerEstado(ctx, municipios);
  const notas: string[] = [];

  // 1. ATOM (sin clave, condicional)
  try {
    const cab: Record<string, string> = {};
    if (nuevo.atom?.etag) cab["If-None-Match"] = nuevo.atom.etag;
    if (nuevo.atom?.lastModified) cab["If-Modified-Since"] = nuevo.atom.lastModified;
    const r = await cliente.pedir(ATOM, { cabeceras: cab, aceptar: [304], intentos: 2, timeoutMs: 20_000, etiqueta: "ATOM" });
    nuevo.comprobado = ctx.ahora.toISOString();
    if (r.status === 304) {
      notas.push("ATOM 304");
    } else {
      const pub = leerPublicado(r.texto());
      if (pub && msIso(pub) <= ahora + 10 * 60_000) nuevo.publicado = pub;
      nuevo.atom = { etag: r.headers.get("etag"), lastModified: r.headers.get("last-modified") };
      notas.push(`ATOM 200 (publicado ${horaLegible(nuevo.publicado)})`);
    }
  } catch (e) {
    notas.push(`ATOM falló (${mensajeError(e)})`);
  }

  // 2. ¿Hace falta descargar?
  const publicadoMs = msIso(nuevo.publicado);
  const perseguirPublicado =
    Number.isFinite(publicadoMs) && !(nuevo.publicadoIntentado === nuevo.publicado && (nuevo.intentosPublicado ?? 0) >= MAX_INTENTOS_PUBLICADO);
  const objetivo = Math.max(maxElaborado(estado), perseguirPublicado ? publicadoMs : Number.NEGATIVE_INFINITY);
  const pendientes = rezagados(estado, objetivo);
  const caducado = !(ahora - msIso(nuevo.actualizado) <= MAX_EDAD_MS);
  if (!ctx.forzar && !pendientes.length && !caducado) {
    nuevo.elaborado = elaboradoDe(maxElaborado(estado));
    return resultado({ ok: true, cambiado: false, nota: [...notas, `edición ${nuevo.elaborado ?? "?"} vigente`].join("; "), metaFuente: nuevo });
  }
  const motivo = ctx.forzar ? "forzado" : pendientes.length ? `${pendientes.length} municipios por actualizar` : "datos de más de 6 h";
  notas.push(motivo);

  let escritos = 0;
  let descargaCompleta = false;

  // 3. horaria/todos y diaria/todos
  const nuevaSinIntentar = Number.isFinite(publicadoMs) && nuevo.publicado !== nuevo.publicadoIntentado;
  const frenadoTodos = !ctx.forzar && !nuevaSinIntentar && ahora < msIso(nuevo.reintentoTodos);
  let todosFallo = false;
  let tarAtrasado = false;
  if (frenadoTodos) {
    notas.push(`todos en pausa hasta ${horaLegible(nuevo.reintentoTodos)}`);
  } else {
    let elaboradoTar = Number.POSITIVE_INFINITY; // el más antiguo de los dos tar descargados
    let tiposOk = 0;
    for (const tipo of ["horaria", "diaria"] as const) {
      try {
        const t0 = Date.now();
        const r = await cliente.datos(`/prediccion/especifica/municipio/${tipo}/todos`, /octet-stream|gzip|x-tar/i, 180_000);
        if (r.bytes[0] !== 0x1f || r.bytes[1] !== 0x8b) throw new Error("los datos no son gzip");
        const quiero = new Set(municipios.map((m) => ARCHIVO[tipo](m.id)));
        const ficheros = await extraerTar(r.bytes, quiero);
        let validos = 0;
        const elaborados = new Map<number, number>();
        const motivos = new Map<string, number>();
        for (const m of municipios) {
          const buf = ficheros.get(ARCHIVO[tipo](m.id));
          if (!buf) {
            motivos.set("ausente", (motivos.get("ausente") ?? 0) + 1);
            continue;
          }
          let pred: ReturnType<typeof adaptarHoraria> | ReturnType<typeof adaptarDiaria>;
          try {
            const j = JSON.parse(buf.toString("utf8"));
            const root = esObjeto(j.root) ? j.root : j;
            pred = tipo === "horaria" ? adaptarHoraria(root, m) : adaptarDiaria(root, m);
          } catch (e) {
            motivos.set(`JSON: ${mensajeError(e)}`, (motivos.get(`JSON: ${mensajeError(e)}`) ?? 0) + 1);
            continue;
          }
          const fallo = validar(pred, tipo, ctx.ahora);
          if (fallo) {
            motivos.set(fallo, (motivos.get(fallo) ?? 0) + 1);
            continue;
          }
          validos++;
          const t = msElaborado(pred.elaborado);
          elaborados.set(t, (elaborados.get(t) ?? 0) + 1);
          const e = estado.get(m.id)!;
          if (!(t <= e[tipo])) {
            // más nueva que la guardada (o no había): se escribe
            await guardarDatosMunicipio(ctx.dirDatos, m.id, tipo === "horaria" ? { aemetHoraria: pred } : { aemetDiaria: pred });
            e[tipo] = t;
            escritos++;
          }
        }
        const moda = [...elaborados.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Number.NaN;
        const resumenMotivos = [...motivos.entries()].map(([k, n]) => `${n} ${k}`).join(", ");
        ctx.log(
          `  ${tipo}/todos: ${(r.bytes.length / 1e6).toFixed(2)} MB, ${validos}/${municipios.length} válidos, elaborado ${elaboradoDe(moda)}` +
            `${resumenMotivos ? ` (descartados: ${resumenMotivos})` : ""}, ${((Date.now() - t0) / 1000).toFixed(1)} s`
        );
        if (validos < municipios.length / 2) throw new Error(`solo ${validos} municipios válidos en ${tipo}/todos`);
        elaboradoTar = Math.min(elaboradoTar, moda);
        tiposOk++;
      } catch (e) {
        todosFallo = true;
        notas.push(`${tipo}/todos falló (${mensajeError(e)})`);
      }
    }
    descargaCompleta = tiposOk === 2;
    // Si el tar es anterior a la edición anunciada (aún no regenerado), se reintenta más tarde sin respaldo masivo
    tarAtrasado = tiposOk > 0 && perseguirPublicado && elaboradoTar < publicadoMs;
    if (todosFallo || tarAtrasado) {
      nuevo.reintentoTodos = new Date(ahora + REINTENTO_TODOS_MS).toISOString();
      if (tarAtrasado) notas.push(`el tar (${elaboradoDe(elaboradoTar)}) aún no trae la edición ${horaLegible(nuevo.publicado)}`);
    } else {
      nuevo.reintentoTodos = null;
    }
    if (Number.isFinite(publicadoMs)) {
      const alcanzado = tiposOk > 0 && elaboradoTar >= publicadoMs;
      nuevo.intentosPublicado = alcanzado ? 0 : nuevo.publicadoIntentado === nuevo.publicado ? (nuevo.intentosPublicado ?? 0) + 1 : 1;
      nuevo.publicadoIntentado = nuevo.publicado;
    }
    if (descargaCompleta) nuevo.modo = "todos";
  }

  // 4. Respaldo por municipio, lotes de ≤35, los más antiguos primero: para los que faltan en el tar o tienen
  // una edición anterior, y para todos si el tar falló. Si el tar llegó bien pero atrasado respecto al ATOM,
  // el objetivo es la edición del tar (se espera a que AEMET lo regenere en vez de pedir 206 veces).
  const objetivoRespaldo = tarAtrasado && !todosFallo ? maxElaborado(estado) : Math.max(objetivo, maxElaborado(estado));
  let faltan = rezagados(estado, objetivoRespaldo);
  const frenadoMunicipios = !ctx.forzar && ahora < msIso(nuevo.reintentoMunicipios);
  if (faltan.length && frenadoMunicipios) {
    notas.push(`respaldo por municipio en pausa hasta ${horaLegible(nuevo.reintentoMunicipios)}`);
  } else if (faltan.length) {
    const lote = faltan.slice(0, LOTE_MUNICIPIOS);
    let exitos = 0;
    let fallos = 0;
    let sinProgreso = false;
    let objetivoLote = objetivoRespaldo;
    ctx.log(`  respaldo por municipio: ${lote.length} de ${faltan.length} pendientes`);
    for (const f of lote) {
      const m = porId.get(f.id)!;
      const e = estado.get(f.id)!;
      for (const tipo of f.tipos) {
        if (Number.isFinite(e[tipo]) && e[tipo] >= objetivoLote) continue;
        try {
          const lista = await cliente.json<unknown>(`/prediccion/especifica/municipio/${tipo}/${m.id}`);
          const pred = toArray(lista as unknown[])[0] as Prediccion & Record<string, unknown>;
          const fallo = validar(pred, tipo, ctx.ahora);
          if (fallo) throw new Error(fallo);
          const t = msElaborado(pred.elaborado);
          if (!(t <= e[tipo])) {
            await guardarDatosMunicipio(ctx.dirDatos, m.id, tipo === "horaria" ? { aemetHoraria: pred } : { aemetDiaria: pred });
            e[tipo] = t;
            escritos++;
            exitos++;
            objetivoLote = Math.max(objetivoLote, t);
          } else if (Number.isFinite(e[tipo])) {
            // AEMET aún sirve la misma edición que ya tenemos: no merece la pena seguir con el lote
            sinProgreso = true;
            break;
          }
        } catch (err) {
          fallos++;
          ctx.log(`  fallo ${tipo} ${m.id} ${m.nombre}: ${mensajeError(err)}`);
        }
      }
      if (sinProgreso) break;
    }
    if (exitos > 0) nuevo.modo = descargaCompleta ? "todos" : "municipio";
    nuevo.reintentoMunicipios = exitos === 0 && (fallos > 0 || sinProgreso) ? new Date(ahora + REINTENTO_MUNICIPIOS_MS).toISOString() : null;
    faltan = rezagados(estado, objetivoLote);
    notas.push(`respaldo: ${exitos} predicciones nuevas, ${fallos} fallos${sinProgreso ? ", AEMET sin edición nueva" : ""}`);
  }

  if (escritos > 0 || descargaCompleta) nuevo.actualizado = ctx.ahora.toISOString();
  nuevo.elaborado = elaboradoDe(maxElaborado(estado));
  const sinDatos = [...estado.entries()].filter(([, e]) => !Number.isFinite(e.horaria) || !Number.isFinite(e.diaria)).length;
  if (faltan.length) notas.push(`${faltan.length} municipios siguen pendientes`);
  return resultado({
    ok: sinDatos === 0 && !todosFallo,
    cambiado: escritos > 0,
    nota: [...notas, `${escritos} predicciones escritas, edición ${nuevo.elaborado ?? "?"}`].join("; "),
    metaFuente: nuevo,
  });
}
