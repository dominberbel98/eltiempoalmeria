// Buscador de municipios y núcleos de población de Almería (isla client:idle).
// Carga /buscar.json la primera vez que se enfoca el campo (o al pulsar "Usar mi ubicación").
// Un núcleo lleva a /{municipio}/?vista=zonas&zona={id} si el municipio tiene vista por zonas.
// Los resultados son enlaces reales: con las flechas se pasa del campo a la lista y Escape vuelve al campo.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";

/** Entrada de /buscar.json (src/pages/buscar.json.ts) */
type Entrada = { n: string; m: string; z: string | null; t: "municipio" | "nucleo"; a?: string[]; p?: [number, number] };
/** Formato antiguo, aún aceptado: lista de municipios que se usa mientras no se ha cargado /buscar.json */
type MunicipioSimple = { nombre: string; slug: string; lat: number; lon: number };

type Props = {
  /** BASE_URL del sitio (por defecto "/") */
  base?: string;
  /** meta.updatedAt: se añade como ?v= a /buscar.json para no servir una copia vieja de la caché */
  version?: string;
  placeholder?: string;
  /** Texto de la etiqueta (oculta a la vista) del campo */
  etiqueta?: string;
  /** Muestra el botón de geolocalización (por defecto, sí) */
  ubicacion?: boolean;
  municipios?: MunicipioSimple[];
};

type Indexada = Entrada & { nn: string; palabras: string[]; aa: string[]; municipioNombre: string };
type Resultado = { e: Indexada; alias: string | null; puntos: number };

const MAX_RESULTADOS = 10;

const normalizar = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();

const empiezaPalabra = (texto: string, q: string) => texto.startsWith(q) || texto.includes(` ${q}`);

function indexar(lista: Entrada[]): Indexada[] {
  const nombres = new Map(lista.filter((e) => e.t === "municipio").map((e) => [e.m, e.n]));
  return lista.map((e) => {
    const nn = normalizar(e.n);
    return { ...e, nn, palabras: nn.split(" "), aa: (e.a ?? []).map(normalizar), municipioNombre: nombres.get(e.m) ?? "" };
  });
}

// Menos puntos = mejor coincidencia. A igualdad, primero los municipios y luego el orden del índice (núcleos por población).
function puntuar(e: Indexada, q: string, tokens: string[]): Resultado | null {
  const base = e.t === "municipio" ? 0 : 0.5;
  if (e.nn === q) return { e, alias: null, puntos: base };
  if (e.nn.startsWith(q)) return { e, alias: null, puntos: 1 + base };
  if (empiezaPalabra(e.nn, q)) return { e, alias: null, puntos: 2 + base };
  const i = e.aa.findIndex((a) => a === q || empiezaPalabra(a, q));
  if (i >= 0) return { e, alias: e.a![i], puntos: 3 + base };
  if (q.length >= 3 && e.nn.includes(q)) return { e, alias: null, puntos: 4 + base };
  // Varias palabras: "san jose nijar" o "toyo almeria"
  if (tokens.length > 1) {
    const textos = [e.nn, normalizar(e.municipioNombre), ...e.aa];
    const casa = (t: string) => textos.some((x) => empiezaPalabra(x, t));
    if (tokens.every(casa)) {
      const alias = e.a?.find((_, j) => tokens.some((t) => empiezaPalabra(e.aa[j], t))) ?? null;
      return { e, alias: alias && !tokens.some((t) => empiezaPalabra(e.nn, t)) ? alias : null, puntos: 5 + base };
    }
  }
  return null;
}

const enlace = (base: string, e: Entrada) => `${base}${e.m}/${e.t === "nucleo" && e.z ? `?vista=zonas&zona=${encodeURIComponent(e.z)}` : ""}`;
const titulo = (e: Indexada) => (e.t === "nucleo" && e.municipioNombre ? `${e.n}, ${e.municipioNombre}` : e.n);

// Límites aproximados de la provincia de Almería
const DENTRO = (lat: number, lon: number) => lat >= 36.6 && lat <= 37.95 && lon >= -3.2 && lon <= -1.55;

