// "Tus municipios" de la portada: los favoritos guardados en este navegador (misma clave que Favoritos.tsx),
// con su temperatura de ahora calculada en el build. Sin favoritos, solo se ve la explicación.
import { useEffect, useState } from "react";

const CLAVE = "almeria-favoritos";

type Item = { slug: string; nombre: string; temp: number | null };
type Props = { base: string; municipios: Item[] };

function leer(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // modo privado o almacenamiento bloqueado
  }
}

export default function TusMunicipios({ base, municipios }: Props) {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    setFavs(leer());
    const alCambiar = (e: StorageEvent) => {
      if (e.key === CLAVE) setFavs(leer());
    };
    window.addEventListener("storage", alCambiar);
    return () => window.removeEventListener("storage", alCambiar);
  }, []);
  const lista = favs.map((s) => municipios.find((m) => m.slug === s)).filter((m): m is Item => Boolean(m));

  return (
    <>
      <p className="texto-secundario tus-texto">
        {lista.length
          ? "Los que has marcado con la estrella, guardados solo en este navegador."
          : "Marca la estrella en la página de un municipio y aparecerá aquí, solo en este navegador."}
      </p>
      {lista.length > 0 && (
        <ul className="tus-lista">
          {lista.map((m) => (
            <li key={m.slug}>
              <a className="boton-pastilla" href={`${base}${m.slug}/`}>
                {m.nombre}
                {m.temp != null && <span className="cifra">{` ${Math.round(m.temp)}°`}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
