// Vista por zonas de un municipio (isla React): mapa del término dividido en las zonas de predicción de Open-Meteo
// (celdas de Voronoi), coloreado por variable y día (u hora), con etiquetas, leyenda, tabla accesible de las zonas y
// el meteograma de la zona elegida. Lee /zonas/{slug}.json (src/pages/zonas/[slug].json.ts).
// `compacto`: para el modo foco del mapa provincial (sin tabla ni meteograma, con enlace a la página del municipio).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import "./mapa/mapa.css";
import type * as Leaflet from "leaflet";
import type { FeatureCollection, MultiPolygon } from "geojson";
import Meteograma from "./Meteograma";
import { cieloWmo, diaConNumero, horaLocal, textoActualizacion, type HoraMeteograma } from "../lib/tiempo";
import type { DiaZona, EndpointZonas, ZonaEndpoint } from "../lib/zonas";
import {
  COLOR,
  COLOR_TORMENTA,
  ORDEN_TORMENTA,
  TEXTO_TORMENTA,
  UMBRAL_CALOR,
  UMBRAL_HELADA,
  escalaLluvia,
  escalaRachas,
  escalaTemperatura,
  fmtAltitud,
  fmtGrados,
  fmtKmh,
  fmtLluvia,
  tormentaHora,
  type Escala,
  type NivelTormenta,
} from "./mapa/escalas";
import { colocarEtiquetas, medirTexto, type EntradaEtiqueta } from "./mapa/etiquetas";
import { PANES, capaContorno, capaMascara, crearPanes, encuadrarTermino, limites, menosMovimiento } from "./mapa/termino";
import { esNoche } from "./mapa/sol";

type Props = {
  slug: string;
  base: string;
  version: string;
  nombre: string;
  zonaInicial?: string;
  compacto?: boolean;
};

type VariableDia = "min" | "max" | "racha" | "lluvia" | "tormenta";
type VariableHora = "temp" | "racha" | "lluvia" | "tormenta";
type Variable = VariableDia | VariableHora;

type Estado =
  | { tipo: "cargando" }
  | { tipo: "error"; motivo: string }
  | { tipo: "sin-zonas" }
  | { tipo: "listo"; datos: EndpointZonas };

const VARIABLES_DIA: { id: VariableDia; texto: string }[] = [
  { id: "min", texto: "Mínima y heladas" },
  { id: "max", texto: "Máxima y calor" },
  { id: "racha", texto: "Rachas" },
  { id: "lluvia", texto: "Lluvia" },
  { id: "tormenta", texto: "Tormentas" },
];
const VARIABLES_HORA: { id: VariableHora; texto: string }[] = [
  { id: "temp", texto: "Temperatura" },
  { id: "racha", texto: "Rachas" },
  { id: "lluvia", texto: "Lluvia" },
  { id: "tormenta", texto: "Tormentas" },
];

const FUENTE_ETIQUETA = "14px 'Archivo Variable', system-ui, sans-serif";
const FUENTE_VALOR = "700 14px 'Archivo Variable', system-ui, sans-serif";
const RELLENO_ETIQUETA = 16 + 2; // 8 px a cada lado y redondeo

const escaparHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const diaLargo = (fecha: string) => diaConNumero(fecha).toLowerCase(); // "sábado 31"
const aLas = (t: string) => `${t.slice(11, 13) === "01" ? "a la" : "a las"} ${t.slice(11, 16)}`;

/** Nombre de la zona en minúscula inicial para frases ("la sierra al oeste (1.200 m)"), salvo núcleos. */
function enFrase(z: ZonaEndpoint): string {
  if (z.tipo !== "terreno") return z.nombre;
  return z.nombre.charAt(0).toLocaleLowerCase("es") + z.nombre.slice(1);
}

