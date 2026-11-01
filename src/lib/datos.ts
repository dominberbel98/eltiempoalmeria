// Lectura de los JSON generados por scripts/fetch-weather.ts. Solo se ejecuta en el build.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve("src/data");

export type Municipio = { id: string; nombre: string; slug: string; lat: number; lon: number; altitud: number };
// Estado de cada fuente en meta.json (lo escribe scripts/fetch-weather.ts). Los módulos pueden añadir campos internos.
export type FuentesMeta = {
  aemet: { actualizado: string | null; elaborado: string | null /*UTC sin Z, tal cual AEMET*/; modo: "todos" | "municipio" | "cache"; atom: { etag: string | null; lastModified: string | null } };
  openMeteo: { actualizado: string | null; peso: number };
  zonas: { actualizado: string | null; pasada: string | null /*init ICON-EU ISO*/; peso: number };
  observaciones: { actualizado: string | null };
  radar: { actualizado: string | null; comprobado?: string | null; ultimaImagen?: string | null };
  ria: { actualizado: string | null; ultimoDia: string | null };
  // Avisos CAP: cuando no hay edición nueva el módulo solo renueva `rss` y se conservan los demás campos.
  avisos: {
    actualizado: string | null /*ISO UTC de la última descarga correcta*/;
    elaborado: string | null /*ISO UTC de elaboración del tar*/;
    origen?: "opendata" | "web";
    avisos?: number;
    rss?: { lastModified: string | null };
  };
  // Playas: `comprobado`, `reintento` y `fallidas` son internos del módulo.
  playas: {
    actualizado: string | null;
    elaborado: string | null /*edición más reciente, UTC sin Z*/;
    comprobado?: string | null;
    reintento?: string | null;
    fallidas?: Record<string, string>;
  };
  mar: { actualizado: string | null; peso: number; costera?: { elaborado: string | null /*UTC sin Z*/; comprobado: string | null } };
  calima: { actualizado: string | null; peso: number; pasadas?: { europa: string | null; global: string | null } };
};
export type Meta = { updatedAt: string; fallosAemet: string[]; fuentes: Partial<FuentesMeta> };

// Formas mínimas de las respuestas que usamos. AEMET mezcla números y cadenas, por eso los valores son string | number.
type Valor = string | number;
// En los datos adaptados del tar `todos`, un número ausente llega como null (no como el 0 falso de AEMET).
export type AemetPeriodo = { value?: Valor | null; periodo?: string; descripcion?: string };
export type AemetViento = { direccion?: string[]; velocidad?: Valor[]; value?: Valor | null; periodo?: string };
export type AemetDiaria = {
  elaborado?: string;
  prediccion?: {
    dia?: {
      fecha: string;
      probPrecipitacion?: AemetPeriodo[];
      estadoCielo?: AemetPeriodo[];
      temperatura?: { maxima?: Valor; minima?: Valor };
      uvMax?: Valor;
    }[];
  };
};
export type AemetHoraria = {
  elaborado?: string;
  prediccion?: {
    dia?: {
      fecha: string;
      orto?: string;
      ocaso?: string;
      estadoCielo?: AemetPeriodo[];
      precipitacion?: AemetPeriodo[];
      temperatura?: AemetPeriodo[];
      sensTermica?: AemetPeriodo[];
      humedadRelativa?: AemetPeriodo[];
      probPrecipitacion?: AemetPeriodo[];
      probTormenta?: AemetPeriodo[];
      probNieve?: AemetPeriodo[];
      nieve?: AemetPeriodo[];
      vientoAndRachaMax?: AemetViento[];
    }[];
  };
};
export type OpenMeteo = {
  hourly: {
    time: string[];
    temperature_2m: number[];
    apparent_temperature: number[];
    relative_humidity_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weather_code: number[];
    cloud_cover: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
    uv_index: number[];
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    precipitation_probability_max: number[];
    wind_gusts_10m_max: number[];
    uv_index_max: number[];
    sunrise: string[];
    sunset: string[];
  };
};
export type DatosMunicipio = {
  aemetDiaria: AemetDiaria | null;
  aemetHoraria: AemetHoraria | null;
  openMeteo: OpenMeteo | null;
};

function leer<T>(archivo: string, siFalta: T): T {
  const ruta = path.join(DIR, archivo);
  if (!existsSync(ruta)) return siFalta;
  try {
    return JSON.parse(readFileSync(ruta, "utf8")) as T;
  } catch {
    return siFalta;
  }
}

export function getMeta(): Meta {
  const m = leer<Partial<Meta>>("meta.json", {});
  return { updatedAt: m.updatedAt ?? "", fallosAemet: m.fallosAemet ?? [], fuentes: m.fuentes ?? {} };
}

export function getMunicipios(): Municipio[] {
  const lista = leer<Municipio[]>("municipios.json", []);
  if (!lista.length) throw new Error("No hay src/data/municipios.json. Ejecuta antes `npm run fetch:data`.");
  return lista;
}

export function getDatosMunicipio(id: string): DatosMunicipio {
  return leer<DatosMunicipio>(`municipios/${id}.json`, { aemetDiaria: null, aemetHoraria: null, openMeteo: null });
}
