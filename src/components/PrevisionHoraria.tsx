import { useState } from "react";
import { ChevronLeft, ChevronRight, Droplets } from "lucide-react";
import IconoCielo from "./IconoCielo";
import type { Hora } from "../lib/tiempo";

type Metrica = "temp" | "prob" | "viento";
const METRICAS: { clave: Metrica; etiqueta: string; unidad: string; sufijo: string }[] = [
  { clave: "temp", etiqueta: "Temperatura", unidad: "°C", sufijo: "°" },
  { clave: "prob", etiqueta: "Lluvia", unidad: "Probabilidad (%)", sufijo: "%" },
  { clave: "viento", etiqueta: "Viento", unidad: "km/h", sufijo: "" },
];
const VENTANA = 8;

const fmt = (n: number | null, s = "") => (n == null ? "—" : Math.round(n) + s);

function etiquetaDia(t: string, primera: string) {
  const dias = Math.round((Date.parse(t.slice(0, 10)) - Date.parse(primera.slice(0, 10))) / 86_400_000);
  if (dias === 0) return "Hoy";
  if (dias === 1) return "Mañana";
  return new Date(t.slice(0, 10) + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" });
}

export default function PrevisionHoraria({ horas, nombre }: { horas: Hora[]; nombre: string }) {
  const [metrica, setMetrica] = useState<Metrica>("temp");
  const [desde, setDesde] = useState(0);
  if (!horas.length) return <div className="empty-chart">No hay previsión horaria disponible.</div>;

  const m = METRICAS.find((x) => x.clave === metrica)!;
  const vistas = horas.slice(desde, desde + VENTANA);
  const valores = vistas.map((h) => h[metrica] ?? 0);
  const min = Math.min(...valores) - 2;
  const max = Math.max(...valores) + 2;
  const x = (i: number) => ((i + 0.5) * 700) / valores.length;
  const y = (v: number) => 105 - ((v - min) / (max - min || 1)) * 65;
  const puntos = valores.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const primera = horas[0].t;

  return (
    <>
      <div className="section-top">
        <div>
          <div className="eyebrow">PLANIFICA TU DÍA</div>
          <h2>
            Hora a hora <span>{etiquetaDia(vistas[0].t, primera)}</span>
          </h2>
        </div>
        <div className="segmented" role="group" aria-label="Variable de la gráfica">
          {METRICAS.map((x) => (
            <button key={x.clave} type="button" aria-pressed={metrica === x.clave} className={metrica === x.clave ? "active" : ""} onClick={() => setMetrica(x.clave)}>
              {x.etiqueta}
            </button>
          ))}
        </div>
      </div>
      <div className="hour-controls">
        <span>
          {nombre} · {m.unidad}
        </span>
        <div>
          <button type="button" className="icon-button" disabled={desde === 0} onClick={() => setDesde(Math.max(0, desde - 4))} aria-label="Horas anteriores">
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={desde + VENTANA >= horas.length}
            onClick={() => setDesde(Math.min(horas.length - VENTANA, desde + 4))}
            aria-label="Horas siguientes"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div className="hour-chart">
        <svg viewBox="0 0 700 125" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#d5a958" stopOpacity=".24" />
              <stop offset="100%" stopColor="#d5a958" stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={`${x(0)},125 ${puntos} ${x(valores.length - 1)},125`} fill="url(#chart-fill)" />
          <polyline points={puntos} stroke="#be954c" strokeWidth="2.5" fill="none" vectorEffect="non-scaling-stroke" />
          {valores.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill="#be954c" />
          ))}
        </svg>
        <ol className="hour-columns" style={{ gridTemplateColumns: `repeat(${vistas.length},1fr)` }}>
          {vistas.map((h) => (
            <li key={h.t}>
              <span>{h.t.slice(11, 16)}</span>
              <IconoCielo cielo={h.cielo} noche={h.noche} titulo={h.cieloTxt} />
              <strong>{fmt(h[metrica], m.sufijo)}</strong>
              <small>
                <Droplets size={12} aria-hidden="true" />
                <span className="sr-only">Probabilidad de precipitación </span>
                {fmt(h.prob, "%")}
              </small>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
