// Comarcas de Almería (mapa de comarcas de Andalucía, Orden de 14 de marzo de 2003, BOJA n.º 59) y comparativa de
// la previsión de sus municipios para hoy y mañana. Definiciones: scripts/comarcas-almeria.json (versionado).
// Datos: la previsión combinada de src/lib/resumen.ts. Solo se ejecuta en el build.
import { readFileSync } from "node:fs";
import path from "node:path";
import { getMunicipios, type Municipio } from "./datos";
import { fichas, sinAemet, type Ficha } from "./resumen";
import { horaLocal, type Cielo, type Dia } from "./tiempo";

export type Comarca = {
  slug: string; // "poniente-almeriense": /comarcas/{slug}/
  nombre: string; // nombre que se muestra
  nombreOficial: string; // nombre en la Orden de 2003 (la de la capital se llama solo "Almería")
  descripcion: string;
  municipios: string[]; // códigos INE de 5 dígitos
};
export type FuenteComarcas = { norma: string; boletin: string; url: string; notas: string[] };
export type ComarcasJson = { fuente: FuenteComarcas; comarcas: Comarca[] };

const RUTA = path.resolve("scripts/comarcas-almeria.json");

let cache: ComarcasJson | null = null;

function leer(): ComarcasJson {
  if (cache) return cache;
  const datos = JSON.parse(readFileSync(RUTA, "utf8")) as ComarcasJson;
  if (!Array.isArray(datos?.comarcas) || !datos.comarcas.length) throw new Error("scripts/comarcas-almeria.json no tiene comarcas");
  cache = datos;
  return datos;
}

/** Las 7 comarcas, en el orden del archivo (de poniente a levante y norte). */
export const getComarcas = (): Comarca[] => leer().comarcas;

/** Norma de la que salen las comarcas, para citarla en la página. */
export const fuenteComarcas = (): FuenteComarcas => leer().fuente;

export const getComarca = (slug: string): Comarca | undefined => getComarcas().find((c) => c.slug === slug);

/** Comarca de un municipio, por código INE ("04013") o por slug ("almeria"). */
export function comarcaDeMunicipio(idOSlug: string): Comarca | undefined {
  const id = /^\d{5}$/.test(idOSlug) ? idOSlug : getMunicipios().find((m) => m.slug === idOSlug)?.id;
  return id ? getComarcas().find((c) => c.municipios.includes(id)) : undefined;
}

const porNombre = (a: Municipio, b: Municipio) => a.nombre.localeCompare(b.nombre, "es");

/** Fichas (municipio + previsión) de una comarca, por orden alfabético. */
export function fichasDeComarca(comarca: Comarca | string, fs: Ficha[] = fichas()): Ficha[] {
  const c = typeof comarca === "string" ? getComarca(comarca) : comarca;
  if (!c) return [];
  const ids = new Set(c.municipios);
  return fs.filter((f) => ids.has(f.municipio.id)).sort((a, b) => porNombre(a.municipio, b.municipio));
}

/** Municipios de una comarca, por orden alfabético. */
export function municipiosDeComarca(comarca: Comarca | string): Municipio[] {
  const c = typeof comarca === "string" ? getComarca(comarca) : comarca;
  if (!c) return [];
  const ids = new Set(c.municipios);
  return getMunicipios().filter((m) => ids.has(m.id)).sort(porNombre);
}

// ---------------------------------------------------------------------------------------------
// Comparativa de hoy y mañana
// ---------------------------------------------------------------------------------------------

/** Lo que se compara de un día de un municipio (sale de `Dia` de src/lib/tiempo.ts). */
export type DiaComparado = {
  fecha: string; // "2026-10-31"
  min: number | null; // °C
  max: number | null; // °C
  prob: number | null; // % de probabilidad de precipitación (AEMET del día; si no, máximo horario de Open-Meteo)
  precip: number | null; // mm (Open-Meteo)
  racha: number | null; // km/h, racha máxima (Open-Meteo)
  tormenta: number | null; // % máximo de probabilidad de tormenta de AEMET (null sin AEMET)
  cielo: Cielo;
  cieloTxt: string;
};

export type FilaComparativa = {
  municipio: Municipio;
  aemet: boolean; // false: el municipio solo tiene Open-Meteo (se indica en la página)
  hoy: DiaComparado | null;
  manana: DiaComparado | null;
};

/** Valor extremo con el municipio donde se da. */
export type Extremo = { valor: number; municipio: Pick<Municipio, "id" | "nombre" | "slug"> };

export type ResumenDia = {
  fecha: string;
  municipios: number; // municipios con dato ese día
  minMasBaja: Extremo | null; // la mínima más baja de la comarca
  minMasAlta: Extremo | null;
  maxMasBaja: Extremo | null;
  maxMasAlta: Extremo | null; // la máxima más alta
  probMax: Extremo | null; // % de precipitación más alto
  precipMax: Extremo | null; // mm
  rachaMax: Extremo | null; // km/h
  tormentaMax: Extremo | null; // % AEMET
  conLluvia: number; // municipios con prob ≥ UMBRAL_PROB_LLUVIA o precip ≥ 0,1 mm
  conTormenta: number; // municipios con tormenta ≥ UMBRAL_TORMENTA
  cielo: Cielo | null; // cielo más frecuente entre los municipios (a igualdad, el más adverso)
  cieloTxt: string; // texto más repetido dentro de esa categoría de cielo
};

