// Meteograma (isla React): temperatura, cielo, lluvia, tormenta de AEMET y viento hora a hora en un SVG accesible.
// Sirve igual para un municipio que para una zona: recibe las horas ya normalizadas (ver aMeteograma en lib/tiempo).
// En pantallas estrechas las columnas tienen ancho fijo y el gráfico se desplaza en horizontal; en anchas se ajusta
// al contenedor. El primer render (build) usa la medida de móvil, así que al hidratar en el móvil no cambia nada,
// y el alto es el mismo en todas las medidas (sin saltos de maquetación).
import { useEffect, useId, useRef, useState } from "react";
import { GlifoCielo } from "./IconoCielo";
import { diaConNumero, type HoraMeteograma } from "../lib/tiempo";

type Props = { horas: HoraMeteograma[]; titulo?: string };

// --- Medidas ---
const COL_MOVIL = 38; // px por hora en móvil (como la maqueta)
const ANCHO_MOVIL = 640; // por debajo, columnas fijas y desplazamiento horizontal
const RACHA_DESTACADA = 20; // km/h: la racha se escribe en almagra por encima de este valor

// Filas fijas (las de tormenta y viento se colocan debajo según haya o no fila de tormenta)
const Y = { dia: 15, hora: 40, icono: 66, tempArriba: 112, tempAbajo: 214, area: 236, lluviaTitulo: 258, prob: 276, base: 304 };
const ALTO_BARRA = 22;
const FLECHA = "M0 -11V11M-5 5L0 11L5 5"; // apunta hacia abajo: rotada `dir` grados señala hacia donde sopla

// `ajustado`: el gráfico cabe entero en el contenedor (si no, se desplaza en horizontal)
function medidas(ancho: number | null, n: number): { col: number; paso: number; ajustado: boolean } {
  if (ancho == null || ancho < ANCHO_MOVIL) return { col: COL_MOVIL, paso: 1, ajustado: ancho != null && n * COL_MOVIL <= ancho };
  const ajuste = Math.floor((ancho / n) * 100) / 100;
  if (ajuste >= 40) return { col: ajuste, paso: 1, ajustado: true };
  if (ajuste >= 22) return { col: ajuste, paso: 2, ajustado: true }; // 48 h en escritorio: rótulos cada 2 horas
  return { col: 44, paso: 1, ajustado: false };
}

// --- Texto accesible ---
const RUMBOS = ["norte", "nordeste", "este", "sureste", "sur", "suroeste", "oeste", "noroeste"];
const rumboLargo = (g: number) => RUMBOS[Math.round((((g % 360) + 360) % 360) / 45) % 8];
const r = (n: number) => Math.round(n);
const mm = (n: number) => (n < 0.1 ? "menos de 0,1" : String(Math.round(n * 10) / 10).replace(".", ","));

type Campo = "temp" | "prob" | "precip" | "viento" | "racha" | "tormenta";

// Índice de la hora con el valor más alto (o más bajo) de un campo; -1 si no hay datos.
function extremo(horas: HoraMeteograma[], campo: Campo, menor = false): number {
  let mejor = -1;
  horas.forEach((h, i) => {
    const v = h[campo];
    if (v == null) return;
    const actual = mejor < 0 ? null : horas[mejor][campo];
    if (actual == null || (menor ? v < actual : v > actual)) mejor = i;
  });
  return mejor;
}

