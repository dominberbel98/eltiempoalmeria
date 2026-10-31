// Stub provisional de la vista por zonas para que compile la página de municipio.
// La tarea "zonas-front" sustituye este archivo por la isla completa (mapa Leaflet, tabla de zonas y meteograma por zona).
type Props = {
  slug: string; // slug del municipio: carga `${base}zonas/${slug}.json?v=${version}`
  base: string; // import.meta.env.BASE_URL
  version: string; // meta.updatedAt, para saltarse la caché de Pages
  nombre: string; // nombre del municipio
  zonaInicial?: string | null; // zona seleccionada por defecto (la capital) si la URL no trae ?zona=
};

export default function VistaZonas({ slug, base, version, nombre }: Props) {
  const url = `${base}zonas/${slug}.json?v=${encodeURIComponent(version)}`;
  return (
    <div className="panel" style={{ padding: 24 }}>
      <p>
        La vista por zonas de {nombre} se carga desde <a href={url}>los datos por zonas</a>.
      </p>
    </div>
  );
}
