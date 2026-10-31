// scripts/fuentes/ocr-radar.ts
// Lectura de la hora del radar regional de AEMET (radar "am", Almería-Níjar).
// El GIF no trae Last-Modified, ETag ni metadatos: la hora de la observación solo aparece dibujada
// en la franja inferior, en UTC, con el formato "DD MMM AADDD HHMMSS" (día, mes, año + día juliano, hora).
// Ejemplo real: "28 OCT 26301 191000" = 28-10-2026 19:10:00 UTC.
// Se lee comparando cada glifo con plantillas exactas sacadas de imágenes reales (la fuente es de mapa
// de bits, sin suavizado, así que la comparación es píxel a píxel).

// ---------------------------------------------------------------------------------------------
// Decodificador GIF mínimo (primer fotograma, con o sin entrelazado)
// ---------------------------------------------------------------------------------------------

export type ImagenIndexada = { ancho: number; alto: number; pix: Uint8Array; paleta: Uint8Array };

const u16 = (b: Uint8Array, p: number) => b[p] | (b[p + 1] << 8);

export function esGif(b: Uint8Array): boolean {
  return b.length > 13 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
}

export function dimensionesGif(b: Uint8Array): { ancho: number; alto: number } | null {
  return esGif(b) ? { ancho: u16(b, 6), alto: u16(b, 8) } : null;
}

function lzw(datos: Uint8Array, minCodigo: number, total: number): Uint8Array {
  if (minCodigo < 2 || minCodigo > 11) throw new Error(`GIF: tamaño mínimo de código LZW inválido (${minCodigo})`);
  const out = new Uint8Array(total);
  const clear = 1 << minCodigo;
  const fin = clear + 1;
  const prefijo = new Int16Array(4096);
  const sufijo = new Uint8Array(4096);
  const primero = new Uint8Array(4096);
  const largo = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    prefijo[i] = -1;
    sufijo[i] = i;
    primero[i] = i;
    largo[i] = 1;
  }
  let tam = minCodigo + 1;
  let mascara = (1 << tam) - 1;
  let siguiente = fin + 1;
  let previo = -1;
  let bits = 0;
  let nbits = 0;
  let pos = 0;
  let o = 0;
  while (o < total) {
    while (nbits < tam) {
      if (pos >= datos.length) return out; // flujo truncado: se queda lo decodificado
      bits |= datos[pos++] << nbits;
      nbits += 8;
    }
    const codigo = bits & mascara;
    bits >>>= tam;
    nbits -= tam;
    if (codigo === clear) {
      tam = minCodigo + 1;
      mascara = (1 << tam) - 1;
      siguiente = fin + 1;
      previo = -1;
      continue;
    }
    if (codigo === fin) break;
    if (previo === -1) {
      if (codigo >= clear) throw new Error("GIF: primer código LZW inválido");
    } else if (codigo < siguiente) {
      if (siguiente < 4096) {
        prefijo[siguiente] = previo;
        sufijo[siguiente] = primero[codigo];
        primero[siguiente] = primero[previo];
        largo[siguiente] = largo[previo] + 1;
        siguiente++;
      }
    } else if (codigo === siguiente && siguiente < 4096) {
      prefijo[siguiente] = previo;
      sufijo[siguiente] = primero[previo];
      primero[siguiente] = primero[previo];
      largo[siguiente] = largo[previo] + 1;
      siguiente++;
    } else {
      throw new Error("GIF: código LZW fuera de tabla");
    }
    if (siguiente === 1 << tam && tam < 12) {
      tam++;
      mascara = (1 << tam) - 1;
    }
    const l = largo[codigo];
    let k = o + l - 1;
    let c = codigo;
    while (c !== -1) {
      if (k < total) out[k] = sufijo[c];
      k--;
      c = prefijo[c];
    }
    o += l;
    previo = codigo;
  }
  return out;
}

