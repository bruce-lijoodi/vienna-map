# Vienna Explorer

An interactive web map of Vienna built to help tourists and new residents explore the city's key facilities and environmental conditions.

## Features

- **District choropleth** — visualises the Urban Heat Vulnerability Index (UHVI) across Vienna's 23 districts
- **Radius circle** — drag anywhere on the map; the right panel updates live with counts of nearby facilities
- **Address search** — jump to any Vienna address via OpenStreetMap geocoding
- **Facility layers** — toggle playgrounds, kindergartens, schools, parks, advisory centers, defibrillators, cultural summer locations, tourist spots, city payment offices, and accessible bank branches
- **District popups** — click any district for its name, area, and heat vulnerability score
- **Facility popups** — click any point for detailed information

## Tech Stack

| Tool | Purpose |
|---|---|
| [MapLibre GL](https://maplibre.org/) | WebGL map rendering |
| [Turf.js](https://turfjs.org/) | Spatial analysis (radius filtering, centroids, intersections) |
| [Vite](https://vitejs.dev/) | Dev server and build tool |
| CartoDB Positron | Basemap tiles |
| data.wien.gv.at WFS | Live feeds for playgrounds, kindergartens, schools, parks |
| Nominatim (OpenStreetMap) | Address geocoding |

## Running Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in your browser.

## Data Sources

- District boundaries — City of Vienna Open Data
- Urban Heat Vulnerability Index — City of Vienna (250 sub-districts, aggregated to 23 districts)
- Facility datasets — [data.wien.gv.at](https://data.wien.gv.at) (WFS and GeoJSON)

## Adding a New Dataset

1. Drop a `.json` or `.csv` file into `public/data/`
2. Add one line to `public/data/layers.json`:
```json
{ "id": "my-layer", "file": "my-file.json", "color": "#e74c3c", "label": "My Layer" }
```
CSV files need `lat`/`latitude` and `lng`/`lon`/`longitude` columns. Everything else — the toggle button, map layer, radius count, and popup — is automatic.
