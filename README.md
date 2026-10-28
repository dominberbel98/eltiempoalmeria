# eltiempoalmeria.es

Previsión del tiempo por horas para los 103 municipios de Almería. Sitio estático (Astro + islas React + Tailwind) que se regenera cada hora en GitHub Actions y se publica en GitHub Pages. Diseño basado en el prototipo «Almería · Cielo» v1.

## Puesta en marcha

```bash
npm install
npm run fetch:data   # descarga datos a src/data/
npm run dev          # http://localhost:4321
npm run build        # astro check + build estático en dist/
```

Sin `AEMET_API_KEY` el script funciona en **modo local**: solo descarga Open-Meteo, usa la lista de municipios de respaldo (`scripts/municipios-almeria.json`) y marca todos como fallo de AEMET. En CI (`CI=true`) la clave es obligatoria.

```bash
AEMET_API_KEY=tu_clave npm run fetch:data
```

## Despliegue

1. Sube el proyecto a un repositorio de GitHub (rama `main`).
2. Settings → Secrets and variables → Actions → crea `AEMET_API_KEY`.
3. Settings → Pages → Source: **GitHub Actions**. Si usas el dominio propio, configúralo ahí.
4. `.github/workflows/deploy.yml` descarga datos, compila y publica en cada push y cada hora (minuto 17).

## Qué hay

- `/`: buscador (sin tildes, con «usar mi ubicación»), favoritos guardados en el navegador, tarjeta de la capital, extremos del día, mapa de temperaturas (Leaflet + límites IGN) y lista de los 103 municipios.
- `/{municipio}/`: estado actual, «el día en un vistazo», gráfica hora a hora (temperatura, lluvia, viento), tabla de 48 h (temperatura, sensación, probabilidad y cantidad de lluvia, viento y rachas con dirección, humedad, UV y nubosidad), 7 días, orto y ocaso, mapa y municipios cercanos, datos estructurados.
- `/mapa.json`: temperatura actual de todos los municipios, compartida por los mapas.

## Datos

- `scripts/fetch-weather.ts` es el único sitio que descarga datos. Las páginas solo leen `src/data/`.
- `src/lib/tiempo.ts` combina las fuentes: AEMET manda en temperatura, sensación, humedad, precipitación y estado del cielo; Open-Meteo aporta viento, rachas, UV, nubosidad y probabilidad horaria, y lo cubre todo si falta AEMET (la página lo indica).
- `scripts/municipios-almeria.json`: 103 municipios (código INE, coordenadas, altitud) obtenidos de Wikidata y Open-Meteo. Solo se usa si no está disponible el maestro de AEMET.
