// Iconos del estado del cielo con el trazo de la maqueta (sol en almagra, luna y nubes en ceniza, lluvia en mar).
// Los colores salen de variables CSS (--ic-*) definidas en global.css; dentro de .sobre-oscuro, .banda-oscura
// o .panel-oscuro cambian solos a la versión para fondo de basalto.
import type { Cielo } from "../lib/tiempo";

const NUBE = "M-9 6h17a5 5 0 0 0 0-10a7 7 0 0 0-13-1a5 5 0 0 0-4 11z";
const RAYOS = "M0-11v2M0 9v2M-11 0h2M9 0h2M-7.8-7.8l1.4 1.4M6.4 6.4l1.4 1.4M-7.8 7.8l1.4-1.4M6.4-6.4l1.4-1.4";
const LUNA = "M4 -8a8 8 0 1 0 4 12a6.5 6.5 0 0 1-4-12z";

function Sol({ escala = 1, x = 0, y = 0 }: { escala?: number; x?: number; y?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${escala})`} className="ic ic-sol">
      <circle r="6" />
      <path d={RAYOS} />
    </g>
  );
}

function Luna({ escala = 1, x = 0, y = 0 }: { escala?: number; x?: number; y?: number }) {
  return <path d={LUNA} transform={`translate(${x} ${y}) scale(${escala})`} className="ic ic-trazo" />;
}

function Nube({ densa = false, escala = 1, x = 0, y = 0 }: { densa?: boolean; escala?: number; x?: number; y?: number }) {
  return <path d={NUBE} transform={`translate(${x} ${y}) scale(${escala})`} className={`ic ${densa ? "ic-nube-densa" : "ic-nube"}`} />;
}

// Glifo centrado en (0, 0), de unos 26 × 26 unidades. Para usarlo dentro de otro <svg> (meteograma, mapas).
export function GlifoCielo({ cielo, noche = false }: { cielo: Cielo; noche?: boolean }) {
  switch (cielo) {
    case "despejado":
      return noche ? <Luna /> : <Sol />;
    case "poco-nuboso":
      return (
        <g>
          {noche ? <Luna escala={0.75} x={-3} y={-3} /> : <Sol escala={0.72} x={-4} y={-4} />}
          <Nube escala={0.78} x={3} y={4} />
        </g>
      );
    case "nuboso":
      return <Nube y={2} />;
    case "cubierto":
      return (
        <g>
          <Nube densa escala={0.8} x={-3} y={-2} />
          <Nube x={2} y={4} />
        </g>
      );
    case "niebla":
      return <path d="M-11-6h16M-8 0h19M-11 6h14M7 6h4" className="ic ic-trazo" />;
    case "lluvia":
      return (
        <g>
          <Nube y={-3} />
          <path d="M-5 7l-2 4M1 7l-2 4M7 7l-2 4" className="ic ic-agua" />
        </g>
      );
    case "nieve":
      return (
        <g>
          <Nube y={-3} />
          <g className="ic-copo">
            <circle cx="-6" cy="9" r="1.6" />
            <circle cx="0" cy="11" r="1.6" />
            <circle cx="6" cy="9" r="1.6" />
          </g>
        </g>
      );
    case "tormenta":
      return (
        <g>
          <Nube y={-3} />
          <path d="M2 0-3 7h3l-2 6 7-8h-3l2-5z" className="ic-rayo" />
        </g>
      );
    case "calima":
      return (
        <g>
          <circle r="6" cx="2" cy="-3" className="ic ic-sol" />
          <path d="M-11 2h15M-8 7h19M-11 12h12" className="ic ic-trazo" />
        </g>
      );
  }
}

type Props = { cielo: Cielo; noche?: boolean; size?: number; titulo?: string };

export default function IconoCielo({ cielo, noche = false, size = 26, titulo }: Props) {
  return (
    <svg
      className="icono-cielo"
      viewBox="-15 -15 30 30"
      width={size}
      height={size}
      focusable="false"
      role={titulo ? "img" : undefined}
      aria-label={titulo}
      aria-hidden={titulo ? undefined : true}
    >
      <GlifoCielo cielo={cielo} noche={noche} />
    </svg>
  );
}
