// Lectura de los JSON generados por scripts/fetch-weather.ts. Solo se ejecuta en el build.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve("src/data");

export type Municipio = { id: string; nombre: string; slug: string; lat: number; lon: number; altitud: number };
export type Meta = { updatedAt: string; fallosAemet: string[] };

// Formas mínimas de las respuestas que usamos. AEMET mezcla números y cadenas, por eso los valores son string | number.
type Valor = string | number;
export type AemetPeriodo = { value?: Valor; periodo?: string; descripcion?: string };
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
  return leer<Meta>("meta.json", { updatedAt: "", fallosAemet: [] });
}

export function getMunicipios(): Municipio[] {
  const lista = leer<Municipio[]>("municipios.json", []);
  if (!lista.length) throw new Error("No hay src/data/municipios.json. Ejecuta antes `npm run fetch:data`.");
  return lista;
}

export function getDatosMunicipio(id: string): DatosMunicipio {
  return leer<DatosMunicipio>(`municipios/${id}.json`, { aemetDiaria: null, aemetHoraria: null, openMeteo: null });
}
