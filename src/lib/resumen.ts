// Previsión de todos los municipios, calculada una vez por build y reutilizada por todas las páginas.
import { getDatosMunicipio, getMeta, getMunicipios, type Municipio } from "./datos";
import { construirPrevision, horaLocal, type Prevision } from "./tiempo";

export type Ficha = { municipio: Municipio; prevision: Prevision };

let cache: Ficha[] | null = null;

export function fichas(): Ficha[] {
  if (cache) return cache;
  const ahora = horaLocal();
  cache = getMunicipios().map((municipio) => ({
    municipio,
    prevision: construirPrevision(getDatosMunicipio(municipio.id), ahora),
  }));
  return cache;
}

export function sinAemet(id: string) {
  return getMeta().fallosAemet.includes(id);
}

const distancia = (a: Municipio, b: Municipio) => {
  const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(x, b.lat - a.lat) * 111.32; // km aproximados
};

export function cercanos(m: Municipio, n = 8) {
  return fichas()
    .filter((f) => f.municipio.id !== m.id)
    .map((f) => ({ ...f, km: distancia(m, f.municipio) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, n);
}
