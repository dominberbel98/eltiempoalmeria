// scripts/generar-nucleos.ts
// Genera scripts/nucleos-almeria.json (versionado): núcleos de población de Almería con coordenadas,
// altitud y nombre del IGN (API Features, colección "nuc", IGR-Poblaciones) y población del INE (Nomenclátor).
// Se ejecuta a mano, no en CI (una vez al año, cuando el INE publique un año nuevo):
//   npx tsx scripts/generar-nucleos.ts [--anio 2025] [--ign nuc.json] [--ine nomen.csv] [--opob opob.json] [--sin-alias]
// --ign / --ine / --opob leen un fichero ya descargado en lugar de pedirlo (misma forma que la respuesta original).
// Atribución: "Obra derivada de IGR-Poblaciones 2025 CC-BY 4.0 ign.es" y "Fuente: INE, Nomenclátor 2025".
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RAIZ = path.resolve(import.meta.dirname, "..");
const SALIDA = path.join(RAIZ, "scripts", "nucleos-almeria.json");
const MUNICIPIOS = path.join(RAIZ, "scripts", "municipios-almeria.json");
const IGN_NUC = "https://api-features.ign.es/collections/nuc/items?f=json&cpro=4&skipGeometry=true&limit=1000";
const IGN_OPOB = "https://api-features.ign.es/collections/opob/items?f=json&cpro=4&skipGeometry=true&limit=1000";
const INE_URL = "https://www.ine.es/nomen2/DescargaTabla";
const MIN_HABITANTES = 10; // núcleos que entran en el buscador
const MIN_NUC_INE = 590; // filas NUC con población numérica que debe traer el CSV del INE

const args = process.argv.slice(2);
const opcion = (nombre: string) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ANIO = Number(opcion("anio") ?? 2025);

type PropsIgn = {
  codine: string;
  nombre: string;
  latitud: number;
  longitud: number;
  altitud: number | null;
  habitantes: number | null;
  capital: string;
  tipo: string;
  fecha?: string;
};
type FeatureIgn = { properties: PropsIgn };
type RespuestaIgn = { features: FeatureIgn[]; numberMatched?: number; links?: { rel: string; href: string }[] };

