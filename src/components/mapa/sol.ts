// Día o noche en una hora local de Madrid y un punto concreto, sin depender de Intl ni de datos externos
// (las zonas de Open-Meteo no traen orto ni ocaso). Altura del sol con las fórmulas de la NOAA; se considera noche
// si el centro del sol está por debajo de −0,833° a la media hora (como el orto y el ocaso oficiales).

const RAD = Math.PI / 180;

/** Último domingo de un mes (0-11) a la 01:00 UTC, en ms. */
function ultimoDomingo(anio: number, mes: number): number {
  const finMes = new Date(Date.UTC(anio, mes + 1, 0, 1));
  return finMes.getTime() - finMes.getUTCDay() * 86_400_000;
}

/** Instante UTC (ms) de una hora local peninsular "YYYY-MM-DDTHH:MM" (horario de verano europeo). */
export function instanteMadrid(tLocal: string): number {
  const [f, h = "00:00"] = tLocal.split("T");
  const [a, m, d] = f.split("-").map(Number);
  const [hh, mm] = h.split(":").map(Number);
  const comoUtc = Date.UTC(a, m - 1, d, hh, mm || 0);
  // Con +1 h se compara con las fronteras del horario de verano (01:00 UTC) y se ajusta
  const verano = comoUtc - 3_600_000 >= ultimoDomingo(a, 2) && comoUtc - 7_200_000 < ultimoDomingo(a, 9);
  return comoUtc - (verano ? 7_200_000 : 3_600_000);
}

/** Altura del sol en grados en un instante (ms UTC) y un punto. */
export function alturaSol(ms: number, lat: number, lon: number): number {
  const jd = ms / 86_400_000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const epsilon = (23.439 - 0.0000004 * n) * RAD;
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const ar = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const horario = (gmst + lon) * RAD - ar;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(horario)) / RAD;
}

/** La hora local "YYYY-MM-DDTHH:00" es de noche en ese punto (se mira a la media hora). */
export function esNoche(tLocal: string, lat: number, lon: number): boolean {
  return alturaSol(instanteMadrid(tLocal) + 1_800_000, lat, lon) < -0.833;
}
