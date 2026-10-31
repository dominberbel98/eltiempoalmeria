// Utilidades de Leaflet para enseñar un solo término municipal: panes propios, máscara que oscurece el resto,
// contorno y encuadre limitado al término (fitBounds + maxBounds + minZoom). Las usan VistaZonas y el modo foco
// del mapa provincial. Leaflet se pasa como parámetro porque se importa en el cliente con import() dinámico.
import type * as Leaflet from "leaflet";
import type { MultiPolygon } from "geojson";
import { COLOR } from "./escalas";

export const PANES = {
  celdas: "mz-celdas", // celdas de Voronoi coloreadas (interactivas)
  mascara: "mz-mascara", // oscurece todo lo que no es el término; no captura el puntero
  contorno: "mz-contorno", // borde del término y borde de la celda elegida
  puntos: "mz-puntos", // punto de cada zona
} as const;

/** Crea los panes en orden (de abajo arriba). La máscara y lo que va encima no reciben eventos del puntero. */
export function crearPanes(mapa: Leaflet.Map): void {
  const orden: [string, number, boolean][] = [
    [PANES.celdas, 410, true],
    [PANES.mascara, 450, false],
    [PANES.contorno, 460, false],
    [PANES.puntos, 470, false],
  ];
  for (const [nombre, z, interactivo] of orden) {
    const pane = mapa.getPane(nombre) ?? mapa.createPane(nombre);
    pane.style.zIndex = String(z);
    if (!interactivo) pane.style.pointerEvents = "none";
  }
}

/** Máscara: rectángulo amplio menos el término (ya viene calculada del endpoint). */
export function capaMascara(L: typeof Leaflet, mascara: MultiPolygon, opacidad = 0.92): Leaflet.GeoJSON {
  return L.geoJSON(mascara, {
    pane: PANES.mascara,
    interactive: false,
    style: { stroke: false, fillColor: COLOR.basalto, fillOpacity: opacidad },
  });
}

/** Contorno del término sobre las celdas. */
export function capaContorno(L: typeof Leaflet, contorno: MultiPolygon): Leaflet.GeoJSON {
  return L.geoJSON(contorno, {
    pane: PANES.contorno,
    interactive: false,
    style: { color: COLOR.cal, weight: 1.5, opacity: 0.9, fill: false },
  });
}

/** Límites [[latMin, lonMin], [latMax, lonMax]] de un MultiPolygon GeoJSON ([lon, lat]). */
export function limites(L: typeof Leaflet, geom: MultiPolygon): Leaflet.LatLngBounds {
  let latMin = 90,
    latMax = -90,
    lonMin = 180,
    lonMax = -180;
  for (const poligono of geom.coordinates)
    for (const anillo of poligono)
      for (const [lon, lat] of anillo) {
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
        if (lon < lonMin) lonMin = lon;
        if (lon > lonMax) lonMax = lon;
      }
  return L.latLngBounds([latMin, lonMin], [latMax, lonMax]);
}

/**
 * Encuadra el mapa en el término y no deja salir de él: no se puede alejar más que el encuadre ni arrastrar
 * lejos. Se puede llamar de nuevo al cambiar el tamaño del contenedor.
 */
export function encuadrarTermino(mapa: Leaflet.Map, caja: Leaflet.LatLngBounds, margenPx = 12, acercamientoMax = 3): void {
  mapa.invalidateSize();
  mapa.setMaxBounds(undefined as unknown as Leaflet.LatLngBounds);
  mapa.setMinZoom(0);
  mapa.fitBounds(caja, { padding: [margenPx, margenPx], animate: false });
  const z = mapa.getZoom();
  mapa.setMinZoom(z);
  mapa.setMaxZoom(z + acercamientoMax);
  mapa.setMaxBounds(caja.pad(0.25));
}

/** El usuario prefiere menos movimiento: sin animaciones de zoom ni fundidos. */
export const menosMovimiento = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
