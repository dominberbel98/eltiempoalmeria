// Mapa horario de la provincia (isla): cada término municipal (límites IGN) coloreado según la capa y la hora elegidas,
// con reproducción de las próximas 48 h, lista de los valores más altos a esa hora y tabla con los mismos datos.
// Va dentro de una .banda-oscura. Al pulsar un municipio entra en MODO FOCO: se oculta la provincia y se monta
// <VistaZonas compacto> con solo su término y sus zonas; "Volver a la provincia" o Escape lo deshacen.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "leaflet/dist/leaflet.css";
import "./MapaProvincia.css";
import type * as Leaflet from "leaflet";
import { diaConNumero } from "../lib/tiempo";

const VistaZonas = lazy(() => import("./VistaZonas"));

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
  tormenta: Serie | null;
};
type DatosMapa = { horas: string[]; municipios: DatoMunicipio[] };

export type CapaMapa = "precip" | "prob" | "viento" | "racha" | "temp" | "tormenta";
export type Destacado = { slug: string; nombre: string; valor: number | null };

type Props = {
  base: string;
  // meta.updatedAt: se añade como ?v= a los JSON para saltarse la caché de Pages
  version?: string;
  // Capa con la que se abre (lluvia si llueve en algún municipio en 48 h; si no, rachas). La URL (?capa=) manda.
  capaInicial?: CapaMapa;
  // Valores más altos de capaInicial en la primera hora, calculados en el build (se ven antes de cargar el JSON)
  destacadosIniciales?: Destacado[];
  // Primera hora de la previsión ("2026-10-31T12:00"), para el rótulo antes de cargar
  horaInicial?: string;
  // /mapa/: mapa más alto
  amplio?: boolean;
  // Nivel del título de la capa: "h1" por defecto (portada y /mapa/); "h2" si hay `seleccionado`, cuya página ya tiene h1
  encabezado?: "h1" | "h2";
  // Municipio resaltado al abrir (página de municipio)
  seleccionado?: string;
  // Alto fijo del mapa en px (opcional)
  alto?: number;
};

// --- Escalas (6 pasos, colores de los tokens de global.css; Leaflet necesita el valor, no la variable) ---
const LLUVIA = ["#34494f", "#24646a", "#1c8c8c", "#3aa7a3", "#74c3bd", "#b4e0da"];
const RACHA = ["#3a4a50", "#5e5048", "#8a5340", "#b5472e", "#d0683f", "#e89a62"];
const TEMP = ["#3f6e78", "#5e8c8f", "#8fae9f", "#d3c9a6", "#d9a27e", "#c4694b"];
const SIN_DATO = "#2a3439";

