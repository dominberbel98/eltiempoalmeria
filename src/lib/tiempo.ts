// Combina AEMET y Open-Meteo en una forma única para las páginas.
// AEMET manda en temperatura, sensación, humedad, precipitación y estado del cielo cuando hay dato;
// Open-Meteo aporta viento, rachas, UV, nubosidad y probabilidad horaria, y cubre todo si falta AEMET.
import type { AemetPeriodo, DatosMunicipio } from "./datos";

export const ZONA = "Europe/Madrid";

export type Cielo = "despejado" | "poco-nuboso" | "nuboso" | "cubierto" | "niebla" | "lluvia" | "nieve" | "tormenta" | "calima";

export type Hora = {
  t: string; // "2026-10-28T14:00", hora local
  temp: number | null;
  sens: number | null;
  hum: number | null;
  precip: number | null; // mm
  prob: number | null; // %
  viento: number | null; // km/h
  racha: number | null;
  dir: number | null; // grados, de donde viene
  uv: number | null;
  nubes: number | null; // %
  cielo: Cielo;
  cieloTxt: string;
  noche: boolean;
  aemet: boolean;
  tormenta: number | null; // % de probabilidad de tormenta de AEMET del bloque de 6 h que contiene la hora
};

// Forma mínima de una hora para el meteograma (src/components/Meteograma.tsx). Vale para un municipio o una zona.
export type HoraMeteograma = {
  t: string; // "2026-10-28T14:00", hora local
  temp: number | null;
  prob: number | null; // %
  precip: number | null; // mm
  viento: number | null; // km/h
  racha: number | null; // km/h
  dir: number | null; // grados, de donde viene
  cielo: Cielo;
  noche: boolean;
  tormenta?: number | null; // % AEMET por bloque de 6 h; ausente o null si no hay dato
};

export type Dia = {
  fecha: string; // "2026-10-28"
  max: number | null;
  min: number | null;
  cielo: Cielo;
  cieloTxt: string;
  prob: number | null;
  precip: number | null;
  racha: number | null;
  uv: number | null;
  orto: string | null; // "08:12"
  ocaso: string | null;
  aemet: boolean;
  tormentaMax: number | null; // % máximo de probabilidad de tormenta de AEMET entre los bloques del día
};

export type Prevision = {
  actual: Hora | null;
  horas: Hora[]; // próximas 48 h desde la hora actual
  dias: Dia[]; // 7 días
  aemet: boolean;
  elaborado: string | null;
};

