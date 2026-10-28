// Previsión horaria de los 103 municipios (48 h) para el mapa. Un único JSON compartido por todas las páginas.
import { fichas } from "../lib/resumen";

const r0 = (n: number | null) => (n == null ? null : Math.round(n));
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

export function GET() {
  const todas = fichas();
  const horas = todas.find((f) => f.prevision.horas.length)?.prevision.horas.map((h) => h.t) ?? [];
  const municipios = todas.map(({ municipio: m, prevision: p }) => {
    const porHora = new Map(p.horas.map((h) => [h.t, h]));
    const serie = <T,>(fn: (h: (typeof p.horas)[number]) => T) => horas.map((t) => (porHora.has(t) ? fn(porHora.get(t)!) : null));
    return {
      id: m.id,
      slug: m.slug,
      nombre: m.nombre,
      lat: m.lat,
      lon: m.lon,
      temp: serie((h) => r0(h.temp)),
      precip: serie((h) => r1(h.precip)),
      prob: serie((h) => r0(h.prob)),
      viento: serie((h) => r0(h.viento)),
      racha: serie((h) => r0(h.racha)),
      dir: serie((h) => r0(h.dir)),
      cielo: serie((h) => h.cieloTxt),
    };
  });
  return new Response(JSON.stringify({ horas, municipios }), { headers: { "Content-Type": "application/json" } });
}