export type ComparativaComarca = {
  comarca: Comarca;
  hoy: string; // fecha local de hoy
  manana: string;
  filas: FilaComparativa[]; // por orden alfabético
  resumenHoy: ResumenDia | null;
  resumenManana: ResumenDia | null;
  sinAemet: number; // municipios de la comarca sin predicción AEMET
};

export const UMBRAL_PROB_LLUVIA = 40; // %
export const UMBRAL_TORMENTA = 20; // %

// A igualdad de municipios gana el cielo más adverso
const GRAVEDAD: Record<Cielo, number> = {
  despejado: 0,
  "poco-nuboso": 1,
  nuboso: 2,
  cubierto: 3,
  calima: 4,
  niebla: 5,
  lluvia: 6,
  nieve: 7,
  tormenta: 8,
};

const sumarDia = (fecha: string, n: number) => new Date(Date.parse(fecha + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

const aComparado = (d: Dia): DiaComparado => ({
  fecha: d.fecha,
  min: d.min,
  max: d.max,
  prob: d.prob,
  precip: d.precip,
  racha: d.racha,
  tormenta: d.tormentaMax,
  cielo: d.cielo,
  cieloTxt: d.cieloTxt,
});

const corto = (m: Municipio) => ({ id: m.id, nombre: m.nombre, slug: m.slug });

function extremo(filas: FilaComparativa[], dia: "hoy" | "manana", campo: keyof DiaComparado, mayor: boolean): Extremo | null {
  let mejor: Extremo | null = null;
  for (const f of filas) {
    const v = f[dia]?.[campo];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!mejor || (mayor ? v > mejor.valor : v < mejor.valor)) mejor = { valor: v, municipio: corto(f.municipio) };
  }
  return mejor;
}

function resumir(filas: FilaComparativa[], dia: "hoy" | "manana", fecha: string): ResumenDia | null {
  const dias = filas.map((f) => f[dia]).filter((d): d is DiaComparado => d != null);
  if (!dias.length) return null;
  const cuenta = new Map<Cielo, number>();
  for (const d of dias) cuenta.set(d.cielo, (cuenta.get(d.cielo) ?? 0) + 1);
  const [cielo] = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || GRAVEDAD[b[0]] - GRAVEDAD[a[0]])[0];
  return {
    fecha,
    municipios: dias.length,
    minMasBaja: extremo(filas, dia, "min", false),
    minMasAlta: extremo(filas, dia, "min", true),
    maxMasBaja: extremo(filas, dia, "max", false),
    maxMasAlta: extremo(filas, dia, "max", true),
    probMax: extremo(filas, dia, "prob", true),
    precipMax: extremo(filas, dia, "precip", true),
    rachaMax: extremo(filas, dia, "racha", true),
    tormentaMax: extremo(filas, dia, "tormenta", true),
    conLluvia: dias.filter((d) => (d.prob ?? 0) >= UMBRAL_PROB_LLUVIA || (d.precip ?? 0) >= 0.1).length,
    conTormenta: dias.filter((d) => (d.tormenta ?? 0) >= UMBRAL_TORMENTA).length,
    cielo,
    cieloTxt: textoMasFrecuente(dias.filter((d) => d.cielo === cielo).map((d) => d.cieloTxt)),
  };
}

/** Texto que más se repite (una categoría de cielo agrupa "Nuboso" e "Intervalos nubosos"); a igualdad, el primero. */
function textoMasFrecuente(textos: string[]): string {
  const n = new Map<string, number>();
  for (const t of textos) if (t) n.set(t, (n.get(t) ?? 0) + 1);
  let mejor = "";
  for (const [t, c] of n) if (c > (n.get(mejor) ?? 0)) mejor = t;
  return mejor;
}

/**
 * Tabla comparativa de una comarca para hoy y mañana (fechas locales de Madrid). Un municipio sin día de hoy o de
 * mañana en su previsión lleva null en esa columna; nunca se lanza por un municipio.
 */
export function comparativaComarca(comarca: Comarca | string, fs: Ficha[] = fichas(), ahora = horaLocal()): ComparativaComarca | null {
  const c = typeof comarca === "string" ? getComarca(comarca) : comarca;
  if (!c) return null;
  const hoy = ahora.slice(0, 10);
  const manana = sumarDia(hoy, 1);
  const filas: FilaComparativa[] = fichasDeComarca(c, fs).map(({ municipio, prevision }) => {
    const dia = (fecha: string) => {
      const d = prevision.dias.find((x) => x.fecha === fecha);
      return d ? aComparado(d) : null;
    };
    return { municipio, aemet: prevision.aemet && !sinAemet(municipio.id), hoy: dia(hoy), manana: dia(manana) };
  });
  return {
    comarca: c,
    hoy,
    manana,
    filas,
    resumenHoy: resumir(filas, "hoy", hoy),
    resumenManana: resumir(filas, "manana", manana),
    sinAemet: filas.filter((f) => !f.aemet).length,
  };
}

/** Comparativa de las 7 comarcas (para el resumen por comarcas de la portada). */
export function resumenComarcas(fs: Ficha[] = fichas(), ahora = horaLocal()): ComparativaComarca[] {
  return getComarcas()
    .map((c) => comparativaComarca(c, fs, ahora))
    .filter((x): x is ComparativaComarca => x != null);
}
