# eltiempoalmeria.es

Web del tiempo muy detallada y exclusivamente para la provincia de Almería (103 municipios).
Sitio estático: los datos se descargan en GitHub Actions, se generan las páginas y se despliega en GitHub Pages.

## Stack

- Astro 7 (generación estática) + islas React 19 + TypeScript strict
- Tailwind CSS 4 con los tokens del diseño "Cabo de Gata volcánico" (`src/styles/global.css`)
- Gráficas: SVG propio (`Meteograma.tsx`), cargado solo en cliente (`client:visible`)
- Mapas: Leaflet con GeoJSON de límites municipales (IGN); Voronoi de zonas con d3-delaunay y polygon-clipping
- Tipografía: Archivo Variable autoalojada (`@fontsource-variable/archivo`), sin Google Fonts
- Node 22 en CI (24 en local), `tsx` para scripts

## Comandos

- `npm run dev`: servidor local
- `npm run fetch:data`: orquestador de descarga a `src/data/` (necesita `AEMET_API_KEY` en el entorno; sin ella salta las fuentes AEMET). `-- --forzar` ignora los TTL; `-- --solo <fuente>` fuerza una sola fuente.
- `npm run build`: `astro check` + build estático en `dist/`. Debe pasar sin errores ni avisos antes de dar algo por terminado.
- `npm run generar:nucleos` y `npm run generar:zonas`: regeneran `scripts/nucleos-almeria.json` y `scripts/zonas-almeria.json` (se versionan; no se ejecutan en CI).

## Fuentes de datos

1. **AEMET OpenData**: predicción municipal diaria y horaria, observación de estaciones y radar regional de Almería (Níjar).
   - Cada llamada es en dos pasos: el endpoint devuelve `{ estado, datos }` y hay que pedir la URL de `datos` (caduca a ~5 min).
   - La predicción se pide para los 103 de una vez: se consulta el ATOM `predesp_mun_opendata_todos_ATOM.xml` (solo If-Modified-Since: el ETag cambia entre servidores) y, si hay edición nueva, los tar.gz `horaria/todos` y `diaria/todos`. Si fallan, respaldo por municipio en lotes de ≤35, que se corta tras 2 fallos seguidos de red, 5xx o 429; el módulo tiene un presupuesto de 6 min para no agotar el timeout del job.
   - Respuestas con UTF-8 y Latin-1 mezclados (`decodificarMixto`). `elaborado` viene en UTC sin "Z": `Date.parse(elaborado + "Z")`.
   - Límite: máximo 40 peticiones/min por usuario, con reintentos ante 429. El cupo se comparte con producción: en local, gastar lo mínimo.
2. **Open-Meteo**: modelo horario de los 103 municipios (viento, rachas, UV, nubes, prob. precipitación) y zonas de predicción dentro de cada término (ICON-EU, `best_match`, `cell_selection=land`).
   - Plan gratuito, solo uso no comercial (CC BY 4.0): 600/min, 5.000/h, 10.000/día por IP. Siempre en serie (1 petición simultánea), POST para muchas ubicaciones. Si la web lleva publicidad, hace falta plan comercial.
3. **IGN**: límites municipales y núcleos de población (CC BY 4.0). **INE**: población de los núcleos (Nomenclátor).
4. **RIA** (Red de Información Agroclimática de Andalucía, IFAPA): estaciones de Almería para `/agro/` (ETo, lluvia, viento, temperaturas). Atribución: "Datos agroclimáticos: Red de Información Agroclimática de Andalucía (RIA), IFAPA, Junta de Andalucía. Información obtenida del Portal IFAPA."

## Pipeline y cadencias

- El workflow `.github/workflows/deploy.yml` se ejecuta cada 15 min (`7,22,37,52 * * * *`), en push a main y a mano. Restaura `src/data` con `actions/cache`, ejecuta `npm run fetch:data`, guarda la caché y despliega.
- `scripts/fetch-weather.ts` es un orquestador que ejecuta los módulos de `scripts/fuentes/*.ts` según su TTL:
  1. `aemet.ts`: ATOM en cada ejecución; descarga si hay edición nueva, datos de más de 6 h o faltan municipios.
  2. `openmeteo.ts`: TTL 55 min.
  3. `zonas.ts`: cuando hay pasada principal nueva de ICON-EU y han pasado ≥5 h, o si las zonas tienen más de 7 h. Espera 61 s si ya se pidió Open-Meteo en la misma ejecución.
  4. `observaciones.ts`: TTL 3 h (aún no la usa ninguna página); filtra con el contorno provincial de `public/provinces.geojson`.
  5. `radar.ts`: en cada ejecución; guarda las 8 últimas imágenes distintas de las 2 h anteriores a la más reciente y las copia a `public/radar/` (gitignored). Una imagen cuya hora dibujada no se puede fechar no se publica; los dígitos sin plantilla que se identifican se guardan en `src/data/radar/glifos.json`.
  6. `ria.ts`: TTL 3 h (o si falta el día de ayer después de las 08:30 UTC).
- Un fallo de una fuente nunca rompe el build si hay datos anteriores: se conserva el último dato bueno y se anota en `meta.json`. El orquestador registra el consumo de AEMET y Open-Meteo.

## Reglas

