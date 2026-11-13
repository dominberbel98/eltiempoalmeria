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
- `npm run generar:nucleos`, `npm run generar:zonas` y `npm run generar:playas`: regeneran `scripts/nucleos-almeria.json`, `scripts/zonas-almeria.json` y `scripts/playas-almeria.json` (se versionan; no se ejecutan en CI).

## Fuentes de datos

1. **AEMET OpenData**: predicción municipal diaria y horaria, observación de estaciones, radar regional de Almería (Níjar), avisos CAP (Meteoalerta, área 61), predicción de playas (22 playas) y boletín costero FQXX47 (aguas costeras de Almería y Alborán).
   - Cada llamada es en dos pasos: el endpoint devuelve `{ estado, datos }` y hay que pedir la URL de `datos` (caduca a ~5 min).
   - La predicción se pide para los 103 de una vez: se consulta el ATOM `predesp_mun_opendata_todos_ATOM.xml` (solo If-Modified-Since: el ETag cambia entre servidores) y, si hay edición nueva, los tar.gz `horaria/todos` y `diaria/todos`. Si fallan, respaldo por municipio en lotes de ≤35, que se corta tras 2 fallos seguidos de red, 5xx o 429; el módulo tiene un presupuesto de 6 min para no agotar el timeout del job.
   - Respuestas con UTF-8 y Latin-1 mezclados (`decodificarMixto`). `elaborado` viene en UTC sin "Z": `Date.parse(elaborado + "Z")`.
   - Límite: máximo 40 peticiones/min por usuario, con reintentos ante 429. El cupo se comparte con producción: en local, gastar lo mínimo.
2. **Open-Meteo**: modelo horario de los 103 municipios (viento, rachas, UV, nubes, prob. precipitación) y zonas de predicción dentro de cada término (ICON-EU, `best_match`, `cell_selection=land`); Marine API y viento con `cell_selection=sea` en 10 puntos de la costa (`/mar/`); Air Quality API (CAMS, `dust` y `aerosol_optical_depth`) para los 103 municipios (`/calima/`, con la atribución de Copernicus `ATRIBUCION_CAMS` de `src/lib/calima.ts`).
   - Plan gratuito, solo uso no comercial (CC BY 4.0): 600/min, 5.000/h, 10.000/día por IP. Siempre en serie (1 petición simultánea), POST para muchas ubicaciones. Si la web lleva publicidad, hace falta plan comercial.
3. **IGN**: límites municipales y núcleos de población (CC BY 4.0). **INE**: población de los núcleos (Nomenclátor).
4. **RIA** (Red de Información Agroclimática de Andalucía, IFAPA): estaciones de Almería para `/agro/` (ETo, lluvia, viento, temperaturas). Atribución: "Datos agroclimáticos: Red de Información Agroclimática de Andalucía (RIA), IFAPA, Junta de Andalucía. Información obtenida del Portal IFAPA."

## Pipeline y cadencias

