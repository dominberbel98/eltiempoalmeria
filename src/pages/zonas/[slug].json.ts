// Zonas de predicción de un municipio (/zonas/{slug}.json) para la isla VistaZonas.
// Se genera en el build con construirZonasEndpoint: contorno del término, máscara, celdas de Voronoi y,
// por zona, las horas con detalle de ICON-EU (hasta ultimaHoraDetalle, máx. 78) y el resumen de los días.
// Existe para los 103 municipios: los de una sola zona no tienen vista por zonas en su página,
// pero el modo foco del mapa provincial también enseña su término.
import type { APIRoute, GetStaticPaths } from "astro";
import { getMunicipios, type Municipio } from "../../lib/datos";
import { construirZonasEndpoint } from "../../lib/zonas";

export const getStaticPaths = (() => getMunicipios().map((m) => ({ params: { slug: m.slug }, props: { m } }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ m: Municipio }> = ({ props }) => {
  // null solo si el municipio no tiene zonas definidas o término en el GeoJSON (no debería pasar con los 103)
  const datos = construirZonasEndpoint(props.m);
  return new Response(JSON.stringify(datos), { headers: { "Content-Type": "application/json" } });
};