function resumen(horas: HoraMeteograma[]): string {
  const primerDia = horas[0].t.slice(0, 10);
  const cuando = (t: string) => {
    const hh = t.slice(11, 16);
    const dia = t.slice(0, 10) === primerDia ? "" : ` del ${diaConNumero(t).toLowerCase()}`;
    return `${hh.startsWith("01:") ? "a la" : "a las"} ${hh}${dia}`;
  };
  const partes: string[] = [];

  const conTemp = horas.filter((h) => h.temp != null);
  if (conTemp.length) {
    const ini = conTemp[0];
    const fin = conTemp[conTemp.length - 1];
    const max = horas[extremo(horas, "temp")];
    const min = horas[extremo(horas, "temp", true)];
    partes.push(
      `la temperatura irá de ${r(ini.temp!)} grados ${cuando(ini.t)} a ${r(fin.temp!)} grados ${cuando(fin.t)}, ` +
        `con una mínima de ${r(min.temp!)} grados ${cuando(min.t)} y una máxima de ${r(max.temp!)} grados ${cuando(max.t)}`
    );
  }

  const total = horas.reduce((s, h) => s + (h.precip ?? 0), 0);
  const iProb = extremo(horas, "prob");
  const pMax = iProb >= 0 ? horas[iProb].prob! : 0;
  const conProb = pMax > 0 ? `, con una probabilidad de hasta el ${r(pMax)} % ${cuando(horas[iProb].t)}` : "";
  if (total >= 0.1) partes.push(`lluvia de ${mm(total)} milímetros en total, sobre todo ${cuando(horas[extremo(horas, "precip")].t)}${conProb}`);
  else if (pMax >= 10) partes.push(`sin lluvia apreciable${conProb}`);
  else partes.push("sin lluvia prevista");

  const iViento = extremo(horas, "viento");
  if (iViento >= 0) {
    const h = horas[iViento];
    const iRacha = extremo(horas, "racha");
    partes.push(
      `viento de hasta ${r(h.viento!)} kilómetros por hora${h.dir != null ? ` del ${rumboLargo(h.dir)}` : ""} ${cuando(h.t)}` +
        (iRacha >= 0 ? `, con rachas de hasta ${r(horas[iRacha].racha!)} kilómetros por hora ${cuando(horas[iRacha].t)}` : "")
    );
  }

  const iTormenta = extremo(horas, "tormenta");
  if (iTormenta >= 0) {
    const tMax = horas[iTormenta].tormenta!;
    partes.push(
      tMax > 0
        ? `probabilidad de tormenta según AEMET de hasta el ${r(tMax)} % a partir de ${cuando(horas[iTormenta].t).replace(/^a /, "")}`
        : "AEMET no prevé tormentas"
    );
  }

  return `Meteograma de las próximas ${horas.length} horas: ${partes.join("; ")}.`;
}

// --- Geometría ---
// Color de la flecha según la racha (o el viento medio si no hay racha), en la rampa de almagra
function nivelViento(h: HoraMeteograma): 1 | 2 | 3 | 4 {
  const f = h.racha ?? (h.viento != null ? h.viento * 1.5 : null);
  if (f == null || f < 12) return 1;
  return f <= RACHA_DESTACADA ? 2 : f < 30 ? 3 : 4;
}

// Barra de lluvia: escala de raíz para que 0,2 mm se vea y 8 mm o más llenen la fila
const alturaLluvia = (v: number | null) => (v != null && v >= 0.05 ? Math.max(2, ALTO_BARRA * Math.min(1, Math.sqrt(v / 8))) : 0);

type Tramo = { i0: number; i1: number };
function tramos(horas: HoraMeteograma[], cumple: (h: HoraMeteograma) => boolean): Tramo[] {
  const lista: Tramo[] = [];
  horas.forEach((h, i) => {
    if (!cumple(h)) return;
    const ultimo = lista[lista.length - 1];
    if (ultimo && ultimo.i1 === i - 1) ultimo.i1 = i;
    else lista.push({ i0: i, i1: i });
  });
  return lista;
}

type PropsGrafico = { horas: HoraMeteograma[]; col: number; paso: number; ajustado: boolean; etiqueta: string };

