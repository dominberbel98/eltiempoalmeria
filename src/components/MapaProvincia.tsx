// Mapa horario de la provincia: cada municipio es su polígono (límites IGN) coloreado según la variable y la hora elegidas.
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";

type Serie = (number | null)[];
type DatoMunicipio = {
  id: string;
  slug: string;
  nombre: string;
  lat: number;
  lon: number;
  temp: Serie;
  precip: Serie;
  prob: Serie;
  viento: Serie;
  racha: Serie;
  dir: Serie;
  cielo: (string | null)[];
};
type DatosMapa = { horas: string[]; municipios: DatoMunicipio[] };
type Variable = "precip" | "prob" | "viento" | "racha" | "temp";
type Props = { base: string; seleccionado?: string; alto?: number };

// Escalas por tramos: [desde, color]
const ESCALAS: Record<Variable, { etiqueta: string; unidad: string; tramos: [number, string][] }> = {
  precip: {
    etiqueta: "Lluvia",
    unidad: "mm/h",
    tramos: [[0, "#f1efe4"], [0.1, "#cfe4e9"], [0.5, "#9ccbd9"], [1, "#68acca"], [2, "#3f88bb"], [4, "#2b60a1"], [8, "#283f7c"], [15, "#4d2c78"]],
  },
  prob: {
    etiqueta: "Prob. lluvia",
    unidad: "%",
    tramos: [[0, "#f1efe4"], [10, "#dde9e5"], [30, "#b3d2db"], [50, "#80b4ce"], [70, "#4e91bf"], [90, "#2c67a6"]],
  },
  viento: {
    etiqueta: "Viento",
    unidad: "km/h",
    tramos: [[0, "#eef0e0"], [10, "#d5e3b6"], [20, "#b3cf88"], [30, "#e1ce68"], [40, "#e0a64b"], [50, "#d4783b"], [65, "#b6473a"], [80, "#8c2e4e"]],
  },
  racha: {
    etiqueta: "Rachas",
    unidad: "km/h",
    tramos: [[0, "#eef0e0"], [10, "#d5e3b6"], [20, "#b3cf88"], [30, "#e1ce68"], [40, "#e0a64b"], [50, "#d4783b"], [65, "#b6473a"], [80, "#8c2e4e"]],
  },
  temp: {
    etiqueta: "Temperatura",
    unidad: "°C",
    tramos: [[-50, "#4f78a8"], [5, "#6c9cb4"], [10, "#8dbaa6"], [15, "#bcd08f"], [20, "#e8d27a"], [25, "#e5a55a"], [30, "#d26c44"], [35, "#a8393a"]],
  },
};
const ORDEN: Variable[] = ["precip", "prob", "viento", "racha", "temp"];
const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const LIMITES: [[number, number], [number, number]] = [
  [36.68, -3.15],
  [37.92, -1.62],
];

const color = (v: Variable, x: number | null) => {
  if (x == null) return "#d9dcd3";
  const t = ESCALAS[v].tramos;
  let c = t[0][1];
  for (const [desde, col] of t) if (x >= desde) c = col;
  return c;
};
const n = (x: number | null, dec = 0) => (x == null ? "—" : x.toLocaleString("es-ES", { maximumFractionDigits: dec }));
const rumbo = (g: number | null) => (g == null ? "" : PUNTOS[Math.round(g / 45) % 8]);

function etiquetaHora(t: string, i: number) {
  if (i === 0) return `Ahora · ${t.slice(11, 16)}`;
  const dia = new Date(t.slice(0, 10) + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "short", day: "numeric", timeZone: "UTC" });
  return `${dia} · ${t.slice(11, 16)}`;
}