type Escala = {
  boton: string; // texto del botón de capa
  titulo: string; // título de la banda
  leyenda: string; // título de la leyenda
  lista: string; // rótulo de la lista lateral
  vacio: string; // cuando nadie supera el mínimo a esa hora
  desde: number[]; // umbral inferior de cada paso
  etiquetas: string[];
  colores: string[];
  minimoLista: number | null; // valor mínimo para entrar en la lista (null: todos)
};
const ESCALAS: Record<CapaMapa, Escala> = {
  precip: {
    boton: "Lluvia",
    titulo: "Lluvia en los 103 municipios",
    leyenda: "Lluvia, mm en una hora",
    lista: "Más lluvia a esa hora",
    vacio: "Sin lluvia prevista a esa hora en ningún municipio.",
    desde: [0, 0.1, 0.5, 1, 2, 5],
    etiquetas: ["0", "0,1", "0,5", "1", "2", "5+"],
    colores: LLUVIA,
    minimoLista: 0.1,
  },
  prob: {
    boton: "Probabilidad de lluvia",
    titulo: "Probabilidad de lluvia en los 103 municipios",
    leyenda: "Probabilidad de lluvia, %",
    lista: "Más probabilidad de lluvia a esa hora",
    vacio: "Ningún municipio pasa del 5 % de probabilidad de lluvia a esa hora.",
    desde: [0, 10, 30, 50, 70, 90],
    etiquetas: ["0", "10", "30", "50", "70", "90"],
    colores: LLUVIA,
    minimoLista: 5,
  },
  viento: {
    boton: "Viento",
    titulo: "Viento en los 103 municipios",
    leyenda: "Viento medio, km/h",
    lista: "Viento más fuerte a esa hora",
    vacio: "Sin datos de viento a esa hora.",
    desde: [0, 5, 10, 20, 30, 40],
    etiquetas: ["0", "5", "10", "20", "30", "40+"],
    colores: RACHA,
    minimoLista: null,
  },
  racha: {
    boton: "Rachas",
    titulo: "Rachas de viento en los 103 municipios",
    leyenda: "Rachas, km/h",
    lista: "Rachas más fuertes a esa hora",
    vacio: "Sin datos de rachas a esa hora.",
    desde: [0, 10, 20, 30, 40, 50],
    etiquetas: ["0", "10", "20", "30", "40", "50+"],
    colores: RACHA,
    minimoLista: null,
  },
  temp: {
    boton: "Temperatura",
    titulo: "Temperatura en los 103 municipios",
    leyenda: "Temperatura, °C",
    lista: "Temperaturas más altas a esa hora",
    vacio: "Sin datos de temperatura a esa hora.",
    desde: [-Infinity, 6, 12, 18, 24, 30],
    etiquetas: ["<6", "6", "12", "18", "24", "30+"],
    colores: TEMP,
    minimoLista: null,
  },
  tormenta: {
    boton: "Tormenta",
    titulo: "Probabilidad de tormenta en los 103 municipios",
    leyenda: "Probabilidad de tormenta (AEMET), %",
    lista: "Más probabilidad de tormenta a esa hora",
    vacio: "Ningún municipio tiene probabilidad de tormenta a esa hora.",
    desde: [0, 5, 15, 30, 50, 70],
    etiquetas: ["0", "5", "15", "30", "50", "70"],
    colores: RACHA,
    minimoLista: 5,
  },
};
const ORDEN: CapaMapa[] = ["precip", "prob", "viento", "racha", "temp", "tormenta"];
const esCapa = (x: string | null): x is CapaMapa => x != null && (ORDEN as string[]).includes(x);

const LIMITES: [[number, number], [number, number]] = [
  [36.68, -3.15],
  [37.92, -1.62],
];
const CAPITAL = "04013";

// --- Utilidades exportadas (también las usa la portada en el build, para que coincidan con el JSON) ---
export const capaPorDefecto = (llueve: boolean): CapaMapa => (llueve ? "precip" : "racha");
export const redondearCapa = (capa: CapaMapa, v: number | null | undefined): number | null =>
  v == null || !Number.isFinite(v) ? null : capa === "precip" ? Math.round(v * 10) / 10 : Math.round(v);
export function elegirDestacados(capa: CapaMapa, lista: Destacado[], n = 5): Destacado[] {
  const minimo = ESCALAS[capa].minimoLista;
  return lista
    .filter((d) => d.valor != null && (minimo == null || d.valor >= minimo))
    .sort((a, b) => b.valor! - a.valor! || a.nombre.localeCompare(b.nombre, "es"))
    .slice(0, n);
}

const mm = (v: number) => (v === 0 ? "0" : v < 0.1 ? "<0,1" : v.toLocaleString("es-ES", { maximumFractionDigits: 1 }));
export function textoValor(capa: CapaMapa, v: number | null | undefined): string {
  if (v == null) return "—";
  if (capa === "precip") return `${mm(v)} mm`;
  if (capa === "temp") return `${v}°`;
  if (capa === "prob" || capa === "tormenta") return `${v} %`;
  return `${v} km/h`;
}

const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
const rumbo = (g: number | null) => (g == null ? "" : PUNTOS[Math.round((((g % 360) + 360) % 360) / 45) % 8]);

function color(capa: CapaMapa, v: number | null): string {
  if (v == null) return SIN_DATO;
  const e = ESCALAS[capa];
  let c = e.colores[0];
  e.desde.forEach((d, i) => {
    if (v >= d) c = e.colores[i];
  });
  return c;
}