export function decodificarGif(b: Uint8Array): ImagenIndexada {
  if (!esGif(b)) throw new Error("No es un GIF");
  const ancho = u16(b, 6);
  const alto = u16(b, 8);
  const flags = b[10];
  let p = 13;
  let paletaGlobal: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 1 << ((flags & 7) + 1);
    paletaGlobal = b.subarray(p, p + 3 * n);
    p += 3 * n;
  }
  while (p < b.length) {
    const t = b[p];
    if (t === 0x21) {
      p += 2;
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p++;
      continue;
    }
    if (t !== 0x2c) break;
    const ix = u16(b, p + 1);
    const iy = u16(b, p + 3);
    const iw = u16(b, p + 5);
    const ih = u16(b, p + 7);
    const lf = b[p + 9];
    p += 10;
    let paleta = paletaGlobal;
    if (lf & 0x80) {
      const n = 1 << ((lf & 7) + 1);
      paleta = b.subarray(p, p + 3 * n);
      p += 3 * n;
    }
    if (!paleta) throw new Error("GIF sin paleta");
    const entrelazado = (lf & 0x40) !== 0;
    const minCodigo = b[p++];
    const trozos: Uint8Array[] = [];
    let total = 0;
    while (p < b.length && b[p] !== 0) {
      const t2 = b.subarray(p + 1, p + 1 + b[p]);
      trozos.push(t2);
      total += t2.length;
      p += b[p] + 1;
    }
    const datos = new Uint8Array(total);
    let q = 0;
    for (const t2 of trozos) {
      datos.set(t2, q);
      q += t2.length;
    }
    let pix = lzw(datos, minCodigo, iw * ih);
    if (entrelazado) {
      const orden = new Uint8Array(iw * ih);
      let fila = 0;
      for (const [inicio, paso] of [
        [0, 8],
        [4, 8],
        [2, 4],
        [1, 2],
      ]) {
        for (let y = inicio; y < ih; y += paso) {
          orden.set(pix.subarray(fila * iw, (fila + 1) * iw), y * iw);
          fila++;
        }
      }
      pix = orden;
    }
    const completo = new Uint8Array(ancho * alto);
    for (let y = 0; y < ih && y + iy < alto; y++) {
      const fila = pix.subarray(y * iw, y * iw + Math.min(iw, ancho - ix));
      completo.set(fila, (y + iy) * ancho + ix);
    }
    return { ancho, alto, pix: completo, paleta };
  }
  throw new Error("GIF sin imagen");
}

// ---------------------------------------------------------------------------------------------
// Segmentación de la franja de texto inferior
// ---------------------------------------------------------------------------------------------

const ALTO_LETRA = 8; // altura de la fuente de la franja (filas 519-526 en el GIF de 480x530)
const HUECO_PALABRA = 6; // columnas vacías que separan palabras (entre letras hay 2-4)
const X_MAX_TEXTO = 400; // a la derecha hay otra leyenda que se superpone

export type Glifo = { x: number; filas: string[] };
export type Token = { x: number; glifos: Glifo[] };

function rgb(img: ImagenIndexada, i: number): number {
  const c = img.pix[i] * 3;
  return (img.paleta[c] << 16) | (img.paleta[c + 1] << 8) | img.paleta[c + 2];
}

