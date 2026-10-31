// Animación de las últimas imágenes del radar de AEMET (isla client:visible de /radar/).
// Sin JavaScript se ve la imagen más reciente. El deslizador elige la imagen; el botón reproduce o pausa.
// La reproducción solo empieza al pulsar el botón; con prefers-reduced-motion va más despacio.
import { useEffect, useId, useRef, useState } from "react";

export type FotogramaRadar = {
  src: string;
  alt: string;
  /** "14:10" o "hacia las 14:10" */
  etiquetaHora: string;
  /** "30 de octubre" */
  fechaMadrid: string;
  /** "30 de octubre de 2026, 14:10 (hora peninsular)" */
  textoCompleto: string;
  /** "Ahora", "−15 min", "−1 h 45" respecto a la última imagen */
  relativa: string;
};

type Props = { imagenes: FotogramaRadar[]; ancho: number; alto: number };

const PASO_MS = 800;
const PASO_LENTO_MS = 1600; // prefers-reduced-motion
const PAUSA_FINAL_MS = 1600; // la última imagen se queda un poco más antes de volver a empezar

export default function RadarAnimacion({ imagenes, ancho, alto }: Props) {
  const n = imagenes.length;
  const [i, setI] = useState(Math.max(0, n - 1));
  const [reproduciendo, setReproduciendo] = useState(false);
  const precargadas = useRef(false);
  const id = useId();

  // Precarga las imágenes la primera vez que se va a necesitar otra distinta de la última
  const precargar = () => {
    if (precargadas.current) return;
    precargadas.current = true;
    for (const im of imagenes) {
      const img = new Image();
      img.src = im.src;
    }
  };

  useEffect(() => {
    if (!reproduciendo || n < 2) return;
    const lento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const paso = lento ? PASO_LENTO_MS : PASO_MS;
    const t = window.setTimeout(() => setI((x) => (x + 1) % n), i === n - 1 ? Math.max(paso, PAUSA_FINAL_MS) : paso);
    return () => window.clearTimeout(t);
  }, [reproduciendo, i, n]);

  // Pausa si la pestaña deja de verse
  useEffect(() => {
    const oculta = () => {
      if (document.hidden) setReproduciendo(false);
    };
    document.addEventListener("visibilitychange", oculta);
    return () => document.removeEventListener("visibilitychange", oculta);
  }, []);

  if (!n) return null;
  const actual = imagenes[Math.min(i, n - 1)];
  const ultima = i === n - 1;

  const alternar = () => {
    precargar();
    if (!reproduciendo && ultima) setI(0); // desde la última, la animación empieza por la más antigua
    setReproduciendo(!reproduciendo);
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <figure className="m-0 flex justify-center rounded-[4px] bg-blanco p-2 md:p-3">
        <img
          src={actual.src}
          alt={actual.alt}
          width={ancho}
          height={alto}
          fetchPriority="high"
          decoding="async"
          className="block h-auto w-full max-w-[720px] [image-rendering:pixelated]"
        />
      </figure>

      {n > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="boton-reproducir"
            onClick={alternar}
            aria-label={reproduciendo ? "Pausar la animación" : `Reproducir las ${n} imágenes guardadas`}
          >
            {reproduciendo ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
          <label htmlFor={`${id}-imagen`} className="sr-only">
            Imagen del radar
          </label>
          <input
            id={`${id}-imagen`}
            type="range"
            className="deslizador"
            min={0}
            max={n - 1}
            step={1}
            value={i}
            aria-valuetext={`${actual.textoCompleto}${ultima ? ", la más reciente" : ""}`}
            onPointerDown={precargar}
            onKeyDown={precargar}
            onChange={(ev) => {
              setReproduciendo(false);
              setI(Number(ev.target.value));
            }}
          />
          <output htmlFor={`${id}-imagen`} aria-live={reproduciendo ? "off" : "polite"} className="flex min-w-[9rem] flex-col leading-tight">
            <span className="cifra text-[28px]">{actual.etiquetaHora}</span>
            <span className="text-sm text-suave-oscuro">{ultima ? `${actual.fechaMadrid}, la más reciente` : actual.fechaMadrid}</span>
          </output>
        </div>
      )}

      {n > 1 ? (
        <ol
          aria-label="Imágenes guardadas"
          className="m-0 grid list-none gap-1 p-0 text-center text-[13px] text-suave-oscuro"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {imagenes.map((im, j) => (
            <li
              key={im.src}
              onClick={() => {
                precargar();
                setReproduciendo(false);
                setI(j);
              }}
              aria-current={j === i ? "true" : undefined}
              className={`cursor-pointer border-t-[3px] pt-1.5 ${j === i ? "border-almagra font-bold text-cal" : "border-borde-oscuro"}`}
            >
              {im.relativa}
              <span className="sr-only">, {im.textoCompleto}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-[15px] text-suave-oscuro">
          Imagen del {actual.textoCompleto}. Solo hay una imagen guardada, así que no hay animación.
        </p>
      )}
    </div>
  );
}