const hhmm = (t: string) => t.slice(11, 16);
export function etiquetaHora(t: string | undefined, i: number): string {
  if (!t) return "Cargando…";
  return i === 0 ? `Ahora, ${hhmm(t)}` : `${diaConNumero(t, true)}, ${hhmm(t)}`;
}
const horaLarga = (t: string) => `${diaConNumero(t).toLowerCase()} ${hhmm(t).startsWith("01:") ? "a la" : "a las"} ${hhmm(t)}`;

const escapar = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Flecha hacia abajo girada `dir` grados: apunta hacia donde sopla el viento (dir es de donde viene)
// `escala` depende del zoom: con la provincia entera en el móvil (zoom ~7,7) las flechas son más pequeñas
function flecha(dir: number, velocidad: number, escala = 1) {
  const s = Math.round(Math.min(32, 14 + velocidad / 2.5) * escala);
  return (
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="left:${-s / 2}px;top:${-s / 2}px;transform:rotate(${dir}deg)" aria-hidden="true">` +
    `<path d="M12 3v16m-6-6 6 6 6-6" fill="none" stroke="#1e2a30" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M12 3v16m-6-6 6 6 6-6" fill="none" stroke="#eef1f0" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

const serieDe = (m: DatoMunicipio, capa: CapaMapa): Serie | null => (capa === "tormenta" ? m.tormenta : m[capa]);
const valorDe = (m: DatoMunicipio, capa: CapaMapa, h: number): number | null => serieDe(m, capa)?.[h] ?? null;

export default function MapaProvincia({
  base,
  version = "",
  capaInicial = "racha",
  destacadosIniciales,
  horaInicial,
  amplio = false,
  seleccionado,
  encabezado = seleccionado ? "h2" : "h1",
  alto,
}: Props) {
  const v = version ? `?v=${encodeURIComponent(version)}` : "";
  const raiz = useRef<HTMLDivElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);
  const [datos, setDatos] = useState<DatosMapa | null>(null);
  const [error, setError] = useState(false);
  const [capa, setCapa] = useState<CapaMapa>(capaInicial);
  const [hora, setHora] = useState(0);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [encima, setEncima] = useState<string | null>(null); // id del municipio bajo el cursor
  const [tablaAbierta, setTablaAbierta] = useState(false);
  const [zoom, setZoom] = useState(8.75);
  const [foco, setFoco] = useState<{ slug: string; nombre: string } | null>(null);
  const tocado = useRef(false); // solo se reescribe la URL si el usuario cambia algo
  const origenFoco = useRef<HTMLElement | null>(null);

  // Objetos de Leaflet que se actualizan al cambiar capa u hora
  const capas = useRef<Map<string, Leaflet.Path>>(new Map());
  const flechas = useRef<Map<string, Leaflet.Marker>>(new Map());
  const grupoFlechas = useRef<Leaflet.LayerGroup | null>(null);
  const mapaRef = useRef<Leaflet.Map | null>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const estado = useRef({ capa, hora, datos, foco });
  estado.current = { capa, hora, datos, foco };

  const entrarFoco = useCallback((m: { slug: string; nombre: string }, origen?: HTMLElement | null) => {
    origenFoco.current = origen ?? null;
    setReproduciendo(false);
    setEncima(null);
    setFoco({ slug: m.slug, nombre: m.nombre });
    const url = new URL(window.location.href);
    url.searchParams.set("foco", m.slug);
    history.replaceState(null, "", url);
  }, []);
  const salirFoco = useCallback(() => {
    setFoco(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("foco");
    history.replaceState(null, "", url);
  }, []);
  const entrarFocoRef = useRef(entrarFoco);
  entrarFocoRef.current = entrarFoco;

  // Encaja la provincia (al cargar, al cambiar de tamaño y al volver del modo foco)
  const encajar = useCallback(() => {
    const mapa = mapaRef.current;
    if (!mapa || estado.current.foco) return;
    mapa.invalidateSize();
    const datosAhora = estado.current.datos;
    const elegido = datosAhora?.municipios.find((m) => m.slug === seleccionado);
    if (elegido) mapa.setView([elegido.lat, elegido.lon], 9.25);
    else mapa.fitBounds(LIMITES, { padding: [8, 8] });
  }, [seleccionado]);

  // Carga de Leaflet, cartografía y datos
  useEffect(() => {
    let parado = false;
    (async () => {
      const [lf, municipiosGeo, provinciasGeo, d] = await Promise.all([
        import("leaflet").then((x) => x.default),
        fetch(`${base}municipios.geojson`).then((r) => r.json()),
        fetch(`${base}provinces.geojson`).then((r) => r.json()),
        fetch(`${base}mapa-horas.json${v}`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<DatosMapa>;
        }),
      ]);
      if (parado || !raiz.current) return;
      L.current = lf;
      const tactil = window.matchMedia("(pointer: coarse)").matches;
      const porId = new Map(d.municipios.map((m) => [m.id, m]));
      const mapa = lf.map(raiz.current, {
        renderer: lf.svg(),
        scrollWheelZoom: false,
        zoomControl: false,
        zoomSnap: 0.25,
        minZoom: 7,
        maxZoom: 12,
        // En el móvil el mapa es fijo: así no atrapa el desplazamiento de la página y pulsar un municipio abre sus zonas
        dragging: !tactil,
        touchZoom: false,
        doubleClickZoom: !tactil,
        boxZoom: false,
        keyboard: false,
        maxBounds: [
          [36.2, -3.9],
          [38.4, -0.9],
        ],
      });
      mapaRef.current = mapa;
      mapa.on("zoomend", () => setZoom(mapa.getZoom()));
      mapa.fitBounds(LIMITES, { padding: [8, 8] });
      if (!tactil) lf.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);
      mapa.attributionControl.setPrefix(false).addAttribution("Límites: IGN");

      lf.geoJSON(provinciasGeo, {
        interactive: false,
        style: (f) => ({
          color: "#33454d",
          weight: 1,
          fillColor: f?.properties?.NAMEUNIT === "Almería" ? "#1e2a30" : "#263840",
          fillOpacity: 1,
        }),
      }).addTo(mapa);

      const borde = (m: DatoMunicipio) =>
        m.slug === seleccionado ? { weight: 2.5, color: "#e89a62" } : { weight: 0.8, color: "#1e2a30" };
      lf.geoJSON(municipiosGeo, {
        style: { color: "#1e2a30", weight: 0.8, fillOpacity: 1, fillColor: SIN_DATO },
        onEachFeature: (f, capaGeo) => {
          const m = porId.get(f.properties.id);
          if (!m) return;
          const path = capaGeo as Leaflet.Path;
          capas.current.set(m.id, path);
          path.setStyle(borde(m));
          path.bindTooltip(
            () => {
              const { capa: c, hora: h } = estado.current;
              return `${escapar(m.nombre)} <strong>${escapar(textoValor(c, valorDe(m, c, h)))}</strong>`;
            },
            { sticky: true, direction: "top", className: "mp-tip", offset: [0, -8] }
          );
          path.on("mouseover", () => {
            path.setStyle({ weight: 2.5, color: "#eef1f0" });
            path.bringToFront();
            setEncima(m.id);
          });
          path.on("mouseout", () => {
            path.setStyle(borde(m));
            setEncima((x) => (x === m.id ? null : x));
          });
          path.on("click", () => {
            path.closeTooltip();
            entrarFocoRef.current({ slug: m.slug, nombre: m.nombre });
          });
        },
      }).addTo(mapa);

      grupoFlechas.current = lf.layerGroup();
      for (const m of d.municipios) {
        const marcador = lf.marker([m.lat, m.lon], {
          interactive: false,
          keyboard: false,
          icon: lf.divIcon({ className: "mp-flecha", html: "", iconSize: [0, 0] }),
        });
        flechas.current.set(m.id, marcador);
        grupoFlechas.current.addLayer(marcador);
      }

      estado.current.datos = d;
      setDatos(d);
      // Reencaja cuando el contenedor ya tiene su tamaño final
      requestAnimationFrame(() => encajar());
    })().catch(() => {
      if (!parado) setError(true);
    });
    return () => {
      parado = true;
      mapaRef.current?.remove();
      mapaRef.current = null;
      capas.current.clear();
      flechas.current.clear();
    };
  }, [base, v, seleccionado, encajar]);

  // Reencaja al cambiar el ancho del contenedor
  useEffect(() => {
    const el = raiz.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let ancho = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === ancho || el.clientWidth === 0) return;
      ancho = el.clientWidth;
      encajar();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [encajar]);

  // Repinta colores y flechas
  useEffect(() => {
    const lf = L.current;
    const mapa = mapaRef.current;
    if (!datos || !lf || !mapa) return;
    for (const m of datos.municipios) capas.current.get(m.id)?.setStyle({ fillColor: color(capa, valorDe(m, capa, hora)) });
    if (capa === "viento" || capa === "racha") {
      const escalaFlecha = Math.min(1.3, Math.max(0.55, 2 ** (zoom - 8.75)));
      for (const m of datos.municipios) {
        const dir = m.dir[hora];
        const vel = m[capa][hora];
        flechas.current
          .get(m.id)
          ?.setIcon(lf.divIcon({ className: "mp-flecha", html: dir == null || vel == null ? "" : flecha(dir, vel, escalaFlecha), iconSize: [0, 0] }));
      }
      grupoFlechas.current?.addTo(mapa);
    } else grupoFlechas.current?.remove();
  }, [datos, capa, hora, zoom]);

  // Capa, hora y foco desde la URL (?capa=viento&hora=6&foco=nijar), para poder compartir el mapa
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const c = q.get("capa");
    if (esCapa(c)) setCapa(c);
    const h = Number(q.get("hora"));
    if (Number.isInteger(h) && h > 0 && h < 48) setHora(h);
  }, []);
  useEffect(() => {
    if (!datos) return;
    const slug = new URLSearchParams(window.location.search).get("foco");
    const m = slug ? datos.municipios.find((x) => x.slug === slug) : null;
    if (m) setFoco({ slug: m.slug, nombre: m.nombre });
  }, [datos]);
  useEffect(() => {
    if (!datos || reproduciendo || !tocado.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("capa", capa);
    if (hora) url.searchParams.set("hora", String(hora));
    else url.searchParams.delete("hora");
    history.replaceState(null, "", url);
  }, [capa, hora, datos, reproduciendo]);

  // Animación de las horas
  useEffect(() => {
    if (!reproduciendo || !datos) return;
    const id = window.setInterval(() => setHora((h) => (h + 1) % datos.horas.length), 900);
    return () => window.clearInterval(id);
  }, [reproduciendo, datos]);

  // Modo foco: el foco del teclado pasa al título; Escape vuelve a la provincia. Al volver, se reencaja el mapa
  // (estaba oculto) y el foco regresa a donde estaba.
  const primeraVez = useRef(true);
  useEffect(() => {
    if (primeraVez.current) {
      primeraVez.current = false;
      return;
    }
    if (foco) {
      titulo.current?.focus({ preventScroll: true });
      titulo.current?.scrollIntoView({ block: "nearest" });
      const tecla = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !e.defaultPrevented) salirFoco();
      };
      document.addEventListener("keydown", tecla);
      return () => document.removeEventListener("keydown", tecla);
    }
    requestAnimationFrame(() => {
      encajar();
      const destino = origenFoco.current?.isConnected ? origenFoco.current : titulo.current;
      destino?.focus({ preventScroll: true });
      origenFoco.current = null;
    });
  }, [foco, salirFoco, encajar]);

  const escala = ESCALAS[capa];
  const total = datos?.horas.length ?? 48;
  const t = datos?.horas[hora] ?? (hora === 0 ? horaInicial : undefined);
  const textoHora = etiquetaHora(t, hora);

  const destacados = useMemo(() => {
    if (!datos) return capa === capaInicial && hora === 0 ? (destacadosIniciales ?? null) : null;
    return elegirDestacados(
      capa,
      datos.municipios.map((m) => ({ slug: m.slug, nombre: m.nombre, valor: valorDe(m, capa, hora) }))
    );
  }, [datos, capa, hora, capaInicial, destacadosIniciales]);

  // Aviso sobre el mapa cuando no hay nada que pintar a esa hora
  let mensaje: string | null = null;
  if (error) mensaje = "La cartografía no está disponible ahora. Los datos de cada municipio siguen en su página.";
  else if (datos) {
    const valores = datos.municipios.map((m) => valorDe(m, capa, hora));
    if (capa === "tormenta" && valores.every((x) => x == null)) mensaje = "AEMET no da probabilidad de tormenta para esta hora.";
    else if (capa === "precip" && valores.every((x) => (x ?? 0) < 0.1)) mensaje = "Sin lluvia prevista a esta hora en ningún municipio.";
    else if (capa === "prob" && valores.every((x) => (x ?? 0) < 5)) mensaje = "Probabilidad de lluvia casi nula en toda la provincia.";
    else if (capa === "tormenta" && valores.every((x) => (x ?? 0) < 5)) mensaje = "Sin probabilidad de tormenta a esta hora.";
  }
  const haySinDato = datos?.municipios.some((m) => valorDe(m, capa, hora) == null) ?? false;

  const idPanel = encima ?? datos?.municipios.find((m) => m.slug === seleccionado)?.id ?? CAPITAL;
  const panel = datos?.municipios.find((m) => m.id === idPanel) ?? null;
  const ordenados = useMemo(
    () => (datos ? [...datos.municipios].sort((a, b) => a.nombre.localeCompare(b.nombre, "es")) : []),
    [datos]
  );

  const Titulo = encabezado;
  const cabecera = (
    <div className="mp-cabecera">
      <Titulo ref={titulo} id="mp-titulo" className="titular titular-banda mp-titulo" tabIndex={-1}>
        {foco ? foco.nombre : escala.titulo}
      </Titulo>
      <p className="mp-intro">
        {foco
          ? "Su término municipal dividido en zonas, con la previsión de cada una."
          : "Cada área es un término municipal. Elige qué ver y desliza para recorrer las próximas 48 horas."}
      </p>
    </div>
  );

  let vistaFoco: ReactNode = null;
  if (foco) {
    vistaFoco = (
      <div className="mp-foco">
        <div className="mp-foco-acciones">
          <button type="button" className="boton-claro" onClick={salirFoco}>
            Volver a la provincia
          </button>
        </div>
        <Suspense fallback={<p className="mp-cargando">Cargando las zonas de {foco.nombre}…</p>}>
          <VistaZonas compacto slug={foco.slug} base={base} version={version} nombre={foco.nombre} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className={"mp" + (amplio ? " mp-amplio" : "")}>
      <div className="mp-principal">
        {cabecera}
        {vistaFoco}
        <div className="mp-controles" hidden={Boolean(foco)}>
          <div role="group" aria-label="Qué mostrar en el mapa" className="chips">
            {ORDEN.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={capa === c}
                onClick={() => {
                  tocado.current = true;
                  setCapa(c);
                }}
              >
                {ESCALAS[c].boton}
              </button>
            ))}
          </div>

          <div className="mp-marco">
            <div
              ref={raiz}
              className="mp-lienzo"
              style={alto ? { height: alto } : undefined}
              role="region"
              aria-label={`Mapa de ${escala.boton.toLowerCase()} por municipio. Pulsa un municipio para ver sus zonas; la tabla de debajo tiene los mismos datos.`}
            />
            {mensaje && (
              <p className="mp-mensaje" role="status">
                {mensaje}
              </p>
            )}
            <div className="mp-leyenda-caja">
              <p className="mp-leyenda-titulo">{escala.leyenda}</p>
              <div className="leyenda">
                {escala.colores.map((c, i) => (
                  <div key={c + i}>
                    <span className="muestra" style={{ background: c }} />
                    <span>{escala.etiquetas[i]}</span>
                  </div>
                ))}
                {haySinDato && (
                  <div>
                    <span className="muestra mp-sin-dato" style={{ background: SIN_DATO }} />
                    <span>Sin dato</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mp-reproductor">
            <button
              type="button"
              className="boton-reproducir"
              onClick={() => setReproduciendo((x) => !x)}
              disabled={!datos}
              aria-label={reproduciendo ? "Pausar" : "Reproducir las próximas horas"}
            >
              {reproduciendo ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>
            <label htmlFor="mp-hora" className="sr-only">
              Hora del mapa
            </label>
            <input
              id="mp-hora"
              type="range"
              className="deslizador"
              min={0}
              max={total - 1}
              value={hora}
              disabled={!datos}
              aria-valuetext={textoHora}
              onChange={(e) => {
                tocado.current = true;
                setReproduciendo(false);
                setHora(Number(e.target.value));
              }}
            />
            <output htmlFor="mp-hora" className="mp-hora">
              {textoHora}
            </output>
          </div>

          <details className="mp-tabla" onToggle={(e) => setTablaAbierta((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Ver los datos del mapa en una tabla</summary>
            {tablaAbierta && datos && t && (
              <div className="tabla-desplazable">
                <table className="tabla">
                  <caption>
                    {escala.boton} por municipio, {horaLarga(t)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Municipio</th>
                      <th scope="col" className="num">
                        {escala.boton}
                      </th>
                      {(capa === "viento" || capa === "racha") && <th scope="col">Dirección</th>}
                      <th scope="col" className="num">
                        <span className="sr-only">Zonas</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordenados.map((m) => (
                      <tr key={m.id}>
                        <th scope="row">
                          <a href={`${base}${m.slug}/`}>{m.nombre}</a>
                        </th>
                        <td className="num">{textoValor(capa, valorDe(m, capa, hora))}</td>
                        {(capa === "viento" || capa === "racha") && <td>{rumbo(m.dir[hora]) || "—"}</td>}
                        <td className="num">
                          <button
                            type="button"
                            className="mp-boton-zonas"
                            aria-label={`Ver las zonas de ${m.nombre} en el mapa`}
                            onClick={(e) => entrarFoco(m, e.currentTarget)}
                          >
                            Ver zonas
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </div>
      </div>

      <div className="mp-lateral" hidden={Boolean(foco)}>
        <div className="mp-destacados">
          <p className="mp-etiqueta">{escala.lista}</p>
          {destacados == null ? (
            <p className="mp-vacio">Cargando…</p>
          ) : destacados.length === 0 ? (
            <p className="mp-vacio">{escala.vacio}</p>
          ) : (
            <ol>
              {destacados.map((d) => (
                <li key={d.slug}>
                  <a href={`${base}${d.slug}/`}>{d.nombre}</a>
                  <span className={"mp-valor" + (capa === "precip" || capa === "prob" ? " mp-valor-lluvia" : "")}>
                    {textoValor(capa, d.valor)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="panel-oscuro mp-panel">
          <p className="mp-etiqueta">{encima ? "A esa hora" : "Pasa por un municipio o púlsalo para ver sus zonas"}</p>
          <p className="mp-panel-nombre">{panel?.nombre ?? "Almería"}</p>
          <dl>
            <div>
              <dt>Rachas</dt>
              <dd>{textoValor("racha", panel ? valorDe(panel, "racha", hora) : null)}</dd>
            </div>
            <div>
              <dt>Viento</dt>
              <dd>
                {textoValor("viento", panel ? valorDe(panel, "viento", hora) : null)}
                {panel && panel.dir[hora] != null && panel.viento[hora] != null ? ` del ${rumbo(panel.dir[hora])}` : ""}
              </dd>
            </div>
            <div>
              <dt>Lluvia</dt>
              <dd>{textoValor("precip", panel ? valorDe(panel, "precip", hora) : null)}</dd>
            </div>
            <div>
              <dt>Temperatura</dt>
              <dd>{textoValor("temp", panel ? valorDe(panel, "temp", hora) : null)}</dd>
            </div>
            <div>
              <dt>Probabilidad de lluvia</dt>
              <dd>{textoValor("prob", panel ? valorDe(panel, "prob", hora) : null)}</dd>
            </div>
            <div>
              <dt>Tormenta</dt>
              <dd>{textoValor("tormenta", panel ? valorDe(panel, "tormenta", hora) : null)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