function Grafico({ horas, col, paso, ajustado, etiqueta }: PropsGrafico) {
  const n = horas.length;
  const ancho = Math.round(n * col);
  const redondeo = (v: number) => Math.round(v * 10) / 10;
  const x = (i: number) => redondeo((i + 0.5) * col);
  const xRotulo = (i: number) => Math.min(Math.max(x(i), 16), ancho - 16); // que no se corte en los bordes
  const borde = (i: number) => redondeo(i * col);
  const muestra = (i: number) => i % paso === 0;

  // Tormenta: tramos seguidos con el mismo valor (cada bloque de AEMET son 6 h)
  const bloques: (Tramo & { v: number })[] = [];
  horas.forEach((h, i) => {
    if (h.tormenta == null) return;
    const ultimo = bloques[bloques.length - 1];
    if (ultimo && ultimo.i1 === i - 1 && ultimo.v === h.tormenta) ultimo.i1 = i;
    else bloques.push({ i0: i, i1: i, v: h.tormenta });
  });
  const hayDatoTormenta = bloques.length > 0;
  const hayTormenta = bloques.some((b) => b.v > 0);

  const yTormentaTitulo = Y.base + 22;
  const yTormenta = yTormentaTitulo + 8;
  const yVientoTitulo = (hayDatoTormenta ? yTormenta + 20 : Y.base) + 22;
  const yFlecha = yVientoTitulo + 28;
  const yVel = yFlecha + 32;
  const yRacha = yVel + 16;
  const yNoche = yRacha + 22;
  const alto = yNoche + 8;

  // Temperatura: rango mínimo de 8 °C para no exagerar variaciones pequeñas
  const temps = horas.map((h) => h.temp).filter((t): t is number => t != null);
  let [tMin, tMax] = temps.length ? [Math.min(...temps), Math.max(...temps)] : [0, 8];
  if (tMax - tMin < 8) [tMin, tMax] = [(tMin + tMax) / 2 - 4, (tMin + tMax) / 2 + 4];
  const yT = (t: number) => redondeo(Y.tempAbajo - ((t - tMin) / (tMax - tMin)) * (Y.tempAbajo - Y.tempArriba));
  const segmentos = tramos(horas, (h) => h.temp != null);
  const puntos = ({ i0, i1 }: Tramo) => horas.slice(i0, i1 + 1).map((h, k) => `${x(i0 + k)} ${yT(h.temp!)}`);
  const linea = segmentos.map((s) => "M" + puntos(s).join("L")).join("");
  const area = segmentos.map((s) => `M${x(s.i0)} ${Y.area}L${puntos(s).join("L")}L${x(s.i1)} ${Y.area}Z`).join("");

  // Rótulos de temperatura: cada 2 columnas visibles, más la máxima y la mínima sin pisarse
  const rotulos = new Set<number>();
  horas.forEach((h, i) => h.temp != null && i % (2 * paso) === 0 && rotulos.add(i));
  const separacion = Math.ceil(30 / col);
  const iMax = extremo(horas, "temp");
  const iMin = extremo(horas, "temp", true);
  for (const e of [iMax, iMin]) {
    if (e < 0) continue;
    if (e === iMin && iMax >= 0 && iMax !== iMin && Math.abs(iMax - iMin) < separacion) continue;
    for (const j of [...rotulos]) if (j !== e && j !== iMax && Math.abs(j - e) < separacion) rotulos.delete(j);
    rotulos.add(e);
  }

  // Días y medianoches
  const cortes = horas.flatMap((h, i) => (i > 0 && h.t.slice(11, 13) === "00" ? [i] : []));
  const inicios = [0, ...cortes];
  const dias = inicios.map((i0, k) => {
    const sitio = ((inicios[k + 1] ?? n) - i0) * col - 14;
    const largo = diaConNumero(horas[i0].t);
    const corto = diaConNumero(horas[i0].t, true);
    return { x: borde(i0) + (i0 === 0 ? 8 : 7), texto: largo.length * 8 <= sitio ? largo : corto.length * 8 <= sitio ? corto : null };
  });

  // Lluvia
  const probVisible = (h: HoraMeteograma, i: number) => h.prob != null && h.prob >= 10 && muestra(i);
  const sinLluvia = !horas.some((h) => (h.precip ?? 0) >= 0.1) && !horas.some(probVisible);
  const anchoBarra = Math.min(24, Math.round(col * 0.6));

  const noches = tramos(horas, (h) => h.noche);

  return (
    <svg className="mg-svg" width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label={etiqueta} focusable="false">
      {noches.map(({ i0, i1 }) => (
        <rect key={`n${i0}`} className="mg-noche" x={borde(i0)} y="0" width={redondeo(borde(i1 + 1) - borde(i0))} height={alto} />
      ))}
      {cortes.map((i) => (
        <line key={`c${i}`} className="mg-medianoche" x1={borde(i)} x2={borde(i)} y1="0" y2={alto} />
      ))}
      {dias.map(
        (d, k) =>
          d.texto && (
            <text key={`d${k}`} className="mg-dia" x={d.x} y={Y.dia}>
              {d.texto}
            </text>
          )
      )}

      <g className="mg-hora" textAnchor="middle">
        {horas.map(
          (h, i) =>
            muestra(i) && (
              <text key={i} x={x(i)} y={Y.hora}>
                {h.t.slice(11, 13)}
              </text>
            )
        )}
      </g>
      {horas.map(
        (h, i) =>
          muestra(i) && (
            <g key={`i${i}`} transform={`translate(${x(i)} ${Y.icono})`}>
              <GlifoCielo cielo={h.cielo} noche={h.noche} />
            </g>
          )
      )}

      {/* Temperatura */}
      <path className="mg-temp-area" d={area} />
      <path className="mg-temp-linea" d={linea} />
      <g className="mg-temp-txt" textAnchor="middle">
        {[...rotulos]
          .sort((a, b) => a - b)
          .map((i) => (
            <text key={i} x={xRotulo(i)} y={yT(horas[i].temp!) - 12}>
              {r(horas[i].temp!)}°
            </text>
          ))}
      </g>

      {/* Lluvia: barras = mm previstos; cifras = probabilidad */}
      <text className="mg-tit mg-tit-lluvia" x="8" y={Y.lluviaTitulo}>
        Lluvia en mm y probabilidad
      </text>
      <g className="mg-lluvia-txt" textAnchor="middle">
        {horas.map(
          (h, i) =>
            probVisible(h, i) && (
              <text key={i} x={x(i)} y={Y.prob}>
                {r(h.prob!)} %
              </text>
            )
        )}
      </g>
      {horas.map((h, i) => {
        const a = alturaLluvia(h.precip);
        return a > 0 && <rect key={`l${i}`} className="mg-lluvia" x={redondeo(x(i) - anchoBarra / 2)} y={redondeo(Y.base - a)} width={anchoBarra} height={redondeo(a)} />;
      })}
      {sinLluvia && (
        <text className="mg-vacio mg-vacio-lluvia" x={ajustado ? ancho / 2 : 8} y={Y.prob + 10} textAnchor={ajustado ? "middle" : "start"}>
          Sin lluvia prevista
        </text>
      )}
      <line className="mg-base" x1="0" x2={ancho} y1={Y.base} y2={Y.base} />

      {/* Tormenta de AEMET por bloques de 6 h */}
      {hayDatoTormenta && (
        <g>
          <text className="mg-tit" x="8" y={yTormentaTitulo}>
            Tormenta según AEMET, por bloques de 6 h
          </text>
          {hayTormenta ? (
            bloques.map((b) => {
              const x0 = borde(b.i0) + 1;
              const w = redondeo(borde(b.i1 + 1) - borde(b.i0) - 2);
              if (b.v <= 0) return <rect key={`t${b.i0}`} className="mg-tor-0" x={x0} y={yTormenta + 8} width={w} height="4" rx="2" />;
              const fuerte = b.v >= 40;
              return (
                <g key={`t${b.i0}`}>
                  <rect className={fuerte ? "mg-tor-2" : "mg-tor-1"} x={x0} y={yTormenta} width={w} height="20" rx="2" />
                  {w >= 34 && (
                    <text className={fuerte ? "mg-tor-txt-2" : "mg-tor-txt-1"} x={redondeo(x0 + w / 2)} y={yTormenta + 15} textAnchor="middle">
                      {r(b.v)} %
                    </text>
                  )}
                </g>
              );
            })
          ) : (
            <text
              className="mg-vacio"
              x={ajustado ? redondeo((borde(bloques[0].i0) + borde(bloques[bloques.length - 1].i1 + 1)) / 2) : borde(bloques[0].i0) + 8}
              y={yTormenta + 15}
              textAnchor={ajustado ? "middle" : "start"}
            >
              Sin tormentas previstas
            </text>
          )}
        </g>
      )}

      {/* Viento: flecha hacia donde sopla, velocidad media y racha destacada */}
      <text className="mg-tit" x="8" y={yVientoTitulo}>
        Viento y rachas, km/h
      </text>
      {horas.map(
        (h, i) =>
          muestra(i) &&
          h.dir != null && (
            <path key={`f${i}`} className={`mg-flecha mg-v${nivelViento(h)}`} d={FLECHA} transform={`translate(${x(i)} ${yFlecha}) rotate(${r(h.dir)})`} />
          )
      )}
      <g className="mg-vel" textAnchor="middle">
        {horas.map(
          (h, i) =>
            muestra(i) &&
            h.viento != null && (
              <text key={i} x={x(i)} y={yVel}>
                {r(h.viento)}
              </text>
            )
        )}
      </g>
      <g className="mg-racha" textAnchor="middle">
        {horas.map((_, i) => {
          if (!muestra(i)) return null;
          const grupo = horas.slice(i, i + paso).flatMap((h) => (h.racha != null ? [h.racha] : []));
          const racha = grupo.length ? Math.max(...grupo) : null;
          return racha != null && racha > RACHA_DESTACADA ? (
            <text key={i} x={x(i)} y={yRacha}>
              {r(racha)}
            </text>
          ) : null;
        })}
      </g>

      {noches.map(({ i0, i1 }) =>
        borde(i1 + 1) - borde(i0) >= 70 ? (
          <text key={`nt${i0}`} className="mg-txt" x={redondeo((borde(i0) + borde(i1 + 1)) / 2)} y={yNoche} textAnchor="middle">
            Noche
          </text>
        ) : null
      )}
    </svg>
  );
}