- La API key de AEMET NUNCA va al cliente ni al repositorio, ni a logs o salidas. Solo se usa en `scripts/` durante la descarga, leída de `process.env`.
- Toda la descarga de datos ocurre en `scripts/fetch-weather.ts` y `scripts/fuentes/`. Los componentes y páginas solo leen JSON de `src/data/`.
- `src/data/` y `public/radar/` están en `.gitignore`.
- Si falta el dato de AEMET de un municipio, la página usa Open-Meteo y lo indica. Nunca se rompe el build por un municipio.
- Mostrar siempre la hora de última actualización (`meta.updatedAt`: el dato de predicción u observación más reciente; la RIA no cuenta) y avisar si tiene más de 2 h.
- Atribución obligatoria en el pie: "Información elaborada por la Agencia Estatal de Meteorología", "Weather data by Open-Meteo.com (CC BY 4.0)", IGN (CC BY 4.0) e INE; en `/agro/`, la de la RIA; en `/radar/`, "Radar de Almería (Níjar), © AEMET" con enlace al aviso legal.
- Fechas y horas en zona `Europe/Madrid`, formato español.
- Copy en español, en frase normal. Prohibido en la interfaz: etiquetas en mayúsculas, cadenas "A · B · C", numeraciones decorativas, "→" en enlaces y emojis.
- Accesibilidad: botones y enlaces reales, `aria-pressed` en conmutadores, contraste AA, objetivos táctiles ≥44 px, `prefers-reduced-motion`. Todo mapa o gráfica tiene alternativa en tabla o lista.
- Mobile first. Lighthouse objetivo: 95+ en rendimiento y accesibilidad. Islas con `client:visible` salvo el buscador (`client:idle`). Los JSON del cliente se piden con `?v=${meta.updatedAt}`.
- SEO: una página estática por municipio con `<title>` tipo "El tiempo en {Municipio} (Almería) por horas", meta description, datos estructurados y sitemap (`@astrojs/sitemap`).

## Contrato de datos (`src/data/`)

- `meta.json`: `{ updatedAt, fallosAemet: string[], fuentes: { aemet: { actualizado, elaborado /*UTC sin Z*/, modo: "todos"|"municipio"|"cache", atom: { etag, lastModified } }, openMeteo: { actualizado, peso }, zonas: { actualizado, pasada, peso }, observaciones: { actualizado }, radar: { actualizado }, ria: { actualizado, ultimoDia } } }`
- `municipios.json`: `[{ id, nombre, slug, lat, lon, altitud }]` (id = código INE de 5 dígitos, p. ej. `04013`), desde `scripts/municipios-almeria.json`
- `municipios/{id}.json`: `{ aemetDiaria, aemetHoraria, openMeteo }` con el formato de los endpoints por municipio de AEMET (el tar `todos` se adapta a ese formato)
- `observaciones.json`: estaciones AEMET dentro de la provincia, últimas 24 h
- `zonas/{id}.json`: `{ municipio, actualizado, pasada, horas, ultimaHoraDetalle, zonas: [{ id, serie: { temp, hr, precip, prob, wc, viento, dir, racha, cape, nieve } }] }`
- `radar/radar.json` + GIF: `{ actualizado, imagenes: [{ archivo, hora, aprox, sha256 }] }`
- `agro.json`: estaciones RIA, último dato, días, acumulados 7/30 días, estados y estación de referencia por municipio

Versionados en `scripts/`: `municipios-almeria.json`, `nucleos-almeria.json` (núcleos IGN + población INE) y `zonas-almeria.json` (hasta 8 zonas por municipio, una por celda del modelo).

Endpoints generados en el build: `/mapa-horas.json` (48 h de los 103, con `tormenta`), `/zonas/{slug}.json` (zonas, Voronoi, contorno y máscara del término) y `/buscar.json` (municipios y núcleos para el buscador).

## Estructura de páginas

- `/`: mapa provincial por horas (capas lluvia, probabilidad, viento, rachas, temperatura y tormenta; deslizador de 48 h; modo foco con las zonas de un municipio), "Ahora en Almería capital", "Hoy en la provincia" y "Tus municipios"
- `/mapa/`: el mapa provincial a pantalla amplia y la lista de los 103
- `/[municipio]/`: cabecera con el ahora y datos clave, conmutador "Vista general" / "Por zonas" (`?vista=zonas&zona=<id>`, solo con 2 o más zonas), diferencias entre zonas, meteograma 24/48 h, tabla por horas plegada, semana, fuentes y municipios cercanos
- `/radar/`: radar regional de AEMET con animación de las últimas imágenes
- `/agro/`: ETo y balance de riego, invernadero frente a interior, helada y calor, lluvia y viento acumulados y estado de las estaciones RIA
- `/404`: buscador y accesos a las secciones
- Pendientes: `/comarcas/[comarca]/`, `/observaciones/`, `/avisos/`, `/playas/` y `/playas/[playa]/`, `/mar/`, `/calima/`

## Hoja de ruta

1. Municipio + portada + despliegue: hecho
2. Mapa y gráficas: hecho. Pendiente: comarcas y observaciones
3. Pendiente: avisos (CAP XML), playas, mar y calima
4. Agro, radar, zonas de predicción, rediseño y cadencias por fuente: hecho