/** Lista en español: "A", "A y B", "A, B y C" */
const listaY = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`);

// ---------- Valores por zona según variable, día y hora ----------

type Valor = number | NivelTormenta | null;

function valorZona(z: ZonaEndpoint, variable: Variable, porHoras: boolean, dia: number, hora: number): Valor {
  if (porHoras) {
    const h = z.horas;
    switch (variable) {
      case "temp":
      case "min":
      case "max":
        return h.temp[hora] ?? null;
      case "racha":
        return h.racha[hora] ?? null;
      case "lluvia":
        return h.precip[hora] ?? null;
      case "tormenta":
        return tormentaHora(h.wc[hora], h.cape[hora], h.prob[hora]);
    }
  }
  const d: DiaZona | undefined = z.dias[dia];
  if (!d) return null;
  switch (variable) {
    case "min":
    case "temp":
      return d.min;
    case "max":
      return d.max;
    case "racha":
      return d.racha;
    case "lluvia":
      return d.lluvia;
    case "tormenta":
      return d.tormenta;
  }
}

function escalaDe(datos: EndpointZonas, variable: Variable, porHoras: boolean): Escala | null {
  if (variable === "tormenta") return null;
  if (variable === "racha") return escalaRachas();
  if (variable === "lluvia") return escalaLluvia(porHoras);
  // Temperatura: tramos comunes a todos los días (o todas las horas) para poder comparar al cambiar
  const valores = porHoras
    ? datos.zonas.flatMap((z) => z.horas.temp)
    : datos.zonas.flatMap((z) => z.dias.map((d) => (variable === "max" ? d.max : d.min)));
  return escalaTemperatura(valores, { helada: variable !== "max", calor: variable !== "min" });
}

function colorDe(valor: Valor, variable: Variable, escala: Escala | null): string {
  if (variable === "tormenta") return typeof valor === "string" ? COLOR_TORMENTA[valor] : COLOR.sinDato;
  return escala ? escala.color(typeof valor === "number" ? valor : null) : COLOR.sinDato;
}

function textoValor(valor: Valor, variable: Variable, conUnidad = false): string {
  if (valor == null) return "—";
  if (typeof valor === "string") return TEXTO_TORMENTA[valor];
  if (variable === "racha") return fmtKmh(valor, conUnidad);
  if (variable === "lluvia") return fmtLluvia(valor, true);
  return fmtGrados(valor);
}

const numerico = (v: Valor) => (typeof v === "number" ? v : typeof v === "string" ? ORDEN_TORMENTA[v] : null);

// ---------- Textos del mapa ----------

function tituloMapa(variable: Variable, porHoras: boolean, fecha: string | undefined, t: string | undefined): string {
  if (porHoras && t) {
    const cuando = `el ${diaLargo(t)} ${aLas(t)}`;
    const nombre = { temp: "Temperatura", min: "Temperatura", max: "Temperatura", racha: "Rachas", lluvia: "Lluvia", tormenta: "Tormentas" }[variable];
    return `${nombre} ${cuando}`;
  }
  const del = fecha ? `del ${diaLargo(fecha)}` : "";
  switch (variable) {
    case "min":
    case "temp":
      return `Mínimas ${del}`;
    case "max":
      return `Máximas ${del}`;
    case "racha":
      return `Rachas máximas ${del}`;
    case "lluvia":
      return `Lluvia ${del}`;
    case "tormenta":
      return `Tormentas ${fecha ? `el ${diaLargo(fecha)}` : ""}`;
  }
}

/** Frase corta junto a la leyenda (y resumen para lectores de pantalla). */
function notaMapa(zonas: ZonaEndpoint[], valores: Map<string, Valor>, variable: Variable, porHoras: boolean): string {
  const con = zonas.filter((z) => valores.get(z.id) != null);
  if (!con.length) return "Sin datos para este momento";
  const num = (z: ZonaEndpoint) => valores.get(z.id) as number;
  if (variable === "tormenta") {
    const prevista = con.filter((z) => valores.get(z.id) === "prevista").map(enFrase);
    const posible = con.filter((z) => valores.get(z.id) === "posible").map(enFrase);
    if (!prevista.length && !posible.length) return "Sin tormentas en ninguna zona";
    const partes = [];
    if (prevista.length) partes.push(`Tormenta prevista en ${listaY(prevista)}`);
    if (posible.length) partes.push(`${prevista.length ? "posible" : "Posible tormenta"} en ${listaY(posible)}`);
    return partes.join("; ");
  }
  const orden = [...con].sort((a, b) => num(a) - num(b));
  const bajo = orden[0];
  const alto = orden[orden.length - 1];
  if (variable === "lluvia") {
    const mojadas = con.filter((z) => num(z) >= (porHoras ? 0.1 : 0.2));
    if (!mojadas.length) return "Sin lluvia en ninguna zona";
    return `Más lluvia: ${fmtLluvia(num(alto))} en ${enFrase(alto)}`;
  }
  if (variable === "racha") return `Racha más fuerte: ${fmtKmh(num(alto))} en ${enFrase(alto)}`;
  const heladas = variable !== "max" ? con.filter((z) => num(z) <= UMBRAL_HELADA).map(enFrase) : [];
  const calor = variable !== "min" ? con.filter((z) => num(z) >= UMBRAL_CALOR).map(enFrase) : [];
  if (heladas.length) return `Helada en ${listaY(heladas)}`;
  if (calor.length) return `35 °C o más en ${listaY(calor)}`;
  if (variable === "min" && !porHoras) return "Sin heladas en ninguna zona";
  if (variable === "max" && !porHoras) return "Ninguna zona llega a 35 °C";
  return `De ${fmtGrados(num(bajo))} en ${enFrase(bajo)} a ${fmtGrados(num(alto))} en ${enFrase(alto)}`;
}

function resumenMapa(nombre: string, zonas: ZonaEndpoint[], valores: Map<string, Valor>, variable: Variable, titulo: string, porHoras: boolean): string {
  const base = `Término municipal de ${nombre} dividido en ${zonas.length === 1 ? "una zona" : `${zonas.length} zonas`}, coloreadas según ${titulo.charAt(0).toLocaleLowerCase("es") + titulo.slice(1)}.`;
  const con = zonas.filter((z) => typeof valores.get(z.id) === "number");
  let detalle = notaMapa(zonas, valores, variable, porHoras);
  if (variable !== "tormenta" && con.length >= 2) {
    const orden = [...con].sort((a, b) => (valores.get(a.id) as number) - (valores.get(b.id) as number));
    const fmt = (z: ZonaEndpoint) => textoValor(valores.get(z.id) ?? null, variable, true);
    detalle = `De ${fmt(orden[0])} en ${enFrase(orden[0])} a ${fmt(orden[orden.length - 1])} en ${enFrase(orden[orden.length - 1])}. ${detalle}`;
  }
  return `${base} ${detalle}.`;
}

// ---------- Meteograma de una zona ----------

function horasMeteograma(datos: EndpointZonas, z: ZonaEndpoint, desde: number): HoraMeteograma[] {
  return datos.horas.slice(desde).map((t, k) => {
    const i = desde + k;
    const h = z.horas;
    const noche = esNoche(t, z.lat, z.lon);
    return {
      t,
      temp: h.temp[i] ?? null,
      prob: h.prob[i] ?? null,
      precip: h.precip[i] ?? null,
      viento: h.viento[i] ?? null,
      racha: h.racha[i] ?? null,
      dir: h.dir[i] ?? null,
      cielo: cieloWmo(h.wc[i])[0],
      noche,
    };
  });
}

/** Zona por defecto: la pedida si existe; si no, la capital (o la primera). */
function zonaPorDefecto(datos: EndpointZonas, pedida?: string): string | null {
  if (pedida && datos.zonas.some((z) => z.id === pedida)) return pedida;
  return (datos.zonas.find((z) => z.tipo === "capital") ?? datos.zonas[0])?.id ?? null;
}

/** Índice de la primera hora que no ha pasado todavía (las horas del JSON empiezan en la hora del build). */
function primeraHoraVigente(horas: string[]): number {
  const ahora = horaLocal();
  const i = horas.findIndex((t) => t >= ahora);
  return i < 0 ? Math.max(0, horas.length - 1) : i;
}

export default function VistaZonas({ slug, base, version, nombre, zonaInicial, compacto = false }: Props) {
  const ids = useId();
  const idTitulo = `${ids}-titulo`;
  const idTabla = `${ids}-tabla`;
  const idMeteo = `${ids}-meteo`;
  const idHora = `${ids}-hora`;

  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [intento, setIntento] = useState(0);
  const [variable, setVariable] = useState<Variable>("min");
  const [dia, setDia] = useState(0);
  const [porHoras, setPorHoras] = useState(false);
  const [hora, setHora] = useState(0);
  const [zonaSel, setZonaSel] = useState<string | null>(null);

  const caja = useRef<HTMLDivElement>(null);
  const mapa = useRef<Leaflet.Map | null>(null);
  const celdas = useRef(new Map<string, Leaflet.Path>());
  const etiquetas = useRef(new Map<string, Leaflet.Marker>());
  const recolocar = useRef<() => void>(() => {});
  const pintar = useRef<() => void>(() => {});
  const elegirRef = useRef<(id: string) => void>(() => {});

  const datos = estado.tipo === "listo" ? estado.datos : null;

  // ---- Carga del JSON ----
  useEffect(() => {
    const control = new AbortController();
    setEstado({ tipo: "cargando" });
    fetch(`${base}zonas/${slug}.json?v=${encodeURIComponent(version)}`, { signal: control.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as EndpointZonas | null;
        if (!j || !Array.isArray(j.zonas) || !j.zonas.length || !j.contorno) {
          setEstado({ tipo: "sin-zonas" });
          return;
        }
        // Valores iniciales: día de hoy (mañana a última hora), lluvia si llueve algo ese día, la zona pedida
        const ahora = horaLocal();
        let d = 0;
        if (j.dias.length > 1 && j.dias[0] === ahora.slice(0, 10) && Number(ahora.slice(11, 13)) >= 20) d = 1;
        const llueve = j.zonas.some((z) => (z.dias[d]?.lluvia ?? 0) >= 1);
        setDia(d);
        setVariable(llueve ? "lluvia" : "min");
        setPorHoras(false);
        setHora(primeraHoraVigente(j.horas));
        // La zona pedida: la prop o, en la página del municipio, ?zona= de la URL (la página es estática y no la conoce)
        let pedida = zonaInicial;
        if (!pedida && !compacto) {
          try {
            pedida = new URLSearchParams(window.location.search).get("zona") ?? undefined;
          } catch {
            pedida = undefined;
          }
        }
        setZonaSel(zonaPorDefecto(j, pedida));
        setEstado({ tipo: "listo", datos: j });
      })
      .catch((e: unknown) => {
        if (control.signal.aborted) return;
        setEstado({ tipo: "error", motivo: e instanceof Error ? e.message : String(e) });
      });
    return () => control.abort();
    // zonaInicial y compacto solo cuentan al cargar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, slug, version, intento]);

  // ---- Derivados ----
  const inicioHoras = useMemo(() => (datos ? primeraHoraVigente(datos.horas) : 0), [datos]);
  const hayDias = Boolean(datos?.dias.length);
  const hayHoras = Boolean(datos && datos.horas.length > inicioHoras);
  const modoHoras = porHoras && hayHoras;
  const escala = useMemo(() => (datos ? escalaDe(datos, variable, modoHoras) : null), [datos, variable, modoHoras]);
  const valores = useMemo(() => {
    const m = new Map<string, Valor>();
    if (datos) for (const z of datos.zonas) m.set(z.id, valorZona(z, variable, modoHoras, dia, hora));
    return m;
  }, [datos, variable, modoHoras, dia, hora]);
  const fecha = datos?.dias[dia];
  const tHora = datos?.horas[hora];
  const titulo = datos ? tituloMapa(variable, modoHoras, fecha, tHora) : "";
  const zona = datos?.zonas.find((z) => z.id === zonaSel) ?? null;

  // ---- Selección de zona (mapa o tabla) ----
  const elegir = useCallback(
    (id: string) => {
      setZonaSel(id);
      if (compacto || typeof window === "undefined") return;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("vista", "zonas");
        url.searchParams.set("zona", id);
        window.history.replaceState(window.history.state, "", url);
      } catch {
        /* sin history (vista previa): no pasa nada */
      }
    },
    [compacto]
  );
  elegirRef.current = elegir;

  // ---- Mapa: se crea una vez por JSON cargado ----
  useEffect(() => {
    if (!datos || !caja.current) return;
    let cancelado = false;
    let observador: ResizeObserver | null = null;
    const contenedor = caja.current;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelado) return;
      const quieto = menosMovimiento();
      const m = L.map(contenedor, {
        renderer: L.svg({ padding: 0.5 }),
        zoomControl: false,
        attributionControl: false,
        keyboard: false,
        scrollWheelZoom: false,
        zoomSnap: 0.25,
        zoomDelta: 0.5,
        zoomAnimation: !quieto,
        fadeAnimation: !quieto,
        markerZoomAnimation: !quieto,
        inertia: !quieto,
      });
      mapa.current = m;
      crearPanes(m);
      L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar", zoomInText: "+", zoomOutText: "−" }).addTo(m);
      const caja0 = limites(L, datos.contorno as MultiPolygon);
      encuadrarTermino(m, caja0);

      // Celdas de Voronoi (interactivas: al pulsar se elige la zona)
      celdas.current.clear();
      L.geoJSON(datos.celdas as unknown as FeatureCollection, {
        pane: PANES.celdas,
        style: { color: COLOR.basalto, weight: 1, opacity: 1, fillOpacity: 1, fillColor: COLOR.sinDato },
        onEachFeature: (f, capa) => {
          const id = String(f.properties?.id ?? "");
          const path = capa as Leaflet.Path;
          celdas.current.set(id, path);
          path.on("click", () => elegirRef.current(id));
        },
      }).addTo(m);
      capaMascara(L, datos.mascara as MultiPolygon).addTo(m);
      capaContorno(L, datos.contorno as MultiPolygon).addTo(m);

      // Punto de cada zona y su etiqueta
      etiquetas.current.clear();
      for (const z of datos.zonas) {
        L.circleMarker([z.lat, z.lon], {
          pane: PANES.puntos,
          interactive: false,
          radius: 3,
          weight: 1.5,
          color: COLOR.basalto,
          fillColor: COLOR.cal,
          fillOpacity: 1,
        }).addTo(m);
        const marcador = L.marker([z.lat, z.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: "mz-icono", html: "", iconSize: [0, 0] }),
        }).addTo(m);
        etiquetas.current.set(z.id, marcador);
      }

      m.on("zoomend moveend", () => recolocar.current());
      let ultimo = { w: contenedor.clientWidth, h: contenedor.clientHeight };
      observador = new ResizeObserver(() => {
        const w = contenedor.clientWidth;
        const h = contenedor.clientHeight;
        if (!w || !h || (w === ultimo.w && h === ultimo.h)) return;
        ultimo = { w, h };
        encuadrarTermino(m, caja0);
        recolocar.current();
      });
      observador.observe(contenedor);
      pintar.current();
    })();
    return () => {
      cancelado = true;
      observador?.disconnect();
      mapa.current?.remove();
      mapa.current = null;
      celdas.current.clear();
      etiquetas.current.clear();
    };
  }, [datos]);

  // ---- Pintar celdas y etiquetas con la variable, el día y la hora elegidos ----
  pintar.current = () => {
    const m = mapa.current;
    if (!m || !datos) return;
    for (const z of datos.zonas) {
      const path = celdas.current.get(z.id);
      if (!path) continue;
      const elegida = z.id === zonaSel;
      path.setStyle({
        fillColor: colorDe(valores.get(z.id) ?? null, variable, escala),
        color: elegida ? COLOR.almagraClaro : COLOR.basalto,
        weight: elegida ? 3 : 1,
      });
      if (elegida) path.bringToFront();
    }
    recolocar.current();
  };
  recolocar.current = () => {
    const m = mapa.current;
    if (!m || !datos) return;
    const tam = m.getSize();
    const entradas: (EntradaEtiqueta & { nombre: string; valor: string })[] = datos.zonas.map((z) => {
      const p = m.latLngToContainerPoint([z.lat, z.lon]);
      const valorTxt = textoValor(valores.get(z.id) ?? null, variable, true);
      const anchoValor = medirTexto(valorTxt, FUENTE_VALOR);
      return {
        id: z.id,
        x: p.x,
        y: p.y,
        nombre: z.nombre,
        valor: valorTxt,
        ancho: Math.ceil(medirTexto(`${z.nombre} `, FUENTE_ETIQUETA) + anchoValor + RELLENO_ETIQUETA),
        anchoCorto: Math.ceil(anchoValor + RELLENO_ETIQUETA),
        alto: 24,
        fija: z.id === zonaSel,
      };
    });
    // Prioridad: la elegida, la capital, los núcleos por población y el terreno al final
    const peso = (z: ZonaEndpoint) => (z.id === zonaSel ? 3e9 : z.tipo === "capital" ? 2e9 : z.tipo === "nucleo" ? 1e9 + (z.poblacion ?? 0) : -z.altitud);
    const porId = new Map(datos.zonas.map((z) => [z.id, z]));
    entradas.sort((a, b) => peso(porId.get(b.id)!) - peso(porId.get(a.id)!));
    // Los controles de zoom (abajo a la derecha) no se tapan
    const contenedor = m.getContainer();
    const marco = contenedor.getBoundingClientRect();
    const obstaculos = [...contenedor.querySelectorAll(".leaflet-control")].map((c) => {
      const r = c.getBoundingClientRect();
      return { x0: r.left - marco.left, y0: r.top - marco.top, x1: r.right - marco.left, y1: r.bottom - marco.top };
    });
    const colocacion = colocarEtiquetas(entradas, tam.x, tam.y, obstaculos);
    for (const e of entradas) {
      const el = etiquetas.current.get(e.id)?.getElement();
      if (!el) continue;
      const c = colocacion.get(e.id)!;
      const sel = e.id === zonaSel ? " mz-et-sel" : "";
      const oculta = c.modo === "oculta" ? " mz-et-oculta" : "";
      const texto = c.modo === "completa" ? `${escaparHtml(e.nombre)} <strong>${escaparHtml(e.valor)}</strong>` : `<strong>${escaparHtml(e.valor)}</strong>`;
      el.innerHTML = `<span class="mz-et mz-et-${c.lado}${sel}${oculta}" aria-hidden="true">${texto}</span>`;
    }
  };

  useEffect(() => {
    pintar.current();
  }, [datos, valores, variable, escala, zonaSel]);

  // ---- Controles ----
  const cambiarModo = (horas: boolean) => {
    if (horas === modoHoras || !datos) return;
    if (horas) {
      setVariable((v) => (v === "min" || v === "max" ? "temp" : v));
      // Al pasar a horas, la primera hora vigente del día elegido (o la siguiente)
      const f = datos.dias[dia];
      const i = datos.horas.findIndex((t, k) => k >= inicioHoras && (!f || t.slice(0, 10) >= f));
      setHora(i >= 0 ? i : inicioHoras);
    } else {
      setVariable((v) => (v === "temp" ? "min" : v));
      const f = datos.horas[hora]?.slice(0, 10);
      const j = datos.dias.indexOf(f ?? "");
      if (j >= 0) setDia(j);
    }
    setPorHoras(horas);
  };
  const elegirDia = (j: number) => {
    setDia(j);
    if (modoHoras && datos) {
      const f = datos.dias[j];
      const delDia = datos.horas.map((t, k) => [t, k] as const).filter(([t, k]) => k >= inicioHoras && t.startsWith(f));
      const mediodia = delDia.find(([t]) => t.slice(11, 13) === "14");
      setHora((mediodia ?? delDia[0])?.[1] ?? hora);
    }
  };
  const moverHora = (i: number) => {
    setHora(i);
    if (datos) {
      const j = datos.dias.indexOf(datos.horas[i]?.slice(0, 10) ?? "");
      if (j >= 0) setDia(j);
    }
  };

  // ---- Render ----
  const variables = modoHoras ? VARIABLES_HORA : VARIABLES_DIA;
  const nota = datos ? notaMapa(datos.zonas, valores, variable, modoHoras) : "";
  const resumen = datos ? resumenMapa(nombre, datos.zonas, valores, variable, titulo, modoHoras) : "";
  const diaPulsado = modoHoras ? datos?.dias.indexOf(tHora?.slice(0, 10) ?? "") ?? -1 : dia;
  const enlaceMunicipio = `${base}${slug}/${datos && datos.zonas.length >= 2 && zonaSel ? `?vista=zonas&zona=${encodeURIComponent(zonaSel)}` : ""}`;

  const panel = (
    <div className="vz-panel sobre-oscuro">
      <div className="vz-fila">
        <h2 id={idTitulo} className="titular vz-titulo">
          {datos ? (compacto ? `${titulo} en ${nombre}` : titulo) : `${nombre} por zonas`}
        </h2>
        {datos && hayDias && (
          <div className="chips" role="group" aria-label="Día">
            {datos.dias.map((f, j) => (
              <button key={f} type="button" aria-pressed={diaPulsado === j} onClick={() => elegirDia(j)} aria-label={diaConNumero(f)}>
                {diaConNumero(f, true)}
              </button>
            ))}
          </div>
        )}
      </div>

      {datos && hayDias && (
        <div className="vz-fila">
          <div className="chips" role="group" aria-label="Qué mostrar">
            {variables.map((v) => (
              <button key={v.id} type="button" aria-pressed={variable === v.id} onClick={() => setVariable(v.id)}>
                {v.texto}
              </button>
            ))}
          </div>
          {hayHoras && (
            <div className="chips" role="group" aria-label="Periodo">
              <button type="button" aria-pressed={!modoHoras} onClick={() => cambiarModo(false)}>
                Todo el día
              </button>
              <button type="button" aria-pressed={modoHoras} onClick={() => cambiarModo(true)}>
                Hora a hora
              </button>
            </div>
          )}
        </div>
      )}

      {datos && modoHoras && (
        <div className="vz-horas">
          <label htmlFor={idHora}>Hora</label>
          <input
            id={idHora}
            className="deslizador"
            type="range"
            min={inicioHoras}
            max={datos.horas.length - 1}
            step={1}
            value={hora}
            aria-valuetext={tHora ? `${diaConNumero(tHora)}, ${tHora.slice(11, 16)}` : undefined}
            onChange={(e) => moverHora(Number(e.currentTarget.value))}
          />
          <output htmlFor={idHora} aria-live="off">
            {tHora ? `${diaConNumero(tHora, true)}, ${tHora.slice(11, 16)}` : ""}
          </output>
        </div>
      )}

      <figure className="m-0" aria-labelledby={idTitulo}>
        <div className="mz-caja">
          <div ref={caja} className="mz-mapa" />
          {estado.tipo === "cargando" && (
            <div className="mz-estado" role="status">
              <p>Cargando las zonas de {nombre}…</p>
            </div>
          )}
          {estado.tipo === "error" && (
            <div className="mz-estado" role="alert">
              <p>No se ha podido cargar el mapa por zonas de {nombre}. Puede ser un fallo de conexión: vuelve a intentarlo dentro de un momento.</p>
              <button type="button" className="boton-claro" onClick={() => setIntento((n) => n + 1)}>
                Reintentar
              </button>
            </div>
          )}
          {estado.tipo === "sin-zonas" && (
            <div className="mz-estado" role="status">
              <p>{nombre} no tiene zonas de predicción. La previsión del municipio está en la vista general.</p>
            </div>
          )}
        </div>
        {datos && <figcaption className="sr-only">{resumen}</figcaption>}
      </figure>

      {datos && !hayDias && (
        <p className="vz-nota-mapa m-0" role="status">
          Ahora mismo no hay previsión por zonas para {nombre}: el modelo no se ha podido descargar. La previsión del municipio sigue en la vista general.
        </p>
      )}

      {datos && hayDias && (
        <div className="vz-fila">
          {variable === "tormenta" ? (
            <div className="leyenda" role="group" aria-label="Leyenda: tormenta">
              {(["no", "posible", "prevista"] as const).map((n) => (
                <div key={n}>
                  <span className="muestra" style={{ background: COLOR_TORMENTA[n] }} />
                  <span>{TEXTO_TORMENTA[n]}</span>
                </div>
              ))}
            </div>
          ) : escala ? (
            <div className="leyenda" role="group" aria-label={`Leyenda: ${variable === "racha" ? "rachas en km/h" : variable === "lluvia" ? "lluvia en milímetros" : "temperatura en grados"}`}>
              {escala.muestras.map((s) => (
                <div key={s.etiqueta}>
                  <span className="muestra" style={{ background: s.color }} />
                  <span>{s.etiqueta}</span>
                </div>
              ))}
              {escala.especiales.map((s) => (
                <div key={s.etiqueta} className="ml-3">
                  <span className="muestra" style={{ background: s.color }} />
                  <span>{s.etiqueta}</span>
                </div>
              ))}
            </div>
          ) : null}
          <span className="vz-nota-mapa">{nota}</span>
        </div>
      )}

      {compacto && datos && (
        <>
          <ul className="sr-only">
            {datos.zonas.map((z) => (
              <li key={z.id}>
                {z.nombre}: {textoValor(valores.get(z.id) ?? null, variable, true)}
              </li>
            ))}
          </ul>
          <p className="m-0">
            <a className="boton-claro" href={enlaceMunicipio}>
              Ver la página de {nombre}
            </a>
          </p>
        </>
      )}
    </div>
  );

  if (compacto) return <div className="vz vz-compacto">{panel}</div>;

  return (
    <div className="vz">
      <section className="vz-cuerpo" aria-labelledby={idTitulo}>
        {panel}
        {datos && (
          <div className="vz-lado">
            <h2 id={idTabla} className="titular vz-titulo">
              {datos.zonas.length === 1 ? nombre : `Las ${datos.zonas.length} zonas`}
              {modoHoras && tHora ? `, el ${diaLargo(tHora)} ${aLas(tHora)}` : fecha ? `, el ${diaLargo(fecha)}` : ""}
            </h2>
            {hayDias ? (
              <TablaZonas
                datos={datos}
                porHoras={modoHoras}
                dia={dia}
                hora={hora}
                valores={valores}
                zonaSel={zonaSel}
                onElegir={elegir}
                idTitulo={idTabla}
              />
            ) : (
              <ul className="m-0 pl-5">
                {datos.zonas.map((z) => (
                  <li key={z.id}>
                    {z.nombre}, {fmtAltitud(z.altitud)}
                  </li>
                ))}
              </ul>
            )}
            {zona && hayHoras && (
              <a className="boton" href={`#${idMeteo}`}>
                Ver {zona.nombre} hora a hora
              </a>
            )}
            <p className="nota m-0">
              Estimación por zonas del modelo Open-Meteo, con celdas de unos 6 km y la temperatura corregida por altitud. El detalle llega a{" "}
              {datos.dias.length === 1 ? "1 día" : `${datos.dias.length || 5} días`}. La predicción oficial de AEMET es para el municipio entero
              {datos.actualizado ? `. Datos del modelo descargados el ${textoActualizacion(datos.actualizado)}.` : "."}
            </p>
          </div>
        )}
      </section>

      {datos && zona && hayHoras && (
        <div id={idMeteo} className="vz-meteograma" tabIndex={-1}>
          <Meteograma key={zona.id} horas={horasMeteograma(datos, zona, inicioHoras)} titulo={`${zona.nombre} hora a hora`} />
          <p className="nota m-0">
            {zona.tipo === "capital" ? "Núcleo principal" : zona.tipo === "nucleo" ? "Núcleo de población" : "Zona sin núcleo"}, a {fmtAltitud(zona.altitud)}.
            Previsión de Open-Meteo para este punto; AEMET no da predicción propia por zonas.
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Tabla de zonas (alternativa accesible al mapa) ----------

type PropsTabla = {
  datos: EndpointZonas;
  porHoras: boolean;
  dia: number;
  hora: number;
  valores: Map<string, Valor>;
  zonaSel: string | null;
  onElegir: (id: string) => void;
  idTitulo: string;
};

function TablaZonas({ datos, porHoras, dia, hora, valores, zonaSel, onElegir, idTitulo }: PropsTabla) {
  // Orden: de más a menos según lo que enseña el mapa (sin dato al final); a igualdad, el orden de las zonas
  const filas = datos.zonas
    .map((z, k) => ({ z, k, v: numerico(valores.get(z.id) ?? null) }))
    .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity) || a.k - b.k)
    .map((f) => f.z);

  const sub = (z: ZonaEndpoint) => `${fmtAltitud(z.altitud)}${z.tipo === "capital" ? ", capital" : z.tipo === "terreno" ? ", sin núcleo" : ""}`;

  // Extremos para destacar
  const extremo = (vals: (number | null)[], mayor: boolean) => {
    const v = vals.filter((x): x is number => x != null);
    return v.length >= 2 ? (mayor ? Math.max(...v) : Math.min(...v)) : null;
  };

  if (porHoras) {
    const tormentas = datos.zonas.map((z) => tormentaHora(z.horas.wc[hora], z.horas.cape[hora], z.horas.prob[hora]));
    const conTormenta = tormentas.some((t) => t !== "no");
    const tMin = extremo(datos.zonas.map((z) => z.horas.temp[hora]), false);
    const tMax = extremo(datos.zonas.map((z) => z.horas.temp[hora]), true);
    const rMax = extremo(datos.zonas.map((z) => z.horas.racha[hora]), true);
    const lMax = extremo(datos.zonas.map((z) => z.horas.precip[hora]), true);
    return (
      <div className="tabla-desplazable">
        <table className="tabla vz-tabla" aria-labelledby={idTitulo}>
          <thead>
            <tr>
              <th scope="col">Zona</th>
              <th scope="col" className="num">
                Temp.
              </th>
              <th scope="col" className="num">
                Viento / rachas
              </th>
              <th scope="col" className="num">
                Lluvia
              </th>
              {conTormenta && (
                <th scope="col" className="num">
                  Tormenta
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filas.map((z) => {
              const t = z.horas.temp[hora];
              const r = z.horas.racha[hora];
              const l = z.horas.precip[hora];
              const tor = tormentas[datos.zonas.indexOf(z)];
              return (
                <tr key={z.id} className={z.id === zonaSel ? "destacada" : undefined}>
                  <th scope="row">
                    <BotonZona z={z} sub={sub(z)} elegida={z.id === zonaSel} onElegir={onElegir} />
                  </th>
                  <td className={`num${t != null && t === tMin && tMin !== tMax ? " text-helada-texto font-bold" : t != null && t === tMax && tMin !== tMax ? " texto-almagra font-bold" : ""}`}>
                    {fmtGrados(t)}
                  </td>
                  <td className={`num${r != null && r === rMax && r > 0 ? " texto-almagra font-bold" : ""}`}>
                    {fmtKmh(z.horas.viento[hora], false)} / {fmtKmh(r, false)}
                  </td>
                  <td className={`num${l != null && l > 0 ? ` texto-lluvia${l === lMax ? " font-bold" : ""}` : ""}`}>{fmtLluvia(l)}</td>
                  {conTormenta && <td className={`num${tor !== "no" ? " texto-almagra font-bold" : ""}`}>{TEXTO_TORMENTA[tor]}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  const d = (z: ZonaEndpoint) => z.dias[dia];
  const conTormenta = datos.zonas.some((z) => d(z) && d(z).tormenta !== "no");
  const minMin = extremo(datos.zonas.map((z) => d(z)?.min ?? null), false);
  const maxMax = extremo(datos.zonas.map((z) => d(z)?.max ?? null), true);
  const rMax = extremo(datos.zonas.map((z) => d(z)?.racha ?? null), true);
  const lMax = extremo(datos.zonas.map((z) => d(z)?.lluvia ?? null), true);
  return (
    <div className="tabla-desplazable">
      <table className="tabla vz-tabla" aria-labelledby={idTitulo}>
        <thead>
          <tr>
            <th scope="col">Zona</th>
            <th scope="col" className="num">
              Mín / máx
            </th>
            <th scope="col" className="num">
              Rachas
            </th>
            <th scope="col" className="num">
              Lluvia
            </th>
            {conTormenta && (
              <th scope="col" className="num">
                Tormenta
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {filas.map((z) => {
            const x = d(z);
            const frio = x?.min != null && x.min === minMin;
            const calido = x?.max != null && x.max === maxMax;
            return (
              <tr key={z.id} className={z.id === zonaSel ? "destacada" : undefined}>
                <th scope="row">
                  <BotonZona z={z} sub={sub(z)} elegida={z.id === zonaSel} onElegir={onElegir} />
                </th>
                <td className="num">
                  <span className={frio || x?.helada ? "text-helada-texto font-bold" : undefined}>{fmtGrados(x?.min)}</span>
                  {" / "}
                  <span className={calido || x?.calor ? "texto-almagra font-bold" : undefined}>{fmtGrados(x?.max)}</span>
                  {x?.helada && <span className="sr-only"> (helada)</span>}
                </td>
                <td className={`num${x?.racha != null && x.racha === rMax ? " texto-almagra font-bold" : ""}`}>{fmtKmh(x?.racha, false)}</td>
                <td className={`num${x?.lluvia != null && x.lluvia > 0 ? ` texto-lluvia${x.lluvia === lMax ? " font-bold" : ""}` : ""}`}>
                  {fmtLluvia(x?.lluvia)}
                </td>
                {conTormenta && <td className={`num${x && x.tormenta !== "no" ? " texto-almagra font-bold" : ""}`}>{x ? TEXTO_TORMENTA[x.tormenta] : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BotonZona({ z, sub, elegida, onElegir }: { z: ZonaEndpoint; sub: string; elegida: boolean; onElegir: (id: string) => void }) {
  return (
    <button type="button" className="vz-zona" aria-pressed={elegida} onClick={() => onElegir(z.id)}>
      <span className="vz-zona-nombre">{z.nombre}</span>
      <span className="vz-zona-sub">{sub}</span>
    </button>
  );
}
