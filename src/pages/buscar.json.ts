// Índice del buscador: los 103 municipios y sus núcleos de población (IGN + INE, ≥10 habitantes).
// Lo carga Buscador.tsx al enfocar el campo de búsqueda.
//   n: nombre, m: slug del municipio, z: zona de la vista por zonas (null si no hay vista por zonas),
//   t: "municipio" | "nucleo", a: alias (entidad singular, urbanizaciones y barrios), p: [lat, lon] para la geolocalización,
//   c: codine del núcleo solo si en el mapa por zonas cae en la celda de otra zona (la vista por zonas lo marca).
import { readFileSync } from "node:fs";
import path from "node:path";
import { getMunicipios } from "../lib/datos";
import { indiceNucleos, nucleosDesplazados, tieneVistaZonas } from "../lib/zonas";

type Nucleo = {
  id: string;
  municipio: string;
  nombre: string;
  lat: number;
  lon: number;
  poblacion: number | null;
  capital: boolean;
  alias?: string[];
};

export type EntradaBusqueda = {
  n: string;
  m: string;
  z: string | null;
  t: "municipio" | "nucleo";
  a?: string[];
  p: [number, number];
  c?: string;
};

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function leerNucleos(): Nucleo[] {
  try {
    const lista = JSON.parse(readFileSync(path.resolve("scripts/nucleos-almeria.json"), "utf8"));
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

export function GET() {
  const municipios = getMunicipios();
  const porId = new Map(municipios.map((m) => [m.id, m]));
  const zonaDeNucleo = indiceNucleos();
  const nucleos = leerNucleos().filter((x) => porId.has(x.municipio));

  // El núcleo capital que se llama como el municipio no se repite: sus alias pasan a la entrada del municipio
  const aliasMunicipio = new Map<string, string[]>();
  const entradasNucleo: { e: EntradaBusqueda; poblacion: number }[] = [];
  for (const x of nucleos) {
    const m = porId.get(x.municipio)!;
    const alias = (x.alias ?? []).filter((a) => normalizar(a) !== normalizar(x.nombre));
    if (x.capital && normalizar(x.nombre) === normalizar(m.nombre)) {
      aliasMunicipio.set(m.id, [...(aliasMunicipio.get(m.id) ?? []), ...alias]);
      continue;
    }
    const z = tieneVistaZonas(m.id) ? (zonaDeNucleo.get(x.id) ?? null) : null;
    const desplazado = z != null && nucleosDesplazados(m.id).some((d) => d.id === x.id);
    entradasNucleo.push({
      e: { n: x.nombre, m: m.slug, z, t: "nucleo", ...(alias.length ? { a: alias } : {}), p: [r3(x.lat), r3(x.lon)], ...(desplazado ? { c: x.id } : {}) },
      poblacion: x.poblacion ?? 0,
    });
  }

  const entradas: EntradaBusqueda[] = [
    ...[...municipios]
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
      .map((m): EntradaBusqueda => {
        const a = [...new Set(aliasMunicipio.get(m.id) ?? [])];
        return { n: m.nombre, m: m.slug, z: null, t: "municipio", ...(a.length ? { a } : {}), p: [r3(m.lat), r3(m.lon)] };
      }),
    // Núcleos de más a menos habitantes: a igualdad de coincidencia, el buscador muestra antes los más poblados
    ...entradasNucleo.sort((a, b) => b.poblacion - a.poblacion).map((x) => x.e),
  ];

  return new Response(JSON.stringify(entradas), { headers: { "Content-Type": "application/json" } });
}
