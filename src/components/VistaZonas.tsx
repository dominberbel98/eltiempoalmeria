// STUB TEMPORAL: el componente de verdad lo crea la tarea "zonas-front" (src/components/VistaZonas.tsx).
// Solo existe para que compile el modo foco del mapa provincial; en la integración se queda el de verdad.
type Props = { slug: string; base: string; version: string; nombre: string; zonaInicial?: string; compacto?: boolean };

export default function VistaZonas({ slug, base, nombre, compacto }: Props) {
  return (
    <div className={compacto ? "panel-oscuro" : "panel"} style={{ minHeight: 320, display: "flex", flexDirection: "column", gap: 12 }}>
      <p>La vista por zonas de {nombre} todavía no está disponible.</p>
      <a href={`${base}${slug}/`}>Ver la página de {nombre}</a>
    </div>
  );
}