- El workflow `.github/workflows/deploy.yml` se ejecuta cada 15 min (`7,22,37,52 * * * *`), en push a main y a mano. Restaura `src/data` con `actions/cache`, ejecuta `npm run fetch:data`, guarda la caché y despliega.
- `scripts/fetch-weather.ts` es un orquestador que ejecuta los módulos de `scripts/fuentes/*.ts` en este orden y según su TTL:
  1. `avisos.ts`: en cada ejecución pide el RSS público `CAP_AFAC61_RSS.xml` (sin clave ni cupo, admite 304); solo descarga el tar CAP de OpenData (2 peticiones) si hay edición nueva, si falta `avisos.json` o si tiene más de 6 h. Respaldo: el tar enlazado desde el RSS.
  2. `aemet.ts`: ATOM en cada ejecución; descarga si hay edición nueva, datos de más de 6 h o faltan municipios.
  3. `openmeteo.ts`: TTL 55 min.
  4. `mar.ts`: oleaje y viento sobre el mar con TTL 3 h; boletín costero cada 3 h, y cada hora cuando la edición guardada tiene 8 h o más desde su publicación (se han visto ediciones a las 12 y a las 20 UTC); con cada edición nueva, 1 GET sin cupo al XML público para leer su Last-Modified.
  5. `calima.ts`: solo cuando CAMS publica una pasada nueva (lee los `meta.json` estáticos de `cams_europe` y `cams_global`, sin cupo; unas 3 descargas al día). Sin `meta.json`, cada 6 h.
  6. `zonas.ts`: cuando hay pasada principal nueva de ICON-EU y han pasado ≥5 h, o si las zonas tienen más de 7 h. Espera 61 s si ya se pidió Open-Meteo en la misma ejecución (openmeteo, mar y calima suman como mucho 329 de peso, por debajo de 600/min).
  7. `observaciones.ts`: TTL 55 min. `/observacion/convencional/todas` solo trae 12 h: cada descarga se une con la anterior (clave idema+fint) y se guardan hasta 24 lecturas horarias por estación. Filtra con el contorno provincial de `public/provinces.geojson`.
  8. `radar.ts`: en cada ejecución; guarda las 8 últimas imágenes distintas de las 2 h anteriores a la más reciente y las copia a `public/radar/` (gitignored). Una imagen cuya hora dibujada no se puede fechar no se publica; los dígitos sin plantilla que se identifican se guardan en `src/data/radar/glifos.json`.
  9. `playas.ts`: AEMET publica una edición al día hacia las 08:50 UTC (el 31/10 hubo otra a las 23:51 UTC). Las playas con edición anterior a la esperada se piden en lotes de 11 (22 peticiones, unos 35 s), así que las 22 se renuevan en dos ejecuciones; sin playas atrasadas, una comprobación cada 6 h. Tras fallos seguidos del servicio corta el lote y reintenta a los 30 min.
  10. `ria.ts`: TTL 3 h (o si falta el día de ayer después de las 08:30 UTC).
- Todos los clientes de AEMET comparten la pausa de 1,6 s de `ClienteAemet` (como mucho 37,5 peticiones/min en el proceso). Open-Meteo, siempre en serie.
- Un fallo de una fuente nunca rompe el build si hay datos anteriores: se conserva el último dato bueno y se anota en `meta.json`. El orquestador registra el consumo de AEMET y Open-Meteo en `src/data/consumo.json`, por día (`porFuente`) y por ejecución (`gasto`).
- Ojo: GitHub no cumple el `schedule` de 15 min. En noviembre de 2026 lanza solo 3-5 ejecuciones al día (cada 4-8 h), así que las cadencias de arriba son el máximo, no lo que pasa en producción. Por eso lo dispara cada 15 min un cron externo: el Cloudflare Worker de `cron/` (`worker.js` y `wrangler.toml`), que llama a `workflow_dispatch` con el secreto `GH_TOKEN` (token fine-grained solo con Actions de este repositorio; nunca va al repo). Se despliega con `npx wrangler deploy --config cron/wrangler.toml`. El `schedule` de GitHub queda de respaldo. Las páginas no deben prometer una cadencia: enseñan la hora real de la última comprobación.
- Presupuesto diario estimado (si se cumplieran las 96 ejecuciones del cron de 15 min; el consumo real es mucho menor):
  - Open-Meteo (límite 10.000/día): openmeteo 206 × 24 = 4.944; zonas 350 × 4-5 = 1.400-1.750; mar 20 × 8 = 160; calima 103 × 3 = 309 (412 sin `meta.json` de CAMS). Total: unos 6.800-7.200, como mucho 7.300.
  - AEMET (límite 40/min): ATOM 96 y radar 2 × 96 = 192; predicción 4 por edición nueva (16-24); observaciones 2 × 24 = 48; avisos 13-25; playas 50-55; boletín costero unas 26. Total: unas 440-460 peticiones al día, y nunca más de unas 35 en una ejecución.

## Reglas

