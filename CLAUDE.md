# eltiempoalmeria.es

Web del tiempo muy detallada y exclusivamente para la provincia de Almería (103 municipios).
Sitio estático: los datos se descargan en GitHub Actions, se generan las páginas y se despliega en GitHub Pages.

## Stack

- Astro (generación estática) + componentes React (islands) + TypeScript strict
- Tailwind CSS
- Gráficas: uPlot o Recharts, cargadas solo en cliente (`client:visible`)
- Mapa: MapLibre GL o Leaflet con GeoJSON de límites municipales de Almería (CNIG/IGN)
- Node 22, `tsx` para scripts

## Comandos

- `npm run dev`: servidor local
- `npm run fetch:data`: descarga datos a `src/data/` (necesita `AEMET_API_KEY` en el entorno)
- `npm run build`: build estático en `dist/`. Debe pasar sin errores antes de dar algo por terminado.

## Fuentes de datos

1. **AEMET OpenData**: predicción municipal diaria y horaria, observación de estaciones, avisos, playas, predicción costera, radar.
   - Cada llamada es en dos pasos: el endpoint devuelve `{ estado, datos }` y hay que pedir la URL de `datos`.
   - Algunas respuestas vienen en ISO-8859-15.
   - Tiene límite de peticiones: máximo ~45/min, con reintentos ante 429.
2. **Open-Meteo**: modelo horario de alta resolución (viento, rachas, UV, nubes, prob. precipitación) y polvo sahariano (air-quality API, variable `dust`).
   - Licencia CC BY 4.0, uso gratuito solo no comercial. Si la web lleva publicidad, hace falta plan comercial.
3. Fase posterior: Red de Información Agroclimática (RIA) de la Junta de Andalucía para la página agro (ETo, invernaderos).

## Reglas

- La API key de AEMET NUNCA va al cliente ni al repositorio. Solo se usa en `scripts/` durante el build, leída de `process.env`.
- Toda la descarga de datos ocurre en `scripts/fetch-weather.ts`. Los componentes y páginas solo leen JSON de `src/data/`.
- `src/data/` está en `.gitignore`.
- Si falta el dato de AEMET de un municipio, la página usa Open-Meteo y lo indica. Nunca se rompe el build por un municipio.
- Mostrar siempre la hora de última actualización (`src/data/meta.json`).
- Atribución obligatoria en el footer: "Información elaborada por la Agencia Estatal de Meteorología" y "Weather data by Open-Meteo.com (CC BY 4.0)".
- Fechas y horas en zona `Europe/Madrid`, formato español.
- Mobile first. Lighthouse objetivo: 95+ en rendimiento y accesibilidad.
- SEO: una página estática por municipio con `<title>` tipo "El tiempo en {Municipio} (Almería) por horas", meta description, datos estructurados y sitemap (`@astrojs/sitemap`).

## Contrato de datos (`src/data/`)

- `meta.json`: `{ updatedAt, fallosAemet: string[] }`
- `municipios.json`: `[{ id, nombre, slug, lat, lon, altitud }]` (id = código INE de 5 dígitos, p. ej. `04013`)
- `municipios/{id}.json`: `{ aemetDiaria, aemetHoraria, openMeteo }`
- `observaciones.json`: estaciones AEMET dentro de la provincia, últimas 24 h

## Estructura de páginas

- `/`: mapa de la provincia con temperatura y cielo por municipio, avisos activos, resumen por comarcas, buscador de municipio
- `/[municipio]/`: próximas 48 h por horas (temp, sensación, prob. y cantidad de precipitación, viento y rachas con dirección, humedad, UV, nubosidad), 7 días, orto/ocaso, gráficas
- `/comarcas/[comarca]/`: comparativa de municipios de la comarca
- `/observaciones/`: estaciones en tiempo real (tabla + mapa)
- `/avisos/`: avisos AEMET vigentes para las zonas de Almería
- `/playas/` y `/playas/[playa]/`: predicción AEMET de playas
- `/mar/`: predicción costera, viento y oleaje
- `/calima/`: previsión de polvo en suspensión
- Fase 3: `/agro/`

## Hoja de ruta

1. Municipio + portada con lista (sin mapa) + despliegue funcionando
2. Mapa, comarcas, observaciones, gráficas
3. Avisos (CAP XML), playas, mar, calima
4. Agro, radar/satélite, optimizaciones (separar cadencias de actualización)
