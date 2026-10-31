// Geometría de los términos municipales y de las zonas de predicción.
// Se usa en el build (endpoint /zonas/{slug}.json) y en scripts/generar-zonas.ts.
// Coordenadas siempre en [lon, lat] (orden GeoJSON).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Delaunay } from "d3-delaunay";
import polygonClipping from "polygon-clipping";

export type Par = [number, number];
export type Anillo = Par[];
export type Poligono = Anillo[];
export type MultiPoligono = Poligono[];

export type GeoMultiPolygon = { type: "MultiPolygon"; coordinates: MultiPoligono };
export type FeatureCelda = { type: "Feature"; properties: { id: string }; geometry: GeoMultiPolygon };
export type ColeccionCeldas = { type: "FeatureCollection"; features: FeatureCelda[] };
export type PuntoZona = { id: string; lat: number; lon: number };
export type Caja = [number, number, number, number]; // [lonMin, latMin, lonMax, latMax]

/** Partes del término por debajo de este tamaño se descartan (islotes y restos de la simplificación). */
export const AREA_MINIMA_HA = 5;
/** Todo lo que queda al sur de esta latitud es la isla de Alborán (término de Almería, 04013). */
export const LAT_ALBORAN = 36.5;
/** Margen en grados del rectángulo de la máscara alrededor del término. */
export const MARGEN_MASCARA = 3;

const M_POR_GRADO = 111_320;

/** Área aproximada de un anillo en hectáreas (proyección equirrectangular local). */
export function areaAnilloHa(anillo: Anillo): number {
  if (anillo.length < 4) return 0;
  let s = 0;
  let lat = 0;
  for (let i = 0; i < anillo.length - 1; i++) {
    const [x1, y1] = anillo[i];
    const [x2, y2] = anillo[i + 1];
    s += x1 * y2 - x2 * y1;
    lat += y1;
  }
  lat /= anillo.length - 1;
  const k = Math.cos((lat * Math.PI) / 180);
  return (Math.abs(s) / 2) * M_POR_GRADO * M_POR_GRADO * k / 10_000;
}

export function areaPoligonoHa(p: Poligono): number {
  if (!p.length) return 0;
  return Math.max(0, areaAnilloHa(p[0]) - p.slice(1).reduce((s, h) => s + areaAnilloHa(h), 0));
}

