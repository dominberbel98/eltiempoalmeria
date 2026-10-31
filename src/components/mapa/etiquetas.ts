// Colocación de etiquetas de mapa ("San José 18,9°") sin que se pisen.
// Algoritmo voraz: las etiquetas van por orden de prioridad; cada una prueba a la derecha, a la izquierda, encima y
// debajo de su punto, primero completa y luego solo con el valor; si no cabe sin pisar otra etiqueta, otro punto o el
// borde del mapa, se oculta (el dato sigue en la tabla). Todo en píxeles del contenedor del mapa.

export type Lado = "der" | "izq" | "arriba" | "abajo";
export type ModoEtiqueta = "completa" | "corta" | "oculta";
export type Colocacion = { modo: ModoEtiqueta; lado: Lado };

export type EntradaEtiqueta = {
  id: string;
  x: number; // punto de la zona, en px del contenedor
  y: number;
  ancho: number; // etiqueta completa
  anchoCorto: number; // solo el valor
  alto: number;
  fija?: boolean; // la seleccionada: se coloca siempre (completa) aunque pise algo
};

export type Caja = { x0: number; y0: number; x1: number; y1: number };

/** Separación entre el punto y la etiqueta, en px. Tiene que coincidir con el CSS (.mz-et-*). */
export const SEPARACION = 8;
const MARGEN = 2;
const RADIO_PUNTO = 4;
const LADOS: Lado[] = ["der", "izq", "arriba", "abajo"];

export function cajaEtiqueta(x: number, y: number, w: number, h: number, lado: Lado): Caja {
  switch (lado) {
    case "der":
      return { x0: x + SEPARACION, y0: y - h / 2, x1: x + SEPARACION + w, y1: y + h / 2 };
    case "izq":
      return { x0: x - SEPARACION - w, y0: y - h / 2, x1: x - SEPARACION, y1: y + h / 2 };
    case "arriba":
      return { x0: x - w / 2, y0: y - SEPARACION - h, x1: x + w / 2, y1: y - SEPARACION };
    case "abajo":
      return { x0: x - w / 2, y0: y + SEPARACION, x1: x + w / 2, y1: y + SEPARACION + h };
  }
}

const pisa = (a: Caja, b: Caja) => a.x0 < b.x1 + MARGEN && b.x0 < a.x1 + MARGEN && a.y0 < b.y1 + MARGEN && b.y0 < a.y1 + MARGEN;
const dentro = (c: Caja, ancho: number, alto: number) => c.x0 >= 0 && c.y0 >= 0 && c.x1 <= ancho && c.y1 <= alto;

/**
 * Decide modo y lado de cada etiqueta. `entradas` en orden de prioridad (la primera se coloca antes).
 * `ancho` y `alto`: tamaño del contenedor del mapa en px. `obstaculos`: zonas que no se pueden tapar (controles de zoom…).
 */
export function colocarEtiquetas(entradas: EntradaEtiqueta[], ancho: number, alto: number, obstaculos: Caja[] = []): Map<string, Colocacion> {
  const salida = new Map<string, Colocacion>();
  const ocupadas: Caja[] = [...obstaculos];
  const puntos = entradas.map((e) => ({ id: e.id, caja: { x0: e.x - RADIO_PUNTO, y0: e.y - RADIO_PUNTO, x1: e.x + RADIO_PUNTO, y1: e.y + RADIO_PUNTO } }));
  const libre = (c: Caja, id: string) =>
    dentro(c, ancho, alto) && !ocupadas.some((o) => pisa(c, o)) && !puntos.some((p) => p.id !== id && pisa(c, p.caja));

  for (const e of entradas) {
    let hecha: Colocacion | null = null;
    for (const [modo, w] of [["completa", e.ancho], ["corta", e.anchoCorto]] as const) {
      for (const lado of LADOS) {
        const c = cajaEtiqueta(e.x, e.y, w, e.alto, lado);
        if (libre(c, e.id)) {
          ocupadas.push(c);
          hecha = { modo, lado };
          break;
        }
      }
      if (hecha) break;
    }
    if (!hecha && e.fija) {
      // La seleccionada siempre se ve: el primer lado que quepa en el mapa, aunque pise otras
      const lado = LADOS.find((l) => dentro(cajaEtiqueta(e.x, e.y, e.ancho, e.alto, l), ancho, alto)) ?? "der";
      ocupadas.push(cajaEtiqueta(e.x, e.y, e.ancho, e.alto, lado));
      hecha = { modo: "completa", lado };
    }
    salida.set(e.id, hecha ?? { modo: "oculta", lado: "der" });
  }
  return salida;
}

let lienzo: CanvasRenderingContext2D | null | undefined;

/** Ancho aproximado de un texto en px con la fuente indicada (formato CSS "700 14px 'Archivo Variable'"). */
export function medirTexto(texto: string, fuente: string): number {
  if (lienzo === undefined) lienzo = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!lienzo) return texto.length * 8;
  lienzo.font = fuente;
  return lienzo.measureText(texto).width;
}