export default function Meteograma({ horas, titulo }: Props) {
  const idTitulo = useId();
  const caja = useRef<HTMLDivElement>(null);
  const [modo, setModo] = useState<24 | 48>(24);
  const [ancho, setAncho] = useState<number | null>(null);
  const [desborda, setDesborda] = useState<boolean | null>(null);

  const conMas = horas.length > 24;
  const vista = horas.slice(0, conMas ? modo : 24);
  const { col, paso, ajustado } = medidas(ancho, Math.max(1, vista.length));

  useEffect(() => {
    const el = caja.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const medir = () => setAncho(el.clientWidth);
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const el = caja.current;
    if (el) setDesborda(el.scrollWidth > el.clientWidth + 1);
  }, [ancho, col, vista.length]);

  const Raiz = titulo ? "section" : "div";
  const conTormenta = vista.some((h) => h.tormenta != null);
  const pista = desborda === false ? " mg-pista-oculta" : desborda ? " mg-pista-visible" : "";

  return (
    <Raiz className="mg" aria-labelledby={titulo ? idTitulo : undefined}>
      {(titulo || conMas) && (
        <div className="mg-cabecera">
          {titulo && (
            <h2 id={idTitulo} className="titular titular-2">
              {titulo}
            </h2>
          )}
          {conMas && (
            <div className="segmentado" role="group" aria-label="Horas a mostrar">
              {([24, 48] as const).map((m) => (
                <button key={m} type="button" aria-pressed={modo === m} onClick={() => setModo(m)}>
                  {m === 48 ? `${Math.min(48, horas.length)} horas` : "24 horas"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {vista.length ? (
        <>
          <p className={`mg-pista${pista}`}>Desliza el gráfico para ver todas las horas.</p>
          <figure className="mg-figura">
            {/* Contenedor desplazable: enfocable con teclado mientras haya algo que desplazar */}
            <div ref={caja} className="mg-scroll" tabIndex={desborda === false ? undefined : 0}>
              <Grafico horas={vista} col={col} paso={paso} ajustado={ajustado} etiqueta={resumen(vista)} />
            </div>
            <figcaption className="mg-pie">
              La línea es la temperatura. Las barras son la lluvia prevista, en milímetros, y la cifra de encima, su probabilidad. Las
              flechas señalan hacia dónde sopla el viento, con su velocidad debajo y la racha en rojo almagra cuando supera{" "}
              {RACHA_DESTACADA} km/h.
              {conTormenta ? " La fila de tormenta es la probabilidad que da AEMET para cada bloque de 6 horas." : ""} La franja
              sombreada es de noche.
            </figcaption>
          </figure>
        </>
      ) : (
        <p className="mg-sin-datos">No hay previsión horaria disponible.</p>
      )}
    </Raiz>
  );
}