export function cajaMulti(mp: MultiPoligono): Caja {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of mp) for (const [x, y] of p[0] ?? []) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function enAnillo(x: number, y: number, anillo: Anillo): boolean {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i];
    const [xj, yj] = anillo[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** Punto en MultiPolygon, teniendo en cuenta los huecos. */
export function puntoEnMulti(lon: number, lat: number, mp: MultiPoligono): boolean {
  return mp.some((p) => p.length > 0 && enAnillo(lon, lat, p[0]) && !p.slice(1).some((h) => enAnillo(lon, lat, h)));
}

const r = (n: number, dec: number) => {
  const f = 10 ** dec;
  return Math.round(n * f) / f;
};

/** Redondea a `dec` decimales y elimina vértices repetidos y anillos degenerados. */
export function redondearMulti(mp: MultiPoligono, dec = 4): MultiPoligono {
  const salida: MultiPoligono = [];
  const limpiar = (anillo: Anillo): Anillo | null => {
    const limpio: Anillo = [];
    for (const [x, y] of anillo) {
      const q: Par = [r(x, dec), r(y, dec)];
      const u = limpio[limpio.length - 1];
      if (!u || u[0] !== q[0] || u[1] !== q[1]) limpio.push(q);
    }
    if (limpio.length > 1) {
      const [a, b] = [limpio[0], limpio[limpio.length - 1]];
      if (a[0] !== b[0] || a[1] !== b[1]) limpio.push([a[0], a[1]]);
    }
    return limpio.length >= 4 && areaAnilloHa(limpio) > 0 ? limpio : null;
  };
  for (const p of mp) {
    const exterior = p[0] ? limpiar(p[0]) : null;
    // Si el anillo exterior se ha degenerado, el polígono entero sobra
    if (!exterior) continue;
    const huecos = p.slice(1).map(limpiar).filter((h): h is Anillo => h !== null);
    salida.push([exterior, ...huecos]);
  }
  return salida;
}

/**
 * Término normalizado: unión de sus partes (corrige autointersecciones y solapes),
 * sin la isla de Alborán y sin partes de menos de AREA_MINIMA_HA.
 */
export function normalizarTermino(geom: Poligono | MultiPoligono): MultiPoligono {
  const unido = polygonClipping.union(geom as Poligono | MultiPoligono) as MultiPoligono;
  return unido.filter((p) => {
    const [, , , latMax] = cajaMulti([p]);
    return latMax >= LAT_ALBORAN && areaPoligonoHa(p) >= AREA_MINIMA_HA;
  });
}

type GeoJsonMunicipios = {
  features: { properties: { id: string }; geometry: { type: "Polygon"; coordinates: Poligono } | { type: "MultiPolygon"; coordinates: MultiPoligono } }[];
};

const cacheTerminos = new Map<string, Map<string, MultiPoligono>>();

/** Lee public/municipios.geojson y devuelve los términos normalizados por código INE (resultado en caché). */
export function leerTerminos(ruta = path.resolve("public/municipios.geojson")): Map<string, MultiPoligono> {
  const hecho = cacheTerminos.get(ruta);
  if (hecho) return hecho;
  const mapa = new Map<string, MultiPoligono>();
  if (existsSync(ruta)) {
    const gj = JSON.parse(readFileSync(ruta, "utf8")) as GeoJsonMunicipios;
    for (const f of gj.features) {
      try {
        const coords = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        const t = normalizarTermino(coords);
        if (t.length) mapa.set(f.properties.id, t);
      } catch {
        // Un polígono defectuoso no rompe el build: ese municipio se queda sin vista por zonas
      }
    }
  }
  cacheTerminos.set(ruta, mapa);
  return mapa;
}

export function terminoMunicipio(id: string, ruta?: string): MultiPoligono | null {
  return leerTerminos(ruta).get(id) ?? null;
}

/** Rectángulo amplio alrededor del término menos el propio término (oscurece todo lo de fuera). */
export function mascara(termino: MultiPoligono, margen = MARGEN_MASCARA): MultiPoligono {
  const [x0, y0, x1, y1] = cajaMulti(termino);
  const rect: Poligono = [[
    [r(x0 - margen, 2), r(y0 - margen, 2)],
    [r(x1 + margen, 2), r(y0 - margen, 2)],
    [r(x1 + margen, 2), r(y1 + margen, 2)],
    [r(x0 - margen, 2), r(y1 + margen, 2)],
    [r(x0 - margen, 2), r(y0 - margen, 2)],
  ]];
  return polygonClipping.difference(rect, termino) as MultiPoligono;
}

/** Factor de escala de la longitud (cos de la latitud media del término) para trabajar en distancias reales. */
export function escalaLon(termino: MultiPoligono): number {
  const [, y0, , y1] = cajaMulti(termino);
  return Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
}

/** Índice del punto más cercano (equivale a la celda de Voronoi sin recortar que contiene el punto). */
export function indiceMasCercano(lon: number, lat: number, puntos: { lat: number; lon: number }[], k: number): number {
  let mejor = -1;
  let dMin = Infinity;
  puntos.forEach((p, i) => {
    const d = ((p.lon - lon) * k) ** 2 + (p.lat - lat) ** 2;
    if (d < dMin) {
      dMin = d;
      mejor = i;
    }
  });
  return mejor;
}

/**
 * Celdas de Voronoi de los puntos de zona, calculadas con la longitud escalada por cos(lat)
 * y recortadas por el término normalizado. Las celdas que quedan vacías se omiten.
 */
export function celdasVoronoi(termino: MultiPoligono, puntos: PuntoZona[], dec = 4): ColeccionCeldas {
  const features: FeatureCelda[] = [];
  const feature = (id: string, mp: MultiPoligono) => {
    const geo = redondearMulti(mp, dec);
    if (geo.length) features.push({ type: "Feature", properties: { id }, geometry: { type: "MultiPolygon", coordinates: geo } });
  };
  if (!puntos.length || !termino.length) return { type: "FeatureCollection", features };
  if (puntos.length === 1) {
    feature(puntos[0].id, termino);
    return { type: "FeatureCollection", features };
  }
  const k = escalaLon(termino);
  let [x0, y0, x1, y1] = cajaMulti(termino);
  for (const p of puntos) {
    x0 = Math.min(x0, p.lon);
    x1 = Math.max(x1, p.lon);
    y0 = Math.min(y0, p.lat);
    y1 = Math.max(y1, p.lat);
  }
  const m = 0.01;
  const voronoi = Delaunay.from(
    puntos,
    (p) => p.lon * k,
    (p) => p.lat
  ).voronoi([(x0 - m) * k, y0 - m, (x1 + m) * k, y1 + m]);
  puntos.forEach((p, i) => {
    const celda = voronoi.cellPolygon(i);
    if (!celda) return;
    const anillo: Anillo = celda.map(([x, y]) => [x / k, y] as Par);
    try {
      const recorte = polygonClipping.intersection([anillo], termino) as MultiPoligono;
      if (recorte.length) feature(p.id, recorte);
    } catch {
      // Recorte imposible (geometría degenerada): la zona se queda sin celda en el mapa
    }
  });
  return { type: "FeatureCollection", features };
}

export const geoMulti = (mp: MultiPoligono, dec = 4): GeoMultiPolygon => ({ type: "MultiPolygon", coordinates: redondearMulti(mp, dec) });
