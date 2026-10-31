// "Tus municipios": favoritos guardados solo en este navegador (localStorage).
import { useEffect, useState } from "react";

const CLAVE = "almeria-favoritos";

function leer(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(CLAVE) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function guardar(lista: string[]) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(lista));
  } catch {
    // Modo privado o almacenamiento bloqueado: el favorito no persiste, pero la página sigue funcionando
  }
}

function Estrella({ llena }: { llena: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={llena ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" />
    </svg>
  );
}

// Botón "Guardar en tus municipios" (pastilla con aria-pressed). `className` permite, p. ej., ocupar todo el ancho en móvil.
export function BotonFavorito({ slug, nombre, className = "" }: { slug: string; nombre: string; className?: string }) {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => setFavs(leer()), []);
  const es = favs.includes(slug);
  return (
    <button
      type="button"
      className={`boton-pastilla ${className}`.trim()}
      aria-pressed={es}
      title={es ? `Quitar ${nombre} de tus municipios` : `Guardar ${nombre} en tus municipios`}
      onClick={() => {
        const siguiente = es ? leer().filter((x) => x !== slug) : [...leer().filter((x) => x !== slug), slug];
        setFavs(siguiente);
        guardar(siguiente);
      }}
    >
      <Estrella llena={es} />
      {es ? "Guardado en tus municipios" : "Guardar en tus municipios"}
    </button>
  );
}