/** Localiza la franja de texto (8 filas) pegada al borde inferior y la trocea en palabras y glifos. */
export function trocearFranja(img: ImagenIndexada): { y0: number; tokens: Token[] } | null {
  const { ancho, alto } = img;
  const xMax = Math.min(ancho, X_MAX_TEXTO);
  // Fondo = color más frecuente de las 16 filas inferiores
  const cuenta = new Map<number, number>();
  for (let y = Math.max(0, alto - 16); y < alto; y++)
    for (let x = 0; x < xMax; x++) {
      const c = rgb(img, y * ancho + x);
      cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
    }
  const fondo = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (fondo === undefined) return null;
  // Color del texto = el más frecuente, distinto del fondo, en las 12 filas inferiores
  // (a la izquierda hay un "1" amarillo de otra fuente desplazado una fila: no es parte de la marca).
  const cuentaTinta = new Map<number, number>();
  for (let y = Math.max(0, alto - 12); y < alto; y++)
    for (let x = 0; x < xMax; x++) {
      const c = rgb(img, y * ancho + x);
      if (c !== fondo) cuentaTinta.set(c, (cuentaTinta.get(c) ?? 0) + 1);
    }
  const colorTexto = [...cuentaTinta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (colorTexto === undefined) return null;
  const tinta = (x: number, y: number) => rgb(img, y * ancho + x) === colorTexto;
  const filaConTinta = (y: number) => {
    for (let x = 0; x < xMax; x++) if (tinta(x, y)) return true;
    return false;
  };
  // Última racha de filas con tinta empezando desde abajo
  let y1 = alto - 1;
  while (y1 >= alto - 16 && !filaConTinta(y1)) y1--;
  if (y1 < alto - 16) return null;
  let y0 = y1;
  while (y0 - 1 >= 0 && filaConTinta(y0 - 1)) y0--;
  if (y1 - y0 + 1 !== ALTO_LETRA) return null;

  const tokens: Token[] = [];
  let actual: Glifo | null = null;
  let hueco = HUECO_PALABRA;
  for (let x = 0; x < xMax; x++) {
    let col = false;
    for (let y = y0; y <= y1; y++) if (tinta(x, y)) col = true;
    if (!col) {
      if (actual) actual = null;
      hueco++;
      continue;
    }
    if (!actual) {
      actual = { x, filas: Array.from({ length: ALTO_LETRA }, () => "") };
      if (hueco >= HUECO_PALABRA || !tokens.length) tokens.push({ x, glifos: [] });
      tokens[tokens.length - 1].glifos.push(actual);
    }
    for (let y = y0; y <= y1; y++) actual.filas[y - y0] += tinta(x, y) ? "#" : ".";
    hueco = 0;
  }
  return { y0, tokens };
}

// ---------------------------------------------------------------------------------------------
// Plantillas de dígitos (sacadas de imágenes reales del radar "am")
// ---------------------------------------------------------------------------------------------

// Cada glifo recortado a sus columnas con tinta, 8 filas. Origen: 6 imágenes reales del 28 y 29-10-2026
// (15:50, 16:10, 19:10, 19:30, 00:20 y 00:40 UTC). Los dígitos que aún no han salido en ninguna imagen
// real (de momento solo el 7) se resuelven por coherencia con la hora de descarga.
export const PLANTILLAS: Record<string, string[]> = {
  "0": [".#####.", "#.....#", "#.....#", "#..#..#", "#..#..#", "#.....#", "#.....#", ".#####."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  "2": [".#####.", "#.....#", "......#", ".....#.", "..###..", ".#.....", "#......", "#######"],
  "3": ["#######", ".....#.", "....#..", "...##..", ".....#.", "......#", "#.....#", ".#####."],
  "4": [".....#.", "....##.", "...#.#.", "..#..#.", ".#...#.", "#######", ".....#.", ".....#."],
  "5": ["#######", "#......", "#......", "######.", "......#", "......#", "#.....#", ".#####."],
  "6": ["..####.", ".#.....", "#......", "#.####.", "##....#", "#.....#", "#.....#", ".#####."],
  "8": ["..###..", ".#...#.", ".#...#.", "..###..", ".#...#.", "#.....#", "#.....#", ".#####."],
  "9": [".#####.", "#.....#", "#.....#", "#....##", ".####.#", "......#", ".....#.", ".####.."],
  C: ["..####.", ".#....#", "#......", "#......", "#......", "#......", ".#....#", "..####."],
  O: ["..###..", ".#...#.", "#.....#", "#.....#", "#.....#", "#.....#", ".#...#.", "..###.."],
  T: ["#######", "...#...", "...#...", "...#...", "...#...", "...#...", "...#...", "...#..."],
};

const CLAVE = (filas: string[]) => filas.join("/");

type Lector = { caracterDe: (g: Glifo) => string; sinPlantilla: string[] };

function crearLector(plantillas: Record<string, string[]>): Lector {
  const mapa = new Map(Object.entries(plantillas).map(([c, filas]) => [CLAVE(filas), c]));
  return {
    caracterDe: (g) => mapa.get(CLAVE(g.filas)) ?? "?",
    sinPlantilla: "0123456789".split("").filter((d) => !(d in plantillas)),
  };
}

// ---------------------------------------------------------------------------------------------
// Lectura de la hora
// ---------------------------------------------------------------------------------------------

export type LecturaHora = {
  /** Hora UTC de la imagen (ISO) o null si no se pudo leer de forma fiable */
  hora: string | null;
  /** Texto leído de la marca de tiempo, con "?" en los glifos desconocidos */
  texto: string;
  /** exacta: todos los glifos conocidos; coherencia: había glifos desconocidos y solo una hora de la ventana encaja */
  metodo: "exacta" | "coherencia" | null;
  /** La hora leída es anterior a la ventana de coherencia (imagen atrasada o radar congelado) */
  atrasada: boolean;
  motivo?: string;
  /** Glifos nuevos identificados por coherencia (para añadirlos a PLANTILLAS) */
  glifosNuevos: { caracter: string; filas: string[] }[];
};

export const VENTANA_MIN = 40; // la imagen tiene que ser de entre descarga − 40 min y descarga
const TOLERANCIA_FUTURO_MIN = 2; // margen por desajuste de reloj

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
const DIA_MS = 86_400_000;

function diaJuliano(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DIA_MS) + 1;
}

/** Marca de tiempo esperada para una hora UTC, por partes: [DD, AADDD, HHMMSS] */
function marcaEsperada(t: Date): [string, string, string] {
  return [
    pad(t.getUTCDate()),
    pad(t.getUTCFullYear() % 100) + pad(diaJuliano(t), 3),
    pad(t.getUTCHours()) + pad(t.getUTCMinutes()) + pad(t.getUTCSeconds()),
  ];
}

type Marca = { dd: Glifo[]; mes: Glifo[]; aaddd: Glifo[]; hhmmss: Glifo[] };

function buscarMarca(tokens: Token[], caracterDe: Lector["caracterDe"]): Marca | null {
  const esNum = (t: Token) => t.glifos.every((g) => /[0-9?]/.test(caracterDe(g)));
  for (let i = 0; i + 3 < tokens.length; i++) {
    const [a, b, c, d] = tokens.slice(i, i + 4);
    if (a.glifos.length !== 2 || b.glifos.length !== 3 || c.glifos.length !== 5 || d.glifos.length !== 6) continue;
    if (!esNum(a) || !esNum(c) || !esNum(d)) continue;
    if (b.glifos.some((g) => /[0-9]/.test(caracterDe(g)))) continue; // el mes son letras
    return { dd: a.glifos, mes: b.glifos, aaddd: c.glifos, hhmmss: d.glifos };
  }
  return null;
}

function interpretar(dd: string, aaddd: string, hhmmss: string, descarga: Date): Date | null {
  const aa = +aaddd.slice(0, 2);
  const ddd = +aaddd.slice(2);
  const [hh, mm, ss] = [+hhmmss.slice(0, 2), +hhmmss.slice(2, 4), +hhmmss.slice(4)];
  if (ddd < 1 || ddd > 366 || hh > 23 || mm > 59 || ss > 59) return null;
  const anioDescarga = descarga.getUTCFullYear();
  const anio = 2000 + aa;
  if (anio !== anioDescarga && anio !== anioDescarga - 1) return null;
  const t = new Date(Date.UTC(anio, 0, ddd, hh, mm, ss));
  if (t.getUTCFullYear() !== anio) return null; // día 366 en año no bisiesto
  if (t.getUTCDate() !== +dd) return null; // el día del mes tiene que cuadrar con el juliano
  return t;
}

export function leerHoraRadar(gif: Uint8Array, descarga: Date, plantillas: Record<string, string[]> = PLANTILLAS): LecturaHora {
  const { caracterDe, sinPlantilla } = crearLector(plantillas);
  const base: LecturaHora = { hora: null, texto: "", metodo: null, atrasada: false, glifosNuevos: [] };
  let img: ImagenIndexada;
  try {
    img = decodificarGif(gif);
  } catch (e) {
    return { ...base, motivo: `GIF ilegible: ${(e as Error).message}` };
  }
  const franja = trocearFranja(img);
  if (!franja) return { ...base, motivo: "no se encuentra la franja de texto inferior" };
  const marca = buscarMarca(franja.tokens, caracterDe);
  if (!marca) {
    const texto = franja.tokens.map((t) => t.glifos.map(caracterDe).join("")).join(" ");
    return { ...base, texto, motivo: "no se encuentra la marca DD MMM AADDD HHMMSS" };
  }
  const leer = (gs: Glifo[]) => gs.map(caracterDe).join("");
  const dd = leer(marca.dd);
  const aaddd = leer(marca.aaddd);
  const hhmmss = leer(marca.hhmmss);
  const texto = `${dd} ${leer(marca.mes)} ${aaddd} ${hhmmss}`;
  const desde = descarga.getTime() - VENTANA_MIN * 60_000;
  const hasta = descarga.getTime() + TOLERANCIA_FUTURO_MIN * 60_000;

  if (!/\?/.test(dd + aaddd + hhmmss)) {
    const t = interpretar(dd, aaddd, hhmmss, descarga);
    if (!t) return { ...base, texto, motivo: `marca incoherente: ${texto}` };
    if (t.getTime() > hasta) return { ...base, texto, motivo: `hora leída posterior a la descarga: ${texto}` };
    // Lectura exacta anterior a la ventana: la imagen es antigua (radar congelado o sin imágenes nuevas).
    // Se guarda con su hora real para que la página avise de que no es reciente.
    return { ...base, texto, hora: t.toISOString(), metodo: "exacta", atrasada: t.getTime() < desde };
  }

  // Hay glifos sin plantilla: se prueban todas las horas en punto de minuto de la ventana y se acepta
  // solo si encaja exactamente una (los glifos conocidos coinciden y los desconocidos son dígitos sin plantilla).
  const leidos = [marca.dd, marca.aaddd, marca.hhmmss].map((gs) => gs.map(caracterDe));
  const encajan: Date[] = [];
  for (let ms = Math.ceil(desde / 60_000) * 60_000; ms <= hasta; ms += 60_000) {
    const t = new Date(ms);
    const esperada = marcaEsperada(t);
    const ok = esperada.every((parte, i) =>
      parte.split("").every((ch, j) => (leidos[i][j] === "?" ? sinPlantilla.includes(ch) : leidos[i][j] === ch))
    );
    if (ok) encajan.push(t);
  }
  if (encajan.length !== 1) {
    return { ...base, texto, motivo: encajan.length ? `lectura ambigua (${encajan.length} horas posibles): ${texto}` : `ninguna hora de la ventana encaja con ${texto}` };
  }
  const t = encajan[0];
  const esperada = marcaEsperada(t).join("");
  const glifos = [...marca.dd, ...marca.aaddd, ...marca.hhmmss];
  const glifosNuevos = glifos
    .map((g, i) => ({ g, ch: esperada[i] }))
    .filter(({ g }) => caracterDe(g) === "?")
    .map(({ g, ch }) => ({ caracter: ch, filas: g.filas }));
  return { ...base, texto, hora: t.toISOString(), metodo: "coherencia", glifosNuevos };
}