export default function Buscador({
  base = "/",
  version,
  placeholder = "Busca tu municipio",
  etiqueta = "Buscar un municipio o núcleo de Almería",
  ubicacion = true,
  municipios,
}: Props) {
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [indice, setIndice] = useState<Indexada[] | null>(null);
  const [estado, setEstado] = useState<"" | "cargando" | "error">("");
  const [aviso, setAviso] = useState("");
  const carga = useRef<Promise<Indexada[] | null> | null>(null);
  const caja = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLUListElement>(null);
  const id = useId();
  const idLista = `${id}-resultados`;
  const idEstado = `${id}-estado`;

  // Respaldo mientras no llega /buscar.json (o si falla): solo municipios
  const respaldo = useMemo(
    () => (municipios?.length ? indexar(municipios.map((m) => ({ n: m.nombre, m: m.slug, z: null, t: "municipio" as const, p: [m.lat, m.lon] as [number, number] }))) : []),
    [municipios],
  );

  function cargar(): Promise<Indexada[] | null> {
    if (!carga.current) {
      setEstado("cargando");
      const url = `${base}buscar.json${version ? `?v=${encodeURIComponent(version)}` : ""}`;
      carga.current = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<Entrada[]>;
        })
        .then((datos) => {
          const ix = indexar(datos);
          setIndice(ix);
          setEstado("");
          return ix;
        })
        .catch(() => {
          carga.current = null; // se puede reintentar al volver a enfocar
          setEstado("error");
          return null;
        });
    }
    return carga.current;
  }

  const datos = indice ?? respaldo;
  const resultados = useMemo<Resultado[]>(() => {
    const n = normalizar(q);
    if (!n) return [];
    const tokens = n.split(" ").filter(Boolean);
    const r: Resultado[] = [];
    for (const e of datos) {
      const x = puntuar(e, n, tokens);
      if (x) r.push(x);
    }
    // sort es estable: a igualdad de puntos se mantiene el orden del índice
    return r.sort((a, b) => a.puntos - b.puntos).slice(0, MAX_RESULTADOS);
  }, [q, datos]);

  // Cierra la lista al hacer clic fuera
  useEffect(() => {
    if (!abierto) return;
    const fuera = (ev: PointerEvent) => {
      if (caja.current && !caja.current.contains(ev.target as Node)) setAbierto(false);
    };
    document.addEventListener("pointerdown", fuera);
    return () => document.removeEventListener("pointerdown", fuera);
  }, [abierto]);

  const enlaces = () => Array.from(lista.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);

  function teclaCampo(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "ArrowDown" && resultados.length) {
      ev.preventDefault();
      setAbierto(true);
      requestAnimationFrame(() => enlaces()[0]?.focus());
    } else if (ev.key === "Escape") {
      if (abierto && q) {
        ev.stopPropagation(); // que Base no cierre también el panel del buscador en móvil
        setAbierto(false);
      }
    }
  }

  function teclaLista(ev: KeyboardEvent<HTMLUListElement>) {
    const todos = enlaces();
    const i = todos.indexOf(document.activeElement as HTMLAnchorElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      todos[Math.min(i + 1, todos.length - 1)]?.focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (i <= 0) campo.current?.focus();
      else todos[i - 1]?.focus();
    } else if (ev.key === "Home") {
      ev.preventDefault();
      todos[0]?.focus();
    } else if (ev.key === "End") {
      ev.preventDefault();
      todos.at(-1)?.focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setAbierto(false);
      campo.current?.focus();
    }
  }

  function enviar(ev: SyntheticEvent<HTMLFormElement>) {
    ev.preventDefault();
    const primero = resultados[0];
    if (primero) window.location.assign(enlace(base, primero.e));
    else if (q.trim()) setAbierto(true);
  }

  async function localizar() {
    if (!("geolocation" in navigator)) {
      setAviso("Tu navegador no permite la geolocalización. Escribe el nombre de tu municipio.");
      return;
    }
    setAviso("Buscando el lugar más cercano a ti…");
    const ix = (await cargar()) ?? respaldo;
    if (!ix.length) {
      setAviso("No se ha podido cargar la lista de municipios. Prueba a recargar la página.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude: lat, longitude: lon } }) => {
        if (!DENTRO(lat, lon)) {
          setAviso("Tu ubicación está fuera de la provincia de Almería. Busca un municipio por su nombre.");
          return;
        }
        // La posición se usa solo aquí, en el navegador; no se envía a ningún sitio
        const k = Math.cos((lat * Math.PI) / 180);
        let mejor: Indexada | null = null;
        let dMejor = Infinity;
        for (const e of ix) {
          if (!e.p) continue;
          const d = ((e.p[1] - lon) * k) ** 2 + (e.p[0] - lat) ** 2;
          if (d < dMejor) {
            dMejor = d;
            mejor = e;
          }
        }
        if (!mejor) {
          setAviso("No se ha encontrado ningún lugar cercano. Busca tu municipio por su nombre.");
          return;
        }
        setAviso(`Lo más cercano a ti: ${titulo(mejor)}.`);
        window.location.assign(enlace(base, mejor));
      },
      (err) =>
        setAviso(
          err.code === err.PERMISSION_DENIED
            ? "No has dado permiso para usar tu ubicación. Puedes escribir el nombre de tu municipio."
            : "No se ha podido saber tu ubicación. Puedes escribir el nombre de tu municipio.",
        ),
      { timeout: 10000, maximumAge: 300000 },
    );
  }

  const hayTexto = normalizar(q).length > 0;
  const mostrar = abierto && hayTexto;
  const mensajeEstado = !hayTexto
    ? ""
    : estado === "cargando" && !indice
      ? "Cargando municipios y núcleos…"
      : resultados.length
        ? `${resultados.length} ${resultados.length === 1 ? "resultado" : "resultados"}`
        : estado === "error" && !respaldo.length
          ? "No se ha podido cargar el buscador. Prueba a recargar la página."
          : "Ningún municipio ni núcleo de Almería coincide con ese nombre.";

  return (
    <div ref={caja} className="relative w-full">
      <form
        role="search"
        onSubmit={enviar}
        className="flex items-center gap-2 rounded-[6px] border border-linea bg-blanco py-1 pr-1 pl-3.5 has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-almagra"
      >
        <label htmlFor={`${id}-campo`} className="sr-only">
          {etiqueta}
        </label>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0 text-ceniza">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={campo}
          id={`${id}-campo`}
          type="search"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-controls={idLista}
          aria-describedby={idEstado}
          value={q}
          placeholder={placeholder}
          onChange={(ev) => {
            setQ(ev.target.value);
            setAbierto(true);
            if (!indice) void cargar(); // por si se escribe sin que haya llegado el evento de foco (autorrelleno, dictado)
          }}
          onFocus={() => {
            setAbierto(true);
            void cargar();
          }}
          onKeyDown={teclaCampo}
          className="min-h-11 min-w-0 flex-1 border-0 bg-transparent py-2 text-base text-basalto placeholder:text-ceniza focus-visible:outline-none"
        />
        {ubicacion && (
          <button
            type="button"
            onClick={localizar}
            aria-label="Usar mi ubicación"
            title="Usar mi ubicación"
            className="flex size-11 shrink-0 items-center justify-center rounded-[4px] bg-cal text-basalto hover:bg-niebla"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </button>
        )}
      </form>

      <p id={idEstado} className="sr-only" role="status">
        {mostrar ? mensajeEstado : ""}
      </p>

      <div
        hidden={!mostrar}
        className="absolute inset-x-0 top-full z-[1100] mt-1 max-h-[min(70vh,28rem)] overflow-y-auto rounded-[4px] border border-linea bg-blanco text-basalto"
      >
        {resultados.length ? (
          <ul ref={lista} id={idLista} aria-label="Resultados de la búsqueda" onKeyDown={teclaLista} className="m-0 list-none p-0">
            {resultados.map(({ e, alias }) => (
              <li key={`${e.t}-${e.m}-${e.n}`} className="border-t border-linea first:border-t-0">
                <a
                  href={enlace(base, e)}
                  className="flex min-h-11 flex-col justify-center px-4 py-2 no-underline hover:bg-cal hover:text-basalto focus-visible:bg-cal focus-visible:outline-offset-[-3px]"
                >
                  <span className="font-semibold">{titulo(e)}</span>
                  <span className="text-sm text-ceniza">
                    {alias ? `Incluye ${alias}` : e.t === "municipio" ? "Municipio" : "Núcleo de población"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p id={idLista} className="m-0 px-4 py-3 text-[15px] text-ceniza">
            {mensajeEstado}
          </p>
        )}
      </div>

      {aviso && (
        <p className="mt-2 text-sm text-ceniza" role="status">
          {aviso}
        </p>
      )}
    </div>
  );
}
