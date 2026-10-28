import { useId, useMemo, useState } from "react";
import { ArrowUpRight, LocateFixed, MapPin, Search, X } from "lucide-react";

type Item = { nombre: string; slug: string; lat: number; lon: number; altitud: number };
type Props = { municipios: Item[]; base: string };

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function Buscador({ municipios, base }: Props) {
  const [q, setQ] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [aviso, setAviso] = useState("");
  const listaId = useId();

  const resultados = useMemo(() => {
    const n = normalizar(q.trim());
    if (!n) return municipios.slice(0, 8);
    // Primero los que empiezan por el texto, luego los que lo contienen
    const empiezan = municipios.filter((m) => normalizar(m.nombre).startsWith(n));
    const contienen = municipios.filter((m) => !normalizar(m.nombre).startsWith(n) && normalizar(m.nombre).includes(n));
    return [...empiezan, ...contienen].slice(0, 12);
  }, [q, municipios]);

  const ir = (m: Item) => {
    window.location.href = `${base}${m.slug}/`;
  };

  function localizar() {
    if (!navigator.geolocation) {
      setAviso("Tu navegador no permite la geolocalización.");
      return;
    }
    setAviso("Buscando tu municipio más cercano…");
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude: lat, longitude: lon } }) => {
        if (lat < 36.6 || lat > 37.95 || lon < -3.2 || lon > -1.55) {
          setAviso("Tu ubicación está fuera de la provincia de Almería. Busca un municipio por su nombre.");
          return;
        }
        // La posición se usa solo aquí, en el navegador; no se envía a ningún sitio
        const cercano = [...municipios].sort(
          (a, b) => (a.lat - lat) ** 2 + (a.lon - lon) ** 2 - ((b.lat - lat) ** 2 + (b.lon - lon) ** 2)
        )[0];
        setAviso(`Municipio más cercano: ${cercano.nombre}`);
        ir(cercano);
      },
      () => setAviso("No se pudo acceder a tu ubicación. Puedes usar el buscador."),
      { timeout: 8000 }
    );
  }

  return (
    <div className="search-wrap">
      <div className="search-box">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          role="combobox"
          aria-expanded={abierto}
          aria-controls={listaId}
          aria-autocomplete="list"
          aria-label="Buscar un municipio de Almería"
          value={q}
          placeholder="¿Dónde quieres mirar al cielo?"
          onChange={(e) => {
            setQ(e.target.value);
            setAbierto(true);
          }}
          onFocus={() => setAbierto(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setAbierto(false);
            if (e.key === "Enter" && resultados[0]) ir(resultados[0]);
          }}
        />
        <button type="button" className="icon-button" onClick={localizar} title="Usar mi ubicación" aria-label="Usar mi ubicación">
          <LocateFixed size={18} />
        </button>
        {abierto && (
          <div className="search-results" id={listaId}>
            <div className="search-heading">
              MUNICIPIOS DE ALMERÍA
              <button type="button" onClick={() => setAbierto(false)} aria-label="Cerrar búsqueda">
                <X size={15} />
              </button>
            </div>
            {resultados.length ? (
              resultados.map((m) => (
                <a key={m.slug} href={`${base}${m.slug}/`}>
                  <MapPin size={15} aria-hidden="true" />
                  <span>
                    {m.nombre}
                    <small>{m.altitud} m de altitud</small>
                  </span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </a>
              ))
            ) : (
              <p>No encontramos ese municipio entre los 103 de la provincia.</p>
            )}
          </div>
        )}
      </div>
      {aviso && (
        <p className="search-notice" role="status">
          {aviso}
        </p>
      )}
    </div>
  );
}