const num = (v: unknown): number | null => {
  if (v === "" || v == null) return null;
  if (v === "Ip") return 0; // "inapreciable"
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const WMO: Record<number, [Cielo, string]> = {
  0: ["despejado", "Despejado"],
  1: ["poco-nuboso", "Poco nuboso"],
  2: ["nuboso", "Intervalos nubosos"],
  3: ["cubierto", "Cubierto"],
  45: ["niebla", "Niebla"],
  48: ["niebla", "Niebla con escarcha"],
  51: ["lluvia", "Llovizna débil"],
  53: ["lluvia", "Llovizna"],
  55: ["lluvia", "Llovizna intensa"],
  56: ["lluvia", "Llovizna helada"],
  57: ["lluvia", "Llovizna helada"],
  61: ["lluvia", "Lluvia débil"],
  63: ["lluvia", "Lluvia moderada"],
  65: ["lluvia", "Lluvia fuerte"],
  66: ["lluvia", "Lluvia helada"],
  67: ["lluvia", "Lluvia helada"],
  71: ["nieve", "Nieve débil"],
  73: ["nieve", "Nieve"],
  75: ["nieve", "Nieve fuerte"],
  77: ["nieve", "Granos de nieve"],
  80: ["lluvia", "Chubascos débiles"],
  81: ["lluvia", "Chubascos"],
  82: ["lluvia", "Chubascos fuertes"],
  85: ["nieve", "Chubascos de nieve"],
  86: ["nieve", "Chubascos de nieve"],
  95: ["tormenta", "Tormenta"],
  96: ["tormenta", "Tormenta con granizo"],
  99: ["tormenta", "Tormenta con granizo"],
};
export const cieloWmo = (code: number | null | undefined): [Cielo, string] => WMO[code ?? 0] ?? ["nuboso", "Nuboso"];

// Códigos de estado del cielo de AEMET ("12", "12n", "46"…)
export function cieloAemet(codigo: string): Cielo | null {
  const c = Number(codigo.replace(/n$/, ""));
  if (!c) return null;
  if (c === 11) return "despejado";
  if (c === 12 || c === 17) return "poco-nuboso";
  if (c === 13 || c === 14) return "nuboso";
  if (c === 15 || c === 16) return "cubierto";
  if ((c >= 23 && c <= 26) || (c >= 43 && c <= 46)) return "lluvia";
  if ((c >= 33 && c <= 36) || (c >= 71 && c <= 74)) return "nieve";
  if ((c >= 51 && c <= 54) || (c >= 61 && c <= 64)) return "tormenta";
  if (c === 81 || c === 82) return "niebla";
  if (c === 83) return "calima";
  return null;
}

// Hora local actual redondeada a la hora: "2026-10-28T14:00"
export function horaLocal(fecha = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(fecha)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}

type AemetHora = { temp: number | null; sens: number | null; hum: number | null; precip: number | null; cielo: Cielo | null; cieloTxt: string };

function indexarAemetHoraria(d: DatosMunicipio): Map<string, AemetHora> {
  const mapa = new Map<string, AemetHora>();
  for (const dia of d.aemetHoraria?.prediccion?.dia ?? []) {
    const fecha = dia.fecha.slice(0, 10);
    const porHora = (lista: AemetPeriodo[] | undefined) =>
      new Map((lista ?? []).filter((x) => x.periodo?.length === 2).map((x) => [x.periodo!, x]));
    const temp = porHora(dia.temperatura);
    const sens = porHora(dia.sensTermica);
    const hum = porHora(dia.humedadRelativa);
    const precip = porHora(dia.precipitacion);
    const cielo = porHora(dia.estadoCielo);
    for (const [h, x] of temp) {
      const c = cielo.get(h);
      mapa.set(`${fecha}T${h}:00`, {
        temp: num(x.value),
        sens: num(sens.get(h)?.value),
        hum: num(hum.get(h)?.value),
        precip: num(precip.get(h)?.value),
        cielo: c?.value != null ? cieloAemet(String(c.value)) : null,
        cieloTxt: c?.descripcion ?? "",
      });
    }
  }
  return mapa;
}

// --- Probabilidad de tormenta de AEMET ---
// Solo viene en la predicción horaria, por bloques de 6 h: `probTormenta: [{ value: "20", periodo: "0107" }, …]`.
// `periodo` es "HHhh": hora local de inicio (incluida) y de fin (excluida). Las etiquetas no son fijas
// (en invierno 0107, 0713, 1319, 1901; en verano cambian), así que se interpretan siempre a partir del texto.
// El bloque que cruza la medianoche (p. ej. "1901" del día D) cubre de 19 a 23 del día D y la hora 00 del día D+1.
type DiaHorariaAemet = NonNullable<NonNullable<NonNullable<DatosMunicipio["aemetHoraria"]>["prediccion"]>["dia"]>[number];

const lista = <T,>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const probTormentaDe = (dia: DiaHorariaAemet): AemetPeriodo[] => lista((dia as DiaHorariaAemet & { probTormenta?: AemetPeriodo | AemetPeriodo[] }).probTormenta);

const sumarDia = (fecha: string, n: number) => new Date(Date.parse(fecha + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const dos = (n: number) => String(n).padStart(2, "0");

// Horas locales ("2026-10-29T00:00") que cubre un bloque `periodo` del día `fecha` ("2026-10-28"). [] si el periodo no es "HHhh".
export function horasDeBloque(fecha: string, periodo: string | undefined): string[] {
  if (!periodo || !/^\d{4}$/.test(periodo)) return [];
  const inicio = Number(periodo.slice(0, 2));
  const fin = Number(periodo.slice(2, 4));
  if (inicio > 23 || fin > 24) return [];
  const duracion = (fin - inicio + 24) % 24;
  const horas: string[] = [];
  for (let k = 0; k < duracion; k++) {
    const h = inicio + k;
    horas.push(`${h >= 24 ? sumarDia(fecha, 1) : fecha}T${dos(h % 24)}:00`);
  }
  return horas;
}

// Índice hora local → % de tormenta, y máximo por día (bloques que AEMET agrupa bajo cada fecha).
function indexarTormenta(d: DatosMunicipio): { porHora: Map<string, number | null>; maxDia: Map<string, number | null> } {
  const porHora = new Map<string, number | null>();
  const maxDia = new Map<string, number | null>();
  for (const dia of lista(d.aemetHoraria?.prediccion?.dia)) {
    const fecha = dia.fecha.slice(0, 10);
    for (const bloque of probTormentaDe(dia)) {
      const v = num(bloque.value);
      const horas = horasDeBloque(fecha, bloque.periodo);
      if (!horas.length) continue;
      for (const t of horas) porHora.set(t, v);
      if (v != null) maxDia.set(fecha, Math.max(maxDia.get(fecha) ?? 0, v));
      else if (!maxDia.has(fecha)) maxDia.set(fecha, null);
    }
  }
  return { porHora, maxDia };
}

const hhmm = (iso: string | undefined) => (iso ? iso.slice(11, 16) : null);

export function construirPrevision(d: DatosMunicipio, ahora = horaLocal()): Prevision {
  const om = d.openMeteo;
  const aemetH = indexarAemetHoraria(d);
  const tormenta = indexarTormenta(d);
  const aemetD = new Map((d.aemetDiaria?.prediccion?.dia ?? []).map((x) => [x.fecha.slice(0, 10), x]));

  // Días
  const fechas = om?.daily.time ?? [...aemetD.keys()];
  const ortos = new Map<string, [string | null, string | null]>();
  for (const dia of d.aemetHoraria?.prediccion?.dia ?? []) ortos.set(dia.fecha.slice(0, 10), [dia.orto ?? null, dia.ocaso ?? null]);
  const dias: Dia[] = fechas.slice(0, 7).map((fecha, i) => {
    const [cieloOm, txtOm] = cieloWmo(om?.daily.weather_code[i]);
    const a = aemetD.get(fecha);
    const periodo = (lista: AemetPeriodo[] | undefined) =>
      lista?.find((x) => x.periodo === "00-24" && x.value !== "") ?? lista?.find((x) => x.value !== "" && x.value != null);
    const cieloA = periodo(a?.estadoCielo);
    const cieloCod = cieloA ? cieloAemet(String(cieloA.value)) : null;
    const probA = periodo(a?.probPrecipitacion);
    return {
      fecha,
      max: num(a?.temperatura?.maxima) ?? om?.daily.temperature_2m_max[i] ?? null,
      min: num(a?.temperatura?.minima) ?? om?.daily.temperature_2m_min[i] ?? null,
      cielo: cieloCod ?? cieloOm,
      cieloTxt: cieloCod ? (cieloA?.descripcion ?? txtOm) : txtOm,
      prob: num(probA?.value) ?? om?.daily.precipitation_probability_max[i] ?? null,
      precip: om?.daily.precipitation_sum[i] ?? null,
      racha: om?.daily.wind_gusts_10m_max[i] ?? null,
      uv: num(a?.uvMax) ?? om?.daily.uv_index_max[i] ?? null,
      orto: hhmm(om?.daily.sunrise[i]) ?? ortos.get(fecha)?.[0] ?? null,
      ocaso: hhmm(om?.daily.sunset[i]) ?? ortos.get(fecha)?.[1] ?? null,
      aemet: Boolean(a),
      tormentaMax: tormenta.maxDia.get(fecha) ?? null,
    };
  });
  const solDe = new Map(dias.map((x) => [x.fecha, x]));
  const esNoche = (t: string) => {
    const dia = solDe.get(t.slice(0, 10));
    if (!dia?.orto || !dia.ocaso) return Number(t.slice(11, 13)) < 7 || Number(t.slice(11, 13)) >= 20;
    const h = t.slice(11, 16);
    return h < dia.orto || h > dia.ocaso;
  };

  // Horas
  const tiempos = om?.hourly.time ?? [...aemetH.keys()].sort();
  const horas: Hora[] = [];
  tiempos.forEach((t, i) => {
    if (t < ahora || horas.length >= 48) return;
    const a = aemetH.get(t);
    const [cieloOm, txtOm] = cieloWmo(om?.hourly.weather_code[i]);
    const h = om?.hourly;
    horas.push({
      t,
      temp: a?.temp ?? h?.temperature_2m[i] ?? null,
      sens: a?.sens ?? h?.apparent_temperature[i] ?? null,
      hum: a?.hum ?? h?.relative_humidity_2m[i] ?? null,
      precip: a?.precip ?? h?.precipitation[i] ?? null,
      prob: h?.precipitation_probability[i] ?? null,
      viento: h?.wind_speed_10m[i] ?? null,
      racha: h?.wind_gusts_10m[i] ?? null,
      dir: h?.wind_direction_10m[i] ?? null,
      uv: h?.uv_index[i] ?? null,
      nubes: h?.cloud_cover[i] ?? null,
      cielo: a?.cielo ?? cieloOm,
      cieloTxt: a?.cielo ? a.cieloTxt || txtOm : txtOm,
      noche: esNoche(t),
      aemet: Boolean(a),
      tormenta: tormenta.porHora.get(t) ?? null,
    });
  });

  const aemet = Boolean(d.aemetDiaria || d.aemetHoraria);
  return {
    actual: horas[0] ?? null,
    horas,
    dias,
    aemet,
    elaborado: d.aemetHoraria?.elaborado ?? d.aemetDiaria?.elaborado ?? null,
  };
}

// --- Formato ---
export const fmt = (n: number | null | undefined, sufijo = "") => (n == null || !Number.isFinite(n) ? "—" : Math.round(n) + sufijo);
export const fmtMm = (n: number | null | undefined) =>
  n == null ? "—" : n === 0 ? "0" : n < 0.1 ? "<0,1" : n.toLocaleString("es-ES", { maximumFractionDigits: 1 });

const PUNTOS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
export const rumbo = (grados: number | null) => (grados == null ? "—" : PUNTOS[Math.round(grados / 45) % 8]);

export const nombreDia = (fecha: string, i: number) =>
  i === 0 ? "Hoy" : i === 1 ? "Mañana" : new Date(fecha + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", timeZone: "UTC" });
export const fechaCorta = (fecha: string) =>
  new Date(fecha + "T12:00:00Z").toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" });
export const fechaLarga = (fecha: string) => {
  const s = new Date(fecha + "T12:00:00Z").toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const fechaHoraActualizacion = (iso: string) =>
  iso
    ? new Date(iso).toLocaleString("es-ES", { timeZone: ZONA, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "sin datos";

// "28 de octubre de 2026 a las 16:45" (o "a la 01:05"), en hora de Madrid. "sin datos" si no hay fecha válida.
export function textoActualizacion(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "sin datos";
  const d = new Date(iso);
  const fecha = d.toLocaleDateString("es-ES", { timeZone: ZONA, day: "numeric", month: "long", year: "numeric" });
  const hora = d.toLocaleTimeString("es-ES", { timeZone: ZONA, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${fecha} ${hora.startsWith("01:") ? "a la" : "a las"} ${hora}`;
}

// Horas transcurridas desde una fecha ISO (Infinity si no es válida).
export const horasDesde = (iso: string | null | undefined, ahora = Date.now()) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : (ahora - t) / 3_600_000;
};

// Nombre del día con su número, sin depender de Intl (mismo texto en el build y en el navegador):
// "Jueves 29" o, corto, "Jue 29". `fecha` es "2026-10-29" (o una hora local "2026-10-29T14:00").
const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
export function diaConNumero(fecha: string, corto = false): string {
  const d = new Date(fecha.slice(0, 10) + "T12:00:00Z");
  return `${(corto ? DIAS_CORTOS : DIAS)[d.getUTCDay()]} ${d.getUTCDate()}`;
}

// Reduce las horas de construirPrevision a lo que necesita el meteograma, con los valores redondeados
// (menos peso en el HTML de la isla).
const r0 = (n: number | null) => (n == null ? null : Math.round(n));
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
export const aMeteograma = (horas: Hora[]): HoraMeteograma[] =>
  horas.map((h) => ({
    t: h.t,
    temp: r1(h.temp),
    prob: r0(h.prob),
    precip: r1(h.precip),
    viento: r0(h.viento),
    racha: r0(h.racha),
    dir: r0(h.dir),
    cielo: h.cielo,
    noche: h.noche,
    tormenta: h.tormenta,
  }));
