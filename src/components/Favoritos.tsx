// Favoritos guardados solo en este navegador (localStorage)
import { useEffect, useState } from "react";
import { Star } from "lucide-react";

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
    // modo privado o almacenamiento bloqueado: el favorito no persiste, pero la página sigue funcionando
  }
}

export function BotonFavorito({ slug, nombre }: { slug: string; nombre: string }) {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => setFavs(leer()), []);
  const es = favs.includes(slug);
  return (
    <button
      type="button"
      className={"favorite " + (es ? "is-favorite" : "")}
      aria-pressed={es}
      aria-label={es ? `Quitar ${nombre} de favoritos` : `Añadir ${nombre} a favoritos`}
      onClick={() => {
        const next = es ? favs.filter((x) => x !== slug) : [...favs, slug];
        setFavs(next);
        guardar(next);
      }}
    >
      <Star size={19} fill={es ? "currentColor" : "none"} />
    </button>
  );
}

type Item = { nombre: string; slug: string };
export function RinconesRapidos({ municipios, porDefecto, base }: { municipios: Item[]; porDefecto: string[]; base: string }) {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => setFavs(leer()), []);
  const slugs = favs.length ? favs : porDefecto;
  const lista = slugs.map((s) => municipios.find((m) => m.slug === s)).filter((m): m is Item => Boolean(m));
  return (
    <nav className="quick-places" aria-label={favs.length ? "Tus municipios favoritos" : "Municipios destacados"}>
      <span>{favs.length ? "TUS RINCONES" : "DESTACADOS"}</span>
      {lista.map((m) => (
        <a key={m.slug} href={`${base}${m.slug}/`}>
          {m.nombre}
          {favs.includes(m.slug) && <Star size={11} fill="currentColor" aria-hidden="true" />}
        </a>
      ))}
    </nav>
  );
}
