// Open-Meteo para los 103 municipios: una sola petición con todas las coordenadas (peso 206), TTL 55 min.
// Variables sin cambios respecto a la versión anterior; se guardan en municipios/{id}.json (campo openMeteo).
import {
  guardarDatosMunicipio,
  leerDatosMunicipio,
  leerMunicipios,
  mensajeError,
  minutosDesde,
  pedirOpenMeteo,
  pesoOpenMeteo,
  toArray,
} from "./comun";
import type { Fuente } from "./tipos";

const TTL_MIN = 55;
const DIAS = 7;
const HORARIAS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
];
const DIARIAS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_gusts_10m_max",
  "uv_index_max",
  "sunrise",
  "sunset",
];

type Respuesta = { hourly?: { time?: unknown[] }; daily?: { time?: unknown[] } };

export const actualizar: Fuente = async (ctx) => {
  const ant = ctx.meta.fuentes?.openMeteo ?? {};
  const base = { fuente: "openMeteo" };
  let peso: number | undefined;
  try {
    const municipios = await leerMunicipios(ctx);
    const sinDatos: string[] = [];
    for (const m of municipios) if (!(await leerDatosMunicipio(ctx.dirDatos, m.id)).openMeteo) sinDatos.push(m.id);
    const edad = minutosDesde(ant.actualizado, ctx.ahora);
    if (!ctx.forzar && edad < TTL_MIN && !sinDatos.length) {
      return { ...base, ok: true, cambiado: false, nota: `vigente (${Math.round(edad)} min)`, metaFuente: ant };
    }

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", municipios.map((m) => m.lat).join(","));
    url.searchParams.set("longitude", municipios.map((m) => m.lon).join(","));
    url.searchParams.set("hourly", HORARIAS.join(","));
    url.searchParams.set("daily", DIARIAS.join(","));
    url.searchParams.set("timezone", "Europe/Madrid");
    url.searchParams.set("forecast_days", String(DIAS));
    url.searchParams.set("wind_speed_unit", "kmh");

    peso = 0; // a partir de aquí ya se ha pedido algo a Open-Meteo (aunque el 429 de cuota no gaste)
    const r = await pedirOpenMeteo(url.toString(), { log: ctx.log });
    peso = pesoOpenMeteo(municipios.length, HORARIAS.length + DIARIAS.length, 1, DIAS);
    const datos = toArray(JSON.parse(r.texto()) as Respuesta | Respuesta[]);
    if (datos.length !== municipios.length) throw new Error(`Open-Meteo devolvió ${datos.length} ubicaciones de ${municipios.length}`);
    const malos = datos.filter((d) => (d.hourly?.time?.length ?? 0) < 48 || (d.daily?.time?.length ?? 0) < DIAS).length;
    if (malos) throw new Error(`${malos} ubicaciones sin serie horaria o diaria completa`);

    for (const [i, m] of municipios.entries()) await guardarDatosMunicipio(ctx.dirDatos, m.id, { openMeteo: datos[i] });
    const actualizado = ctx.ahora.toISOString();
    return { ...base, ok: true, cambiado: true, pesoOpenMeteo: peso, nota: `${municipios.length} municipios`, metaFuente: { actualizado, peso } };
  } catch (e) {
    return { ...base, ok: false, cambiado: false, pesoOpenMeteo: peso, nota: `error: ${mensajeError(e)}; se conservan los datos anteriores`, metaFuente: ant };
  }
};
