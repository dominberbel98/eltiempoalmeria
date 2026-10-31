// Escalas de color de los mapas (zonas de un municipio y, si se quiere, el mapa provincial) y formato de cifras.
// Los colores repiten los tokens de global.css (temp-*, racha-*, lluvia-*, helada…) porque Leaflet los escribe como
// atributos fill/stroke del SVG, donde var() no funciona. Si cambian los tokens, hay que cambiarlos aquí también.
// Todas las escalas están pensadas para pintar sobre basalto: de oscuro (poco) a claro (mucho).

export const COLOR = {
  basalto: "#1E2A30",
  basalto2: "#263840",
  bordeOscuro: "#3E5058",
  lineaOscura: "#33454D",
  suaveOscuro: "#B9C6C4",
  cal: "#EEF1F0",
  almagra: "#B5472E",
  almagraOscuro: "#8E2F1E",
  almagraClaro: "#E89A62",
  helada: "#A9D2F2",
  sinDato: "#33454D",
} as const;

export const TEMP = ["#3F6E78", "#5E8C8F", "#8FAE9F", "#D3C9A6", "#D9A27E", "#C4694B"] as const;
export const RACHA = ["#3A4A50", "#5E5048", "#8A5340", "#B5472E", "#D0683F", "#E89A62"] as const;
export const LLUVIA = ["#34494F", "#24646A", "#1C8C8C", "#3AA7A3", "#74C3BD", "#B4E0DA"] as const;

export const UMBRAL_HELADA = 0; // °C: helada si la temperatura llega a 0 o menos
export const UMBRAL_CALOR = 35; // °C

export type Muestra = { color: string; etiqueta: string };

/**
 * Escala por tramos: 5 cortes ascendentes y 6 colores. El valor cae en el tramo i si cortes[i-1] ≤ v < cortes[i].
 * La leyenda pone el límite inferior de cada tramo ("<12", "12", "14"… "20 °C"), como la maqueta.
 * `especiales`: colores que mandan sobre el tramo (helada, calor), con su muestra para la leyenda.
 */
export type Escala = {
  unidad: string;
  color: (v: number | null | undefined) => string;
  muestras: Muestra[];
  especiales: Muestra[];
};

const num = (v: number, dec = 1) => v.toLocaleString("es-ES", { maximumFractionDigits: dec });

function porTramos(cortes: number[], colores: readonly string[], unidad: string, dec = 1): Pick<Escala, "color" | "muestras"> {
  const color = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return COLOR.sinDato;
    let i = 0;
    while (i < cortes.length && v >= cortes[i]) i++;
    return colores[i];
  };
  const muestras = colores.map((c, i) => ({
    color: c,
    etiqueta: i === 0 ? `<${num(cortes[0], dec)}` : `${num(cortes[i - 1], dec)}${i === colores.length - 1 ? ` ${unidad}` : ""}`,
  }));
  return { color, muestras };
}

const PASOS_TEMP = [1, 2, 3, 4, 5, 10];

/**
 * Temperatura con tramos adaptados a los valores que se van a pintar (mismo municipio, todos los días u horas),
 * para que se vean las diferencias dentro del término. Paso mínimo de 1 °C: diferencias menores salen del mismo color.
 * `helada`: los valores ≤0 °C se pintan en azul hielo. `calor`: los ≥35 °C, en almagra oscuro.
 */
export function escalaTemperatura(valores: (number | null | undefined)[], { helada = false, calor = false } = {}): Escala {
  const v = valores.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const lo0 = v.length ? Math.min(...v) : 10;
  const hi0 = v.length ? Math.max(...v) : 20;
  const paso = PASOS_TEMP.find((p) => 6 * p > hi0 - Math.floor(lo0 / p) * p) ?? 10;
  let inicio = Math.floor(lo0 / paso) * paso;
  // Centra los valores en la escala si sobran tramos
  const libres = Math.floor((6 * paso - (hi0 - inicio)) / paso) - 1;
  if (libres > 1) inicio -= Math.floor(libres / 2) * paso;
  const cortes = [1, 2, 3, 4, 5].map((k) => inicio + k * paso);
  const base = porTramos(cortes, TEMP, "°C", 0);
  const especiales: Muestra[] = [];
  const hayHelada = helada && v.some((x) => x <= UMBRAL_HELADA);
  const hayCalor = calor && v.some((x) => x >= UMBRAL_CALOR);
  if (hayHelada) especiales.push({ color: COLOR.helada, etiqueta: "Helada" });
  if (hayCalor) especiales.push({ color: COLOR.almagraOscuro, etiqueta: "35 °C o más" });
  return {
    unidad: "°C",
    especiales,
    muestras: base.muestras,
    color: (x) => {
      if (x != null && Number.isFinite(x)) {
        if (hayHelada && x <= UMBRAL_HELADA) return COLOR.helada;
        if (hayCalor && x >= UMBRAL_CALOR) return COLOR.almagraOscuro;
      }
      return base.color(x);
    },
  };
}

/** Rachas en km/h (cortes fijos: 20 km/h ya se nota, 70 km/h es temporal). */
export function escalaRachas(): Escala {
  return { unidad: "km/h", especiales: [], ...porTramos([20, 30, 40, 50, 70], RACHA, "km/h", 0) };
}

/** Lluvia acumulada en el día (mm) o en una hora (mm/h). Menos de 0,2 mm al día cuenta como nada. */
export function escalaLluvia(horaria = false): Escala {
  return horaria
    ? { unidad: "mm", especiales: [], ...porTramos([0.1, 0.5, 1, 3, 8], LLUVIA, "mm", 1) }
    : { unidad: "mm", especiales: [], ...porTramos([0.2, 1, 3, 10, 25], LLUVIA, "mm", 1) };
}

export type NivelTormenta = "no" | "posible" | "prevista";
export const COLOR_TORMENTA: Record<NivelTormenta, string> = { no: RACHA[0], posible: RACHA[3], prevista: RACHA[5] };
export const TEXTO_TORMENTA: Record<NivelTormenta, string> = { no: "No", posible: "Posible", prevista: "Prevista" };
export const ORDEN_TORMENTA: Record<NivelTormenta, number> = { no: 0, posible: 1, prevista: 2 };

/** Tormenta en una hora con los criterios de las zonas: código WMO ≥95, o CAPE ≥800 J/kg con probabilidad ≥30 %. */
export function tormentaHora(wc: number | null | undefined, cape: number | null | undefined, prob: number | null | undefined): NivelTormenta {
  if (wc != null && wc >= 95) return "prevista";
  if (cape != null && prob != null && cape >= 800 && prob >= 30) return "posible";
  return "no";
}

// ---------- Formato ----------

const MENOS = "−";
/** "11,4°", "−0,5°", "—" */
export function fmtGrados(v: number | null | undefined, dec = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  const s = Math.abs(r).toLocaleString("es-ES", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return `${r < 0 ? MENOS : ""}${s}°`;
}
/** "36 km/h" (o "36" sin unidad) */
export function fmtKmh(v: number | null | undefined, unidad = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v)}${unidad ? " km/h" : ""}`;
}
/** "0 mm", "0,4 mm", "12 mm" */
export function fmtLluvia(v: number | null | undefined, unidad = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v === 0 ? "0" : v < 0.1 ? "<0,1" : v >= 10 ? String(Math.round(v)) : v.toLocaleString("es-ES", { maximumFractionDigits: 1 });
  return `${s}${unidad ? " mm" : ""}`;
}
/** "1.000 m" (con punto de millar también en las cifras de 4 dígitos, como la maqueta) */
export const fmtAltitud = (m: number) => `${String(Math.round(m)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} m`;