- La API key de AEMET NUNCA va al cliente ni al repositorio, ni a logs o salidas. Solo se usa en `scripts/` durante la descarga, leída de `process.env`.
- Toda la descarga de datos ocurre en `scripts/fetch-weather.ts` y `scripts/fuentes/`. Los componentes y páginas solo leen JSON de `src/data/`.
- `src/data/` y `public/radar/` están en `.gitignore`.
- `public/google9134727e263080cc.html` es la verificación de Google Search Console: no se borra.
- Si falta el dato de AEMET de un municipio, la página usa Open-Meteo y lo indica. Nunca se rompe el build por un municipio.
- Mostrar siempre la hora de última actualización (`meta.updatedAt`: el dato de predicción u observación más reciente; la RIA no cuenta) y avisar si tiene más de 2 h.
- Atribución obligatoria en el pie: "Información elaborada por la Agencia Estatal de Meteorología", "Weather data by Open-Meteo.com (CC BY 4.0)", IGN (CC BY 4.0) e INE; en `/agro/`, la de la RIA; en `/radar/`, "Radar de Almería (Níjar), © AEMET" con enlace al aviso legal; en `/playas/`, `ATRIBUCION_PLAYAS`; en `/mar/`, la del boletín FQXX47; en `/calima/`, `ATRIBUCION_CAMS` (Copernicus).
- Fechas y horas en zona `Europe/Madrid`, formato español.
- Copy en español, en frase normal. Prohibido en la interfaz: etiquetas en mayúsculas, cadenas "A · B · C", numeraciones decorativas, "→" en enlaces y emojis.
- Accesibilidad: botones y enlaces reales, `aria-pressed` en conmutadores, contraste AA, objetivos táctiles ≥44 px, `prefers-reduced-motion`. Todo mapa o gráfica tiene alternativa en tabla o lista.
- Mobile first. Lighthouse objetivo: 95+ en rendimiento y accesibilidad. Islas con `client:visible` salvo el buscador (`client:idle`). Los JSON del cliente se piden con `?v=${meta.updatedAt}`.
- SEO: una página estática por municipio con `<title>` tipo "El tiempo en {Municipio} (Almería) por horas", meta description, datos estructurados y sitemap (`@astrojs/sitemap`).

## Contrato de datos (`src/data/`)

- `meta.json`: `{ updatedAt, fallosAemet: string[], fuentes: { aemet: { actualizado, elaborado /*UTC sin Z*/, modo: "todos"|"municipio"|"cache", atom: { etag, lastModified } }, openMeteo: { actualizado, peso }, zonas: { actualizado, pasada, peso }, observaciones: { actualizado }, radar: { actualizado }, ria: { actualizado, ultimoDia }, avisos: { actualizado, comprobado /*última comprobación correcta de boletín nuevo*/, elaborado, origen: "opendata"|"web", avisos: number, rss: { lastModified } }, playas: { actualizado, elaborado /*UTC sin Z*/ /*y campos internos*/ }, mar: { actualizado, peso, costera: { elaborado /*UTC sin Z, inicio de validez*/, publicado, comprobado } }, calima: { actualizado, peso, pasadas: { europa, global } } } }` (tipo `FuentesMeta` de `src/lib/datos.ts`). `updatedAt` solo cuenta predicción, observación y radar: avisos, playas, mar, calima y RIA no lo mueven.
- `municipios.json`: `[{ id, nombre, slug, lat, lon, altitud }]` (id = código INE de 5 dígitos, p. ej. `04013`), desde `scripts/municipios-almeria.json`
- `municipios/{id}.json`: `{ aemetDiaria, aemetHoraria, openMeteo }` con el formato de los endpoints por municipio de AEMET (el tar `todos` se adapta a ese formato)
- `observaciones.json`: registros crudos de AEMET de las estaciones de la provincia, ordenados por idema y fint, como mucho 24 por estación (fint ≥ el más reciente − 23 h; fint en UTC, fin del periodo; viento en m/s). Lectura: `src/lib/observaciones.ts`, que pasa el viento a km/h. En un despliegue sin caché la serie solo tiene 12 h hasta que pasan 12 h de ejecuciones.
- `avisos.json`: `{ actualizado, elaborado, origen, avisos: Aviso[] }`, con los avisos amarillos, naranjas o rojos de las zonas 6104xx que no habían expirado al descargar (las páginas vuelven a filtrar con la hora del build). Lectura: `src/lib/avisos.ts`.
- `playas.json`: `{ actualizado, playas: Playa[] }`, siempre las 22 del maestro, con `dias: []` si no hay predicción. Lectura: `src/lib/playas.ts`.
- `mar.json`: `{ actualizado, horas /*75 h, hora de Madrid*/, puntos: [{ id, nombre, municipio, lat, lon, subzonaAemet, latModelo, lonModelo, serie: { ola, olaDir, olaPeriodo, fondo, fondoDir, fondoPeriodo, olaViento, agua, viento, vientoDir, racha } }], costera, costeraComprobada }`. En `costera`, `elaborado` es el inicio de validez (igual que `inicio`), no la publicación: la hora real es `publicado` (Last-Modified del XML público `aemet.es/xml/maritima/FQXX47MM.xml`, `publicadoOrigen: "web"`, o la hora de la primera descarga, `"descarga"`). La página nunca dice "elaborado" con ese campo. Lectura: `src/lib/mar.ts`.
- `calima.json`: `{ actualizado, pasadas: { europa, global }, finEuropa, horas, puntos: [{ id /*INE*/, nombre, polvo /*µg/m³*/, aod, dias }] }`, en el orden de `municipios.json`. Lectura: `src/lib/calima.ts`.
- `consumo.json`: consumo de AEMET y Open-Meteo de los últimos 14 días y de las últimas 200 ejecuciones.
- `zonas/{id}.json`: `{ municipio, actualizado, pasada, horas, ultimaHoraDetalle, zonas: [{ id, serie: { temp, hr, precip, prob, wc, viento, dir, racha, cape, nieve } }] }`
- `radar/radar.json` + GIF: `{ actualizado, imagenes: [{ archivo, hora, aprox, sha256 }] }`
- `agro.json`: estaciones RIA, último dato, días, acumulados 7/30 días, estados y estación de referencia por municipio

