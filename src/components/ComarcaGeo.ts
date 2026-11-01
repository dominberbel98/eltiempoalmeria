// Geometría para los mapas SVG generados en el build (comarcas y observaciones): proyección equirrectangular con la
// longitud escalada por cos(lat), trazados simplificados en coordenadas relativas y contornos de la provincia.
// Lee public/municipios.geojson (términos normalizados de src/lib/geozonas.ts) y public/provinces.geojson.
// Solo se ejecuta en el build.
import { readFileSync } from "node:fs";
import path from "node:path";
import polygonClipping from "polygon-clipping";
import { LAT_ALBORAN, cajaMulti, leerTerminos, type Caja, type MultiPoligono, type Poligono } from "../lib/geozonas";

export type Proyeccion = {
  ancho: number;
  alto: number;
  x: (lon: number) => number;
  y: (lat: number) => number;
  caja: Caja;
};

/** Proyección de una caja [lonMin, latMin, lonMax, latMax] a un lienzo de `ancho` unidades, con `margen` (fracción). */
export function proyectar(caja: Caja, ancho: number, margen = 0.04): Proyeccion {
  const [x0, y0, x1, y1] = caja;
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const mx = (x1 - x0) * margen;
  const my = (y1 - y0) * margen;
  const c: Caja = [x0 - mx, y0 - my, x1 + mx, y1 + my];
  const s = ancho / ((c[2] - c[0]) * k);
  return {
    ancho,
    alto: Math.round((c[3] - c[1]) * s),
    x: (lon) => (lon - c[0]) * k * s,
    y: (lat) => (c[3] - lat) * s,
    caja: c,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Trazado SVG de un multipolígono con coordenadas relativas y 1 decimal. Descarta los vértices a menos de `tol`
 * unidades del anterior y los anillos que se quedan en menos de 3 vértices.
 */
export function trazado(mp: MultiPoligono, p: Proyeccion, tol = 1.2): string {
  const partes: string[] = [];
  for (const poligono of mp)
    for (const anillo of poligono) {
      const pts: [number, number][] = [];
      for (const [lon, lat] of anillo) {
        const q: [number, number] = [r1(p.x(lon)), r1(p.y(lat))];
        const u = pts[pts.length - 1];
        if (!u || Math.hypot(q[0] - u[0], q[1] - u[1]) >= tol) pts.push(q);
      }
      if (pts.length > 1) {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        if (a[0] === b[0] && a[1] === b[1]) pts.pop();
      }
      if (pts.length < 3) continue;
      let d = `M${pts[0][0]} ${pts[0][1]}l`;
      for (let i = 1; i < pts.length; i++) d += `${i > 1 ? " " : ""}${r1(pts[i][0] - pts[i - 1][0])} ${r1(pts[i][1] - pts[i - 1][1])}`;
      partes.push(d + "z");
    }
  return partes.join("").replace(/ -/g, "-");
}

/** Caja de varios multipolígonos. */
export function cajaDe(mps: MultiPoligono[]): Caja {
  let c: Caja = [Infinity, Infinity, -Infinity, -Infinity];
  for (const mp of mps) {
    const [a, b, x, y] = cajaMulti(mp);
    c = [Math.min(c[0], a), Math.min(c[1], b), Math.max(c[2], x), Math.max(c[3], y)];
  }
  return c;
}

const corta = (a: Caja, b: Caja) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
/** ¿El multipolígono cae, aunque sea en parte, dentro de la caja? */
export const dentroDeCaja = (mp: MultiPoligono, caja: Caja) => corta(cajaMulti(mp), caja);

/** Términos municipales normalizados (por código INE), sin la isla de Alborán. */
export const terminos = (): Map<string, MultiPoligono> => leerTerminos();

const cacheUniones = new Map<string, MultiPoligono>();
/** Unión de los términos de una lista de municipios (contorno de una comarca). */
export function unionTerminos(ids: string[]): MultiPoligono {
  const clave = [...ids].sort().join(",");
  const hecho = cacheUniones.get(clave);
  if (hecho) return hecho;
  const t = terminos();
  const partes = ids.map((id) => t.get(id)).filter((x): x is MultiPoligono => x != null);
  let union: MultiPoligono = [];
  try {
    union = partes.length ? (polygonClipping.union(...(partes as [MultiPoligono, ...MultiPoligono[]])) as MultiPoligono) : [];
  } catch {
    union = partes.flat();
  }
  // Fuera los restos minúsculos que dejan los bordes que no casan del todo entre términos vecinos
  union = union.map((p) => [p[0], ...p.slice(1).filter((h) => h.length > 8)] as Poligono);
  cacheUniones.set(clave, union);
  return union;
}

type GeoProvincias = {
  features: { properties: { NAMEUNIT: string }; geometry: { type: "Polygon"; coordinates: Poligono } | { type: "MultiPolygon"; coordinates: MultiPoligono } }[];
};
let cacheProvincias: { almeria: MultiPoligono; vecinas: MultiPoligono[] } | null = null;

/** Contorno de la provincia de Almería (sin Alborán) y de las provincias vecinas, de public/provinces.geojson. */
export function provincias(): { almeria: MultiPoligono; vecinas: MultiPoligono[] } {
  if (cacheProvincias) return cacheProvincias;
  let almeria: MultiPoligono = [];
  const vecinas: MultiPoligono[] = [];
  try {
    const gj = JSON.parse(readFileSync(path.resolve("public/provinces.geojson"), "utf8")) as GeoProvincias;
    for (const f of gj.features) {
      const mp = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      if (f.properties.NAMEUNIT === "Almería") almeria = mp.filter((p) => cajaMulti([p])[3] >= LAT_ALBORAN);
      else vecinas.push(mp);
    }
  } catch {
    // Sin el archivo, los mapas se dibujan solo con los términos
  }
  cacheProvincias = { almeria, vecinas };
  return cacheProvincias;
}

/** Caja de la provincia (sin Alborán), de los términos si falta el contorno. */
export function cajaProvincia(): Caja {
  const { almeria } = provincias();
  return almeria.length ? cajaMulti(almeria) : cajaDe([...terminos().values()]);
}

/** Centro del polígono más grande (media de los vértices de su anillo exterior): sirve para colocar un rótulo. */
export function centro(mp: MultiPoligono): [number, number] {
  let mejor: Poligono | null = null;
  let area = -1;
  for (const p of mp) {
    const [a, b, c, d] = cajaMulti([p]);
    const s = (c - a) * (d - b);
    if (s > area) {
      area = s;
      mejor = p;
    }
  }
  const anillo = mejor?.[0] ?? [];
  if (!anillo.length) return [0, 0];
  const n = anillo.length;
  return [anillo.reduce((s, q) => s + q[0], 0) / n, anillo.reduce((s, q) => s + q[1], 0) / n];
}

/**
 * Coloca rótulos cerca de sus puntos sin que se monten: prueba a la derecha, a la izquierda, encima y debajo, y se
 * queda con la primera posición libre (o con la que menos se solapa).
 */
export type Rotulo = { x: number; y: number; ancho: number; alto: number };
export type RotuloColocado = { x: number; y: number; ancla: "start" | "end" | "middle" };
export function colocarRotulos(puntos: Rotulo[], lienzo: { ancho: number; alto: number }, sep = 10): RotuloColocado[] {
  const cajas: [number, number, number, number][] = puntos.map((p) => [p.x - 7, p.y - 7, p.x + 7, p.y + 7]);
  const solape = (a: [number, number, number, number], b: [number, number, number, number]) =>
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const salida: RotuloColocado[] = [];
  puntos.forEach((p, i) => {
    const opciones: { r: RotuloColocado; c: [number, number, number, number] }[] = [
      { r: { x: p.x + sep, y: p.y + p.alto * 0.35, ancla: "start" }, c: [p.x + sep, p.y - p.alto / 2, p.x + sep + p.ancho, p.y + p.alto / 2] },
      { r: { x: p.x - sep, y: p.y + p.alto * 0.35, ancla: "end" }, c: [p.x - sep - p.ancho, p.y - p.alto / 2, p.x - sep, p.y + p.alto / 2] },
      { r: { x: p.x, y: p.y - sep - 2, ancla: "middle" }, c: [p.x - p.ancho / 2, p.y - sep - p.alto, p.x + p.ancho / 2, p.y - sep] },
      { r: { x: p.x, y: p.y + sep + p.alto * 0.8, ancla: "middle" }, c: [p.x - p.ancho / 2, p.y + sep, p.x + p.ancho / 2, p.y + sep + p.alto] },
    ];
    let mejor = opciones[0];
    let menor = Infinity;
    for (const o of opciones) {
      const fuera = o.c[0] < 0 || o.c[1] < 0 || o.c[2] > lienzo.ancho || o.c[3] > lienzo.alto ? 1e6 : 0;
      const s = fuera + cajas.reduce((acc, c, j) => acc + (j === i ? 0 : solape(o.c, c)), 0);
      if (s < menor) {
        menor = s;
        mejor = o;
      }
      if (s === 0) break;
    }
    cajas.push(mejor.c);
    salida.push(mejor.r);
  });
  return salida;
}