function flecha(dir: number, velocidad: number) {
  const s = Math.round(Math.min(34, 14 + velocidad / 2.5));
  // Flecha hacia abajo girada "dir" grados: apunta hacia donde sopla el viento
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="transform:rotate(${dir}deg)" aria-hidden="true"><path d="M12 3v16m-6-6 6 6 6-6" fill="none" stroke="#173a40" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export default function MapaProvincia({ base, seleccionado, alto }: Props) {
  const raiz = useRef<HTMLDivElement>(null);
  const [datos, setDatos] = useState<DatosMapa | null>(null);
  const [error, setError] = useState(false);
  const [variable, setVariable] = useState<Variable>("precip");
  const [hora, setHora] = useState(0);
  const [reproduciendo, setReproduciendo] = useState(false);
  const tocado = useRef(false); // solo se reescribe la URL si el usuario cambia algo

  // Objetos de Leaflet que se actualizan al cambiar variable u hora
  const capas = useRef<Map<string, Leaflet.Path>>(new Map());
  const flechas = useRef<Map<string, Leaflet.Marker>>(new Map());
  const grupoFlechas = useRef<Leaflet.LayerGroup | null>(null);
  const mapaRef = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const estado = useRef({ variable, hora, datos });
  estado.current = { variable, hora, datos };

  useEffect(() => {
    let parado = false;
    (async () => {
      const [lf, municipiosGeo, provinciasGeo, d] = await Promise.all([
        import("leaflet").then((x) => x.default),
        fetch(`${base}municipios.geojson`).then((r) => r.json()),
        fetch(`${base}provinces.geojson`).then((r) => r.json()),
        fetch(`${base}mapa-horas.json`).then((r) => r.json() as Promise<DatosMapa>),
      ]);
      if (parado || !raiz.current) return;
      L.current = lf;
      const porId = new Map(d.municipios.map((m) => [m.id, m]));
      const mapa = lf.map(raiz.current, { scrollWheelZoom: false, zoomControl: false, zoomSnap: 0.25, minZoom: 7, maxZoom: 12 });
      mapaRef.current = mapa;
      mapa.fitBounds(LIMITES, { padding: [8, 8] });
      lf.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);
      mapa.attributionControl.setPrefix(false).addAttribution("Límites: IGN · Ministerio de Transportes");

      lf.geoJSON(provinciasGeo, {
        interactive: false,
        style: (f) => ({ color: "#b7c2ab", weight: 1, fillColor: f?.properties?.NAMEUNIT === "Almería" ? "#e5e8cd" : "#eeeade", fillOpacity: 1 }),
      }).addTo(mapa);

      lf.geoJSON(municipiosGeo, {
        style: { color: "#ffffff", weight: 0.8, fillOpacity: 0.88 },
        onEachFeature: (f, capa) => {
          const m = porId.get(f.properties.id);
          if (!m) return;
          const path = capa as Leaflet.Path;
          capas.current.set(m.id, path);
          path.bindTooltip(() => {
            const { hora: h } = estado.current;
            return `<strong>${m.nombre}</strong><br>Lluvia ${n(m.precip[h], 1)} mm · ${n(m.prob[h])} %<br>Viento ${rumbo(m.dir[h])} ${n(m.viento[h])} km/h, rachas ${n(m.racha[h])}<br>${n(m.temp[h])}° · ${m.cielo[h] ?? ""}`;
          }, { sticky: true, direction: "top", className: "map-tip" });
          path.on("mouseover", () => path.setStyle({ weight: 2.5, color: "#203e43" }));
          path.on("mouseout", () => path.setStyle({ weight: m.slug === seleccionado ? 2.5 : 0.8, color: m.slug === seleccionado ? "#203e43" : "#ffffff" }));
          path.on("click", () => (window.location.href = `${base}${m.slug}/`));
          if (m.slug === seleccionado) path.setStyle({ weight: 2.5, color: "#203e43" });
        },
      }).addTo(mapa);

      grupoFlechas.current = lf.layerGroup();
      for (const m of d.municipios) {
        const marcador = lf.marker([m.lat, m.lon], { interactive: false, keyboard: false, icon: lf.divIcon({ className: "wind-marker", html: "", iconSize: [0, 0] }) });
        flechas.current.set(m.id, marcador);
        grupoFlechas.current.addLayer(marcador);
      }

      // Reencaja cuando el contenedor ya tiene su tamaño final (en móvil cambia tras cargar estilos)
      mapa.invalidateSize();
      mapa.fitBounds(LIMITES, { padding: [8, 8] });
      const elegido = d.municipios.find((m) => m.slug === seleccionado);
      if (elegido) mapa.setView([elegido.lat, elegido.lon], 9.25);
      setDatos(d);
      // Sin lluvia en ningún municipio en 48 h y sin capa pedida en la URL: se abre en viento
      const llueve = d.municipios.some((m) => m.precip.some((x) => (x ?? 0) > 0));
      if (!llueve && !new URLSearchParams(window.location.search).has("capa")) setVariable("viento");
    })().catch(() => setError(true));
    return () => {
      parado = true;
      mapaRef.current?.remove();
      mapaRef.current = null;
      capas.current.clear();
      flechas.current.clear();
    };
  }, [base, seleccionado]);

  // Repinta colores y flechas
  useEffect(() => {
    const lf = L.current;
    const mapa = mapaRef.current;
    if (!datos || !lf || !mapa) return;
    for (const m of datos.municipios) capas.current.get(m.id)?.setStyle({ fillColor: color(variable, m[variable][hora]) });
    const conFlechas = variable === "viento" || variable === "racha";
    if (conFlechas) {
      for (const m of datos.municipios) {
        const dir = m.dir[hora];
        const vel = m[variable][hora];
        flechas.current.get(m.id)?.setIcon(
          lf.divIcon({ className: "wind-marker", html: dir == null || vel == null ? "" : flecha(dir, vel), iconSize: [0, 0] })
        );
      }
      grupoFlechas.current?.addTo(mapa);
    } else grupoFlechas.current?.remove();
  }, [datos, variable, hora]);

  // Capa y hora en la URL (?capa=viento&hora=6) para poder compartir el mapa
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const capa = q.get("capa") as Variable | null;
    if (capa && ORDEN.includes(capa)) setVariable(capa);
    const h = Number(q.get("hora"));
    if (Number.isInteger(h) && h > 0 && h < 48) setHora(h);
  }, []);
  useEffect(() => {
    if (!datos || reproduciendo || !tocado.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("capa", variable);
    if (hora) url.searchParams.set("hora", String(hora));
    else url.searchParams.delete("hora");
    history.replaceState(null, "", url);
  }, [variable, hora, datos, reproduciendo]);

  // Animación de las horas
  useEffect(() => {
    if (!reproduciendo || !datos) return;
    const id = window.setInterval(() => setHora((h) => (h + 1) % datos.horas.length), 900);
    return () => window.clearInterval(id);
  }, [reproduciendo, datos]);

  const escala = ESCALAS[variable];
  const total = datos?.horas.length ?? 48;
  const sinLluvia =
    datos != null &&
    (variable === "precip" || variable === "prob") &&
    datos.municipios.every((m) => (m[variable][hora] ?? 0) < (variable === "prob" ? 5 : 0.1));

  return (
    <div className="map-weather">
      <div className="map-toolbar">
        <div className="segmented" role="group" aria-label="Variable del mapa">
          {ORDEN.map((v) => (
            <button key={v} type="button" aria-pressed={variable === v} className={variable === v ? "active" : ""} onClick={() => {
                tocado.current = true;
                setVariable(v);
              }}>
              {ESCALAS[v].etiqueta}
            </button>
          ))}
        </div>
        <div className="map-time">
          <button
            type="button"
            className="icon-button"
            onClick={() => setReproduciendo((x) => !x)}
            disabled={!datos}
            aria-label={reproduciendo ? "Pausar animación" : "Reproducir las próximas horas"}
          >
            {reproduciendo ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={total - 1}
            value={hora}
            disabled={!datos}
            aria-label="Hora del mapa"
            aria-valuetext={datos ? etiquetaHora(datos.horas[hora], hora) : undefined}
            onChange={(e) => {
              tocado.current = true;
              setReproduciendo(false);
              setHora(Number(e.target.value));
            }}
          />
          <output className="map-hour">{datos ? etiquetaHora(datos.horas[hora], hora) : "Cargando…"}</output>
        </div>
      </div>
      <div className="map-wrap" style={alto ? { height: alto } : undefined}>
        <div ref={raiz} className="map-canvas" role="region" aria-label={`Mapa de ${escala.etiqueta.toLowerCase()} por municipio de Almería`} />
        {sinLluvia && (
          <div className="map-empty" role="status">
            Sin lluvia prevista a esta hora en ningún municipio
          </div>
        )}
        {error && <div className="map-message">La cartografía no está disponible. Puedes elegir un municipio en la lista.</div>}
        <div className="map-legend">
          <small>{escala.unidad}</small>
          {escala.tramos.map(([desde, c]) => (
            <span key={desde} className="map-legend-step">
              <span style={{ background: c }} />
              <small>{variable === "temp" && desde < -40 ? "<5" : n(desde, 1)}</small>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