Versionados en `scripts/`:
- `municipios-almeria.json`, `nucleos-almeria.json` (núcleos IGN + población INE) y `zonas-almeria.json` (hasta 8 zonas por municipio, una por celda del modelo).
- `comarcas-almeria.json`: las 7 comarcas oficiales (Orden de 14/03/2003, BOJA n.º 59; Balanegra, segregada en 2015, va al Poniente), `{ fuente: { norma, boletin, url, notas }, comarcas: [{ slug, nombre, nombreOficial, descripcion, municipios /*INE*/ }] }`. Lectura: `src/lib/comarcas.ts`.
- `avisos-zonas-almeria.json`: las 6 zonas de aviso (4 de tierra y 2 costeras) con su polígono, y la zona de cada municipio.
- `playas-almeria.json`: maestro de las 22 playas de AEMET en Almería. El municipio es el término en el que cae la playa (Berja-Balanegra va a Balanegra, aunque AEMET la asigna a Berja) y las coordenadas erróneas del CSV se corrigen en `CORRECCIONES_PLAYAS` de `scripts/fuentes/playas.ts` (campo `nota`). El maestro manda sobre `playas.json` en nombre, municipio y coordenadas.
- `puntos-costa-almeria.json`: los 10 puntos de oleaje, de Adra a San Juan de los Terreros.

Endpoints generados en el build: `/mapa-horas.json` (48 h de los 103, con `tormenta`), `/zonas/{slug}.json` (zonas, Voronoi, contorno y máscara del término) y `/buscar.json` (municipios y núcleos para el buscador).

## Estructura de páginas