export type Nucleo = {
  id: string; // codine de 11 dígitos
  municipio: string; // código INE del municipio (5 dígitos)
  nombre: string;
  entidad: string; // entidad singular del INE (puede coincidir con el nombre)
  lat: number;
  lon: number;
  altitud: number;
  poblacion: number;
  anioPoblacion: number;
  capital: boolean;
  tipo: string; // NUCL | URBA | PIND | SERV (IGN)
  alias: string[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pedir(url: string, init?: RequestInit): Promise<Response> {
  let ultimo: unknown;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(url, { ...init, headers: { "user-agent": "eltiempoalmeria.es (generar-nucleos)", ...(init?.headers ?? {}) } });
      if (res.ok) return res;
      ultimo = new Error(`HTTP ${res.status} en ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      ultimo = e;
    }
    await sleep(intento * 3_000);
  }
  throw ultimo instanceof Error ? ultimo : new Error(String(ultimo));
}

/** Descarga una colección de la API Features del IGN siguiendo los enlaces rel=next. */
async function coleccionIgn(url: string, local?: string): Promise<FeatureIgn[]> {
  if (local) {
    const j = JSON.parse(await readFile(local, "utf8")) as RespuestaIgn | FeatureIgn[];
    return Array.isArray(j) ? j : j.features;
  }
  const todas: FeatureIgn[] = [];
  let siguiente: string | undefined = url;
  let esperadas: number | undefined;
  for (let pagina = 0; siguiente && pagina < 50; pagina++) {
    const res = await pedir(siguiente, { headers: { accept: "application/geo+json, application/json" } });
    const j = (await res.json()) as RespuestaIgn;
    if (!Array.isArray(j.features)) throw new Error(`Respuesta del IGN sin features: ${siguiente}`);
    esperadas ??= j.numberMatched;
    todas.push(...j.features);
    if (!j.features.length) break;
    siguiente = j.links?.find((l) => l.rel === "next")?.href;
    if (siguiente) await sleep(500);
  }
  if (esperadas != null && todas.length !== esperadas) {
    throw new Error(`El IGN anunciaba ${esperadas} elementos y se han descargado ${todas.length}`);
  }
  return todas;
}

/** CSV del Nomenclátor del INE (población por unidad poblacional) de la provincia 04. */
async function csvIne(anio: number, local?: string): Promise<string> {
  let bytes: Uint8Array;
  if (local) bytes = new Uint8Array(await readFile(local));
  else {
    const cuerpo = new URLSearchParams({
      accion: "busquedaAvanzada",
      entidad_amb: "T",
      comunidad: "1",
      provincias: "04",
      desagregacion: "S",
      poblacion_amb: "T",
      poblacion_op: "I",
      poblacion_txt: "",
      anios: String(anio),
      L: "0",
      typeDownload: "3",
    });
    const res = await pedir(INE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: cuerpo.toString(),
    });
    const tipo = res.headers.get("content-type") ?? "";
    if (!/csv/i.test(tipo)) throw new Error(`El INE no ha devuelto un CSV (Content-Type: ${tipo})`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  return new TextDecoder("iso-8859-15").decode(bytes);
}

type FilaIne = { codigo: string; nombre: string; tipo: string; total: number | null };

function leerIne(csv: string, anio: number): Map<string, FilaIne> {
  const lineas = csv.split(/\r?\n/);
  // Con un año que el INE aún no tiene, responde 200 con todas las filas pero sin columnas de población
  if (!lineas.slice(0, 8).some((l) => l.includes(`Año ${anio}`))) {
    throw new Error(`El CSV del INE no trae la cabecera "Año ${anio}": ese año no está publicado. Aborto sin escribir nada.`);
  }
  const filas = new Map<string, FilaIne>();
  for (const l of lineas) {
    if (!l.startsWith("04 ")) continue;
    const c = l.split(";");
    if (c.length < 6) continue;
    const cmun = c[1].trim().split(" ")[0];
    const codigo = `04${cmun.padStart(3, "0")}${c[2].trim()}`;
    // "N.E." (no existe) y vacíos no son número: Number("N.E.") es NaN
    const n = c[5].trim() === "" ? NaN : Number(c[5].trim());
    filas.set(codigo, { codigo, nombre: c[3].trim(), tipo: c[4].trim(), total: Number.isFinite(n) ? n : null });
  }
  const nucConNumero = [...filas.values()].filter((f) => f.tipo === "NUC" && f.total != null).length;
  if (nucConNumero < MIN_NUC_INE) {
    throw new Error(`El CSV del INE solo trae ${nucConNumero} núcleos con población (mínimo ${MIN_NUC_INE}). Aborto.`);
  }
  return filas;
}

const MINUSCULAS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "a", "al", "o", "u"]);

/** "AGUA DEL MEDIO-SOPALMO (EL)" → "El Agua del Medio-Sopalmo" */
function nombreIne(s: string): string {
  let t = s.trim().replace(/\s+/g, " ");
  const art = /^(.*?)\s*\((EL|LA|LOS|LAS)\)$/i.exec(t);
  if (art) t = `${art[2]} ${art[1]}`;
  const palabras = t.toLocaleLowerCase("es").split(" ");
  return palabras
    .map((p, i) =>
      p
        .split("-")
        .map((q, j) => (i > 0 && j === 0 && MINUSCULAS.has(q) ? q : q.charAt(0).toLocaleUpperCase("es") + q.slice(1)))
        .join("-")
    )
    .join(" ");
}

const clave = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const red = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  const municipios = JSON.parse(await readFile(MUNICIPIOS, "utf8")) as { id: string; nombre: string }[];
  const idsMunicipio = new Set(municipios.map((m) => m.id));

  console.log("IGN, colección nuc…");
  const nuc = await coleccionIgn(IGN_NUC, opcion("ign"));
  const props = nuc.map((f) => f.properties).filter((p) => p.codine?.length === 11 && p.codine.startsWith("04"));
  if (props.length < 590) throw new Error(`El IGN solo ha devuelto ${props.length} núcleos de Almería`);
  const anioIgn = Number((props.find((p) => p.fecha)?.fecha ?? "2025").slice(0, 4)) - 1; // habitantes del IGN = padrón del año anterior
  const capitales = new Map<string, PropsIgn>();
  for (const p of props) {
    if (p.capital?.[3] !== "1") continue;
    const m = p.codine.slice(0, 5);
    if (capitales.has(m)) throw new Error(`Dos capitales IGN en ${m}`);
    capitales.set(m, p);
  }
  const sinCapital = [...idsMunicipio].filter((id) => !capitales.has(id));
  if (sinCapital.length) throw new Error(`Municipios sin capital en el IGN: ${sinCapital.join(", ")}`);
  console.log(`  ${props.length} núcleos, ${new Set(props.map((p) => p.codine.slice(0, 5))).size} municipios, ${capitales.size} capitales`);

  console.log(`INE, Nomenclátor ${ANIO}…`);
  const ine = leerIne(await csvIne(ANIO, opcion("ine")), ANIO);
  let cruzados = 0;

  const nucleos: Nucleo[] = [];
  for (const p of props) {
    const municipio = p.codine.slice(0, 5); // nunca por punto en polígono (los límites están simplificados)
    if (!idsMunicipio.has(municipio)) continue;
    const fila = ine.get(p.codine);
    const conIne = fila?.tipo === "NUC" && fila.total != null;
    if (conIne) cruzados++;
    const poblacion = conIne ? fila!.total! : (p.habitantes ?? 0);
    const capital = p.capital?.[3] === "1";
    if (poblacion < MIN_HABITANTES && !capital) continue;
    const es = ine.get(`${p.codine.slice(0, 9)}00`);
    const entidad = es?.tipo === "ES" ? nombreIne(es.nombre) : p.nombre;
    nucleos.push({
      id: p.codine,
      municipio,
      nombre: p.nombre.trim(),
      entidad,
      lat: red(p.latitud, 5),
      lon: red(p.longitud, 5),
      altitud: Math.round(p.altitud ?? 0),
      poblacion,
      anioPoblacion: conIne ? ANIO : anioIgn,
      capital,
      tipo: p.tipo,
      alias: [],
    });
  }
  if (cruzados < MIN_NUC_INE) throw new Error(`Solo ${cruzados} núcleos del IGN cruzan con población del INE`);
  console.log(`  ${cruzados} núcleos con población INE ${ANIO}; ${nucleos.length} con al menos ${MIN_HABITANTES} hab o capital`);

  // Nombres de núcleo por municipio: un alias nunca repite el nombre de otro núcleo del mismo municipio
  const nombresMunicipio = new Map<string, Set<string>>();
  for (const n of nucleos) {
    if (!nombresMunicipio.has(n.municipio)) nombresMunicipio.set(n.municipio, new Set());
    nombresMunicipio.get(n.municipio)!.add(clave(n.nombre));
  }
  const aliasValido = (n: Nucleo, a: string) =>
    !nombresMunicipio.get(n.municipio)?.has(clave(a)) && !n.alias.some((x) => clave(x) === clave(a));

  // La entidad singular ("Mojácar Playa") se guarda como alias solo en el núcleo más poblado de esa entidad
  const porEntidad = new Map<string, Nucleo>();
  for (const n of nucleos) {
    const k = n.id.slice(0, 9);
    const actual = porEntidad.get(k);
    if (!actual || n.poblacion > actual.poblacion) porEntidad.set(k, n);
  }
  for (const n of porEntidad.values()) if (aliasValido(n, n.entidad)) n.alias.push(n.entidad);

  // Alias del buscador: urbanizaciones y barrios del IGN (colección opob, tipos URBA y BARR)
  if (!args.includes("--sin-alias")) {
    console.log("IGN, colección opob (alias)…");
    try {
      const opob = (await coleccionIgn(IGN_OPOB, opcion("opob"))).map((f) => f.properties).filter((p) => p.tipo === "URBA" || p.tipo === "BARR");
      const porId = new Map(nucleos.map((n) => [n.id, n]));
      let asignados = 0;
      for (const o of opob) {
        const municipio = o.codine?.slice(0, 5);
        const delMunicipio = nucleos.filter((n) => n.municipio === municipio);
        if (!delMunicipio.length || !o.nombre) continue;
        // El codine de opob apunta a la entidad padre; si no es un núcleo del JSON, el núcleo más cercano del municipio
        let destino = porId.get(o.codine);
        if (!destino && Number.isFinite(o.latitud) && Number.isFinite(o.longitud)) {
          const k = Math.cos((o.latitud * Math.PI) / 180);
          destino = delMunicipio.reduce((a, b) =>
            ((a.lon - o.longitud) * k) ** 2 + (a.lat - o.latitud) ** 2 <= ((b.lon - o.longitud) * k) ** 2 + (b.lat - o.latitud) ** 2 ? a : b
          );
        }
        destino ??= delMunicipio.find((n) => n.capital);
        if (!destino) continue;
        const nombre = o.nombre.trim();
        if (!aliasValido(destino, nombre)) continue;
        destino.alias.push(nombre);
        asignados++;
      }
      console.log(`  ${opob.length} urbanizaciones y barrios, ${asignados} alias nuevos`);
    } catch (e) {
      console.warn(`  sin alias de opob: ${(e as Error).message}`);
    }
  }

  for (const n of nucleos) n.alias.sort((a, b) => a.localeCompare(b, "es"));
  nucleos.sort((a, b) => a.municipio.localeCompare(b.municipio) || Number(b.capital) - Number(a.capital) || b.poblacion - a.poblacion || a.id.localeCompare(b.id));
  // Un elemento por línea para que los diffs del repositorio sean legibles
  await writeFile(SALIDA, "[\n" + nucleos.map((n) => JSON.stringify(n)).join(",\n") + "\n]\n");
  const porMunicipio = new Map<string, number>();
  for (const n of nucleos) porMunicipio.set(n.municipio, (porMunicipio.get(n.municipio) ?? 0) + 1);
  console.log(`Escrito ${path.relative(RAIZ, SALIDA)}: ${nucleos.length} núcleos en ${porMunicipio.size} municipios`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