- Navegación (`src/layouts/Base.astro`): en escritorio, logo y buscador en la primera fila y debajo Previsión, Mapa, Radar, Avisos, Playas, Mar y el desplegable "Más" (Calima, Comarcas, Observaciones, Agro; botón con `aria-expanded`, se cierra con Escape, al pulsar fuera o al salir el foco). En móvil, menú plegable con las 10 secciones en una lista; sin JS se ven todas. El pie repite las 10 secciones y la 404 también enlaza a todas. Cada página pasa `activo` con su sección (tipo `Seccion`).
- `/`: banda de avisos (`AvisosBanda`, solo si hay avisos en vigor o en las próximas 24 h), mapa provincial por horas (capas lluvia, probabilidad, viento, rachas, temperatura y tormenta; deslizador de 48 h; modo foco con las zonas de un municipio), "Ahora en Almería capital", "Hoy en la provincia", "Por comarcas" (`ResumenComarcas`) y "Tus municipios"
- `/mapa/`: el mapa provincial a pantalla amplia y la lista de los 103
- `/[municipio]/`: migas con la comarca, banda de avisos de sus zonas, cabecera con el ahora y datos clave, conmutador "Vista general" / "Por zonas" (`?vista=zonas&zona=<id>`, solo con 2 o más zonas), diferencias entre zonas, meteograma 24/48 h, tabla por horas plegada, semana, "Playas de {municipio}" (`PlayasMunicipio`, en los 12 municipios con playas), fuentes, municipios cercanos y accesos a secciones (oleaje de sus puntos de costa en `/mar/#punto-{id}`, `/calima/` si se espera calima, observaciones)
- `/radar/`: radar regional de AEMET con animación de las últimas imágenes
- `/avisos/`: banda de basalto con el nivel más alto y el estado, mapa SVG de las 6 zonas (4 de tierra y 2 costeras; relleno del nivel en vigor, rayado si solo está previsto), tarjetas de avisos en vigor y previstos (`#aviso-N`), estado por zonas, tabla de los 103 municipios (alternativa del mapa), significado de los niveles y fuente
- `/playas/`: las 22 playas de AEMET por municipio, a lo largo de la costa de Adra a Pulpí, con hoy y mañana (estado del mar, cielo, oleaje, viento, agua, máxima y UV), panel "Hoy en la costa" y filtros por comarca y "Solo mar en calma hoy"
- `/playas/[playa]/`: ficha de cada playa con hoy y los días que da AEMET (mañana y tarde), altura de la ola del modelo en el punto de costa más cercano (≤30 km), dónde está, otras playas y datos estructurados `Beach`
- `/mar/`: boletín costero FQXX47 de AEMET (aviso destacado, Costa Sur, Costa Oriental, Alborán), tabla "Ahora en la costa" de los 10 puntos, franjas SVG de oleaje de 72 h y detalle por punto cada 3 h (`#punto-{id}`); el estado Douglas se calcula con la ola redondeada a 1 decimal
- `/calima/`: mapa SVG de los 103 términos por días con selector, gráfica provincial con umbrales, tabla por días (`#tabla-provincia`) y por municipio (`#tabla-municipios`), niveles y fuentes; atribución de CAMS en el pie
- `/comarcas/`: mapa provincial con las 7 comarcas enlazadas, tarjetas "Hoy en cada comarca" y municipios de cada una, con la norma (Orden de 14/03/2003)
- `/comarcas/[comarca]/`: mapa SVG de máximas de hoy, paneles de hoy y mañana y comparativa municipio a municipio ordenable (conmutador Hoy/Mañana)
- `/observaciones/`: estaciones de AEMET de la provincia con extremos, mapa SVG, tabla con la antigüedad del dato y serie horaria plegable por estación (`#serie-{idema}`)
- `/agro/`: ETo y balance de riego, invernadero frente a interior, helada y calor, lluvia y viento acumulados y estado de las estaciones RIA
- `/404`: buscador y accesos a las secciones
- Los mapas de avisos, calima, comarcas y observaciones son SVG generados en el build (sin Leaflet) a partir de `public/municipios.geojson` (`src/lib/geozonas.ts`, `src/components/ComarcaGeo.ts`).
- Los componentes con muchas celdas o trazados (tablas de 103 filas, series, mapas SVG) usan `<style is:global>` con un prefijo propio (`cc-`, `obs-`, `cp-`, `comarca-mapa`…) para no repetir `data-astro-cid` en cada elemento.

## Hoja de ruta

1. Municipio + portada + despliegue: hecho
2. Mapa, gráficas, comarcas y observaciones: hecho
3. Avisos (CAP XML), playas, mar y calima: hecho
4. Agro, radar, zonas de predicción, rediseño y cadencias por fuente: hecho
