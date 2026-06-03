import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import './style.css';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CENTER  = [16.3738, 48.2082];
const ZOOM    = 11;
const BASEMAP = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

const WFS_BASE = 'https://data.wien.gv.at/daten/geo?service=WFS&request=GetFeature&version=1.1.0&srsName=EPSG:4326&outputFormat=json&maxFeatures=2000&typeName=ogdwien:';

let FAMILY_LAYERS = []; // populated at runtime from /data/layers.json

// Choropleth: district area in km² → gold → dark ink
const AREA_COLOR = [
  'step', ['get', '_area'],
  '#e8d5a3',  //  0–5  km²
   5, '#c9a84c',
  10, '#a07a2a',
  20, '#6b4e15',
  40, '#3d3530',
];

// Choropleth: UHVI score → yellow → dark red
const UHVI_COLOR = [
  'step', ['coalesce', ['get', '_uhvi'], 0],
  '#cccccc',       // null / no data
  0.45, '#ffffb2',
  0.55, '#fecc5c',
  0.65, '#fd8d3c',
  0.75, '#f03b20',
  0.85, '#bd0026',
];

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let map;
let centerMarker;
let districtsGeoJSON;
let crimeGeoJSON;
const familyData = {};

const state = {
  mode:         'heat',
  hoveredId:    null,
  selectedId:   null,
  radiusKm:     1,
  radiusCenter: null,
  showHeatmap:  false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  FAMILY_LAYERS = await fetch('/data/layers.json').then(r => r.json()).catch(() => []);
  buildSkeleton();
  setStatus('Loading data…');

  let districts, crime, uhviText;
  try {
    [districts, crime, uhviText] = await Promise.all([
      fetch('/data/districts.geojson').then(r => r.json()),
      fetch('/data/crime.geojson').then(r => r.json()).catch(() => emptyFC()),
      fetch('/data/Urban Heat Vulnerability Index (UHVI) Vienna.csv').then(r => r.text()).catch(() => ''),
    ]);
  } catch {
    setStatus('Failed to load data — check console', true);
    return;
  }

  const uhviByDistrict = parseUHVI(uhviText);

  // Assign numeric IDs and computed properties
  districts.features.forEach((f, i) => {
    f.id = i;
    f.properties._area   = +(f.properties.FLAECHE / 1_000_000).toFixed(2);
    f.properties._crimes = 0;
    const distNum = Math.round(f.properties.BEZNR);
    f.properties._uhvi = uhviByDistrict[distNum] ?? null;
  });

  // Compute label centroids from actual polygon geometry
  const labels = {
    type: 'FeatureCollection',
    features: districts.features.map(f => {
      const c = turf.centerOfMass(f);
      c.properties = { district_num: Math.round(f.properties.BEZNR) };
      return c;
    }),
  };

  // Count crimes per district
  for (const pt of crime.features) {
    const point = turf.point(pt.geometry.coordinates);
    for (const district of districts.features) {
      if (turf.booleanPointInPolygon(point, district)) {
        district.properties._crimes++;
        break;
      }
    }
  }

  districtsGeoJSON = districts;
  crimeGeoJSON     = crime;

  buildLegend('heat');
  initMap(districts, labels, crime);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton HTML
// ─────────────────────────────────────────────────────────────────────────────

function buildSkeleton() {
  const familyCountRows = FAMILY_LAYERS.map(({ id, color, label }) => `
    <div class="popup-stat">
      <span style="display:flex;align-items:center;gap:6px">
        <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>${label}
      </span>
      <strong id="count-${id}">—</strong>
    </div>`).join('');

  document.getElementById('app').innerHTML = `
    <div id="map"></div>

    <header class="app-header">
      <h1>Vienna Explorer</h1>
      <span class="tagline">District &amp; Family Explorer</span>
    </header>

    <div class="search-bar" id="search-bar">
      <div class="search-input-wrap">
        <input class="search-input" id="search-input" type="text"
          placeholder="Search address in Vienna…" autocomplete="off" spellcheck="false" />
        <button class="search-btn" id="search-btn" title="Search">→</button>
      </div>
      <div class="search-results" id="search-results"></div>
    </div>

    <nav class="layer-switcher">
      <button class="layer-btn active" id="btn-toggle-all">
        <span class="dot" style="background:var(--gold)"></span><span id="toggle-all-label">Deselect All</span>
      </button>
      <div class="layer-divider"></div>
      <button class="layer-btn active" data-layer="heat">
        <span class="dot" style="background:#f03b20"></span>Heat Index
      </button>
      <div class="layer-divider"></div>
      ${FAMILY_LAYERS.map(({ id, color, label }) => `
      <button class="layer-btn active" data-toggle-layer="${id}">
        <span class="dot" style="background:${color}"></span>${label}
      </button>`).join('')}
    </nav>

    <aside class="map-panel">
      <div class="panel-title">Analysis</div>
      <div class="radius-row">
        <div class="radius-label">
          <span>Search Radius</span>
          <strong id="radius-val">1.0 km</strong>
        </div>
        <input id="radius-slider" type="range" min="0.5" max="10" step="0.5" value="1" />
      </div>
      <button class="panel-btn" id="btn-heatmap" disabled>⬡ Toggle Heatmap</button>
      <button class="panel-btn" id="btn-fit">⊞ Fit Vienna</button>
      <div class="status-text" id="status-text">Loading…</div>
      <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:2px">
        <div class="panel-title" style="margin-bottom:6px">Within Radius</div>
        <div class="popup-stat">
          <span style="display:flex;align-items:center;gap:6px">
            <span id="heat-radius-dot" style="width:8px;height:8px;border-radius:50%;background:#cccccc;flex-shrink:0;display:inline-block"></span>Heat Index
          </span>
          <strong id="heat-radius-val">—</strong>
        </div>
        ${familyCountRows}
      </div>
    </aside>

<div class="legend-panel" id="legend-panel">
      <h4>Area (km²)</h4>
      <div id="legend-rows"></div>
    </div>

    <div class="district-info" id="district-info">
      <span class="di-name" id="di-name">–</span>
      <div class="di-stats">
        <div class="di-stat">
          <span class="val" id="di-bezirk">–</span>
          <span class="lbl">Bezirk</span>
        </div>
        <div class="di-stat">
          <span class="val" id="di-area">–</span>
          <span class="lbl">km²</span>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Map
// ─────────────────────────────────────────────────────────────────────────────

function initMap(districts, labels, crime) {
  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP,
    center: CENTER,
    zoom: ZOOM,
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  map.on('load', () => {
    addSources(districts, labels, crime);
    addLayers();
    applyMode(state.mode);
    setupInteractions();
    wireControls();
    initCircle();
    loadFamilyData();
  });
}

function addSources(districts, labels, crime) {
  map.addSource('districts', { type: 'geojson', data: districts });
  map.addSource('labels',    { type: 'geojson', data: labels });
  map.addSource('crime', {
    type: 'geojson',
    data: crime,
    cluster: true,
    clusterMaxZoom: 14,
    clusterRadius: 40,
  });
  map.addSource('radius-circle', { type: 'geojson', data: emptyFC() });

  for (const { id } of FAMILY_LAYERS) {
    map.addSource(id, { type: 'geojson', data: emptyFC() });
  }
}

function addLayers() {
  // District fill — choropleth by area
  map.addLayer({
    id: 'districts-fill',
    type: 'fill',
    source: 'districts',
    paint: {
      'fill-color': AREA_COLOR,
      'fill-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 0.72,
        ['boolean', ['feature-state', 'hover'],    false], 0.50,
        0.30,
      ],
    },
  });

  // District outline
  map.addLayer({
    id: 'districts-line',
    type: 'line',
    source: 'districts',
    paint: {
      'line-color': '#1a1612',
      'line-opacity': 0.55,
      'line-width': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], 2.5,
        ['boolean', ['feature-state', 'hover'],    false], 1.5,
        0.7,
      ],
    },
  });

  // District number labels (from centroids)
  map.addLayer({
    id: 'district-labels',
    type: 'symbol',
    source: 'labels',
    layout: {
      'text-field':         ['to-string', ['get', 'district_num']],
      'text-font':          ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size':          12,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color':       '#1a1612',
      'text-halo-color':  'rgba(245,240,232,0.9)',
      'text-halo-width':  2,
    },
  });

  // Crime clusters
  map.addLayer({
    id: 'crime-clusters',
    type: 'circle',
    source: 'crime',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color':        ['step', ['get', 'point_count'], '#e07070', 10, '#c0392b', 50, '#7b1a10'],
      'circle-radius':       ['step', ['get', 'point_count'], 14, 10, 22, 50, 32],
      'circle-opacity':      0.85,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#f5f0e8',
    },
    layout: { visibility: 'none' },
  });

  map.addLayer({
    id: 'crime-cluster-count',
    type: 'symbol',
    source: 'crime',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font':  ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size':  11,
      visibility:   'none',
    },
    paint: { 'text-color': '#fff' },
  });

  map.addLayer({
    id: 'crime-points',
    type: 'circle',
    source: 'crime',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius':       5,
      'circle-color':        '#c0392b',
      'circle-opacity':      0.8,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#f5f0e8',
    },
    layout: { visibility: 'none' },
  });

  // Radius search circle
  map.addLayer({
    id: 'radius-fill',
    type: 'fill',
    source: 'radius-circle',
    paint: { 'fill-color': '#2c5f8a', 'fill-opacity': 0.12 },
  });

  map.addLayer({
    id: 'radius-line',
    type: 'line',
    source: 'radius-circle',
    paint: { 'line-color': '#2c5f8a', 'line-width': 2.5 },
  });

  for (const { id, color } of FAMILY_LAYERS) {
    map.addLayer({
      id: `${id}-points`,
      type: 'circle',
      source: id,
      paint: {
        'circle-radius':       ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8],
        'circle-color':        color,
        'circle-opacity':      0.85,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#f5f0e8',
      },
      layout: { visibility: 'visible' },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactions
// ─────────────────────────────────────────────────────────────────────────────

function setupInteractions() {
  // Hover — districts
  map.on('mousemove', 'districts-fill', e => {
    const id = e.features[0]?.id;
    if (id == null || id === state.hoveredId) return;
    if (state.hoveredId != null)
      map.setFeatureState({ source: 'districts', id: state.hoveredId }, { hover: false });
    state.hoveredId = id;
    map.setFeatureState({ source: 'districts', id }, { hover: true });
    showHoverInfo(e.features[0].properties);
    map.getCanvas().style.cursor = 'pointer';
  });

  map.on('mouseleave', 'districts-fill', () => {
    if (state.hoveredId != null)
      map.setFeatureState({ source: 'districts', id: state.hoveredId }, { hover: false });
    state.hoveredId = null;
    document.getElementById('district-info').classList.remove('visible');
    map.getCanvas().style.cursor = '';
  });

  // Click — districts: move circle center, also select in districts mode
  map.on('click', 'districts-fill', e => {
    const onCrime = map.queryRenderedFeatures(e.point, { layers: ['crime-points', 'crime-clusters'] });
    if (!onCrime.length) {
      centerMarker?.setLngLat(e.lngLat);
      moveCircleTo(e.lngLat);
    }

    if (state.mode === 'districts') {
      toggleSelect(e.features[0].id, e.features[0].properties, e.lngLat);
    }
  });

  // Click — individual crime point
  map.on('click', 'crime-points', e => {
    openPopup(e.lngLat, buildCrimeCard(e.features[0].properties));
  });

  // Cursor on crime
  map.on('mouseenter', 'crime-points',   () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'crime-points',   () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'crime-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'crime-clusters', () => { map.getCanvas().style.cursor = ''; });

  // Family layers — click popup + cursor
  for (const { id, label } of FAMILY_LAYERS) {
    const layerId = `${id}-points`;
    map.on('click', layerId, e => {
      openPopup(e.lngLat, buildFamilyCard(label, e.features[0].properties));
    });
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

function toggleSelect(id, props, lngLat) {
  const prev = state.selectedId;

  if (prev != null) map.setFeatureState({ source: 'districts', id: prev }, { selected: false });
  closePopup();

  if (prev === id) { state.selectedId = null; return; }   // second click deselects

  state.selectedId = id;
  map.setFeatureState({ source: 'districts', id }, { selected: true });
  openPopup(lngLat, buildDistrictCard(props));
}

// ─────────────────────────────────────────────────────────────────────────────
// Popups
// ─────────────────────────────────────────────────────────────────────────────

let activePopup = null;

function closePopup() { activePopup?.remove(); activePopup = null; }

function openPopup(lngLat, html) {
  closePopup();
  activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);

  activePopup.on('close', () => {
    if (state.selectedId != null)
      map.setFeatureState({ source: 'districts', id: state.selectedId }, { selected: false });
    state.selectedId = null;
  });
}

function buildDistrictCard(p) {
  const num  = Math.round(p.BEZNR);
  const name = p.NAMEK || `Bezirk ${num}`;
  const uhvi = p._uhvi != null ? p._uhvi.toFixed(3) : '—';

  return `
    <div class="map-popup-card">
      <h4>${name}</h4>
      <span class="popup-meta" style="background:var(--gold)">Bezirk ${num}</span>
      <div class="popup-stat"><span>Area</span><strong>${p._area} km²</strong></div>
      <div class="popup-stat"><span>Heat vulnerability</span><strong>${uhvi}</strong></div>
    </div>`;
}

function buildCrimeCard(p) {
  const rows = Object.entries(p)
    .filter(([k]) => !k.startsWith('_') && k !== 'cluster_id')
    .map(([k, v]) => `<div class="popup-stat"><span>${k}</span><strong>${v}</strong></div>`)
    .join('') || '<p style="font-size:.75rem;color:var(--ink-muted);padding:4px 0">No attributes available</p>';
  return `<div class="map-popup-card"><h4>Crime Incident</h4>${rows}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover info bar
// ─────────────────────────────────────────────────────────────────────────────

function showHoverInfo(p) {
  document.getElementById('di-name').textContent    = p.NAMEK || `Bezirk ${Math.round(p.BEZNR)}`;
  document.getElementById('di-bezirk').textContent  = Math.round(p.BEZNR);
  document.getElementById('di-area').textContent    = p._area;
  document.getElementById('district-info').classList.add('visible');
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend
// ─────────────────────────────────────────────────────────────────────────────

function buildLegend(mode = 'districts') {
  const panel = document.getElementById('legend-panel');
  const isHeat = mode === 'heat';

  panel.querySelector('h4').textContent = isHeat ? 'Heat Vulnerability' : 'Area (km²)';

  const items = isHeat ? [
    { color: '#cccccc', label: 'No data'       },
    { color: '#ffffb2', label: '< 0.55 (Low)'  },
    { color: '#fecc5c', label: '0.55 – 0.65'   },
    { color: '#fd8d3c', label: '0.65 – 0.75'   },
    { color: '#f03b20', label: '0.75 – 0.85'   },
    { color: '#bd0026', label: '> 0.85 (High)' },
  ] : [
    { color: '#e8d5a3', label: '0–5 km²'   },
    { color: '#c9a84c', label: '5–10 km²'  },
    { color: '#a07a2a', label: '10–20 km²' },
    { color: '#6b4e15', label: '20–40 km²' },
    { color: '#3d3530', label: '> 40 km²'  },
  ];

  document.getElementById('legend-rows').innerHTML = items.map(s => `
    <div class="legend-row">
      <div class="legend-swatch" style="background:${s.color}"></div>
      <span>${s.label}</span>
    </div>`).join('');

  panel.classList.add('visible');
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

function wireControls() {
  // Mode buttons (Districts / Crime) — mutually exclusive
  document.querySelectorAll('.layer-btn[data-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.dataset.layer;
      if (layer === state.mode) return;
      state.mode = layer;
      document.querySelectorAll('.layer-btn[data-layer]').forEach(b =>
        b.classList.toggle('active', b.dataset.layer === layer));
      applyMode(layer);
    });
  });

  // Family layer toggles — independent on/off
  function syncToggleAllBtn() {
    const datasetsOff = FAMILY_LAYERS.every(({ id }) =>
      map.getLayoutProperty(`${id}-points`, 'visibility') !== 'visible'
    );
    const allOff = datasetsOff && state.mode !== 'heat';
    document.getElementById('toggle-all-label').textContent = allOff ? 'Select All' : 'Deselect All';
    document.getElementById('btn-toggle-all').classList.toggle('active', !allOff);
  }

  document.querySelectorAll('.layer-btn[data-toggle-layer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layerId = `${btn.dataset.toggleLayer}-points`;
      const isVisible = map.getLayoutProperty(layerId, 'visibility') === 'visible';
      map.setLayoutProperty(layerId, 'visibility', isVisible ? 'none' : 'visible');
      btn.classList.toggle('active', !isVisible);
      syncToggleAllBtn();
    });
  });

  document.getElementById('btn-toggle-all').addEventListener('click', () => {
    const anyActive = FAMILY_LAYERS.some(({ id }) =>
      map.getLayoutProperty(`${id}-points`, 'visibility') === 'visible'
    ) || state.mode === 'heat';

    // Toggle dataset point layers
    const newVis = anyActive ? 'none' : 'visible';
    FAMILY_LAYERS.forEach(({ id }) => {
      map.setLayoutProperty(`${id}-points`, 'visibility', newVis);
    });
    document.querySelectorAll('.layer-btn[data-toggle-layer]').forEach(b =>
      b.classList.toggle('active', !anyActive)
    );

    // Toggle Heat Index
    const newMode = anyActive ? 'districts' : 'heat';
    state.mode = newMode;
    document.querySelectorAll('.layer-btn[data-layer]').forEach(b =>
      b.classList.toggle('active', b.dataset.layer === newMode)
    );
    applyMode(newMode);

    syncToggleAllBtn();
  });

  // Radius slider
  const slider = document.getElementById('radius-slider');
  slider.addEventListener('input', () => {
    state.radiusKm = +slider.value;
    document.getElementById('radius-val').textContent = `${state.radiusKm.toFixed(1)} km`;
    if (centerMarker) moveCircleTo(centerMarker.getLngLat());
  });

  // Heatmap toggle (ready for when crime data arrives)
  document.getElementById('btn-heatmap').addEventListener('click', () => {
    state.showHeatmap = !state.showHeatmap;
    setStatus(state.showHeatmap ? 'Heatmap on — load crime data to see results' : 'Heatmap off');
  });

  // Fit button — reset view and circle to Vienna center
  document.getElementById('btn-fit').addEventListener('click', () => {
    map.flyTo({ center: CENTER, zoom: ZOOM, duration: 800 });
    centerMarker?.setLngLat(CENTER);
    moveCircleTo({ lng: CENTER[0], lat: CENTER[1] });
  });

  wireSearch();
}

function wireSearch() {
  const input   = document.getElementById('search-input');
  const btn     = document.getElementById('search-btn');
  const results = document.getElementById('search-results');
  let debounce  = null;

  async function runSearch(q) {
    if (!q || q.length < 2) { hideResults(); return; }
    const params = new URLSearchParams({
      q, format: 'json', limit: '5',
      countrycodes: 'at',
      viewbox: '16.18,48.12,16.58,48.32',
      bounded: '1',
      addressdetails: '1',
    });
    try {
      const items = await fetch(
        `https://nominatim.openstreetmap.org/search?${params}`,
        { headers: { 'Accept-Language': 'en' } }
      ).then(r => r.json());
      renderResults(items);
    } catch { /* network failure — stay silent */ }
  }

  function renderResults(items) {
    if (!items.length) {
      results.innerHTML = '<div class="search-no-results">No results found in Vienna</div>';
      results.classList.add('visible');
      return;
    }
    results.innerHTML = items.map(item => {
      const parts  = item.display_name.split(', ');
      const name   = parts.slice(0, 2).join(', ');
      const detail = item.address?.suburb || item.address?.city_district || item.address?.quarter || '';
      return `<button class="search-result-item"
          data-lat="${item.lat}" data-lon="${item.lon}" data-name="${name.replace(/"/g, '&quot;')}">
        <span class="search-result-name">${name}</span>
        ${detail ? `<span class="search-result-detail">${detail}, Vienna</span>` : ''}
      </button>`;
    }).join('');
    results.classList.add('visible');

    results.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const lat    = parseFloat(el.dataset.lat);
        const lon    = parseFloat(el.dataset.lon);
        const lngLat = { lng: lon, lat };
        map.flyTo({ center: [lon, lat], zoom: 15, duration: 900 });
        centerMarker.setLngLat(lngLat);
        moveCircleTo(lngLat);
        input.value = el.dataset.name;
        hideResults();
      });
    });
  }

  function hideResults() {
    results.classList.remove('visible');
    results.innerHTML = '';
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(input.value.trim()), 350);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { clearTimeout(debounce); runSearch(input.value.trim()); }
    if (e.key === 'Escape') { hideResults(); input.blur(); }
  });

  btn.addEventListener('click', () => {
    clearTimeout(debounce);
    runSearch(input.value.trim());
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('search-bar').contains(e.target)) hideResults();
  });
}

function applyMode(mode) {
  const crimeVis = mode === 'crime' ? 'visible' : 'none';
  ['crime-clusters', 'crime-cluster-count', 'crime-points'].forEach(id =>
    map.setLayoutProperty(id, 'visibility', crimeVis));

  document.getElementById('btn-heatmap').disabled = mode !== 'crime';

  map.setPaintProperty('districts-fill', 'fill-color',
    mode === 'heat' ? UHVI_COLOR : AREA_COLOR);

  buildLegend(mode);

  const hasCrime = crimeGeoJSON?.features?.length > 0;
  setStatus(mode === 'crime'
    ? (hasCrime ? 'Click anywhere to search by radius' : 'No crime data loaded yet')
    : mode === 'heat'
    ? 'Hover a district to see its heat vulnerability score'
    : 'Click a district to select it and draw a radius');
}

// ─────────────────────────────────────────────────────────────────────────────
// Radius circle
// ─────────────────────────────────────────────────────────────────────────────

function initCircle() {
  centerMarker = new maplibregl.Marker({ draggable: true, color: '#2c5f8a' })
    .setLngLat(CENTER)
    .addTo(map);

  // Draw immediately
  moveCircleTo({ lng: CENTER[0], lat: CENTER[1] });
  setStatus('Drag the marker or click the map to reposition the radius');

  // Throttled live redraw while dragging
  let scheduled = false;
  centerMarker.on('drag', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      moveCircleTo(centerMarker.getLngLat());
      scheduled = false;
    });
  });

  centerMarker.on('dragend', () => moveCircleTo(centerMarker.getLngLat()));
}

function moveCircleTo(lngLat) {
  state.radiusCenter = lngLat;
  const center = [lngLat.lng, lngLat.lat];
  const circle = turf.circle(center, state.radiusKm, { steps: 64, units: 'kilometers' });
  map.getSource('radius-circle').setData(circle);

  setStatus(`Radius: ${state.radiusKm.toFixed(1)} km — drag to reposition`);

  updateRadiusOverlay(circle);
}

function updateRadiusOverlay(circle) {
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(circle);

  for (const { id } of FAMILY_LAYERS) {
    const data = familyData[id];
    const inCircle = data?.features?.length
      ? data.features.filter(f => {
          if (f.geometry?.type !== 'Point') return false;
          const [lng, lat] = f.geometry.coordinates;
          if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) return false;
          return turf.booleanPointInPolygon(turf.point([lng, lat]), circle);
        })
      : [];

    map.getSource(id)?.setData({ type: 'FeatureCollection', features: inCircle });

    const el = document.getElementById(`count-${id}`);
    if (el) el.textContent = data?.features?.length ? inCircle.length : '—';
  }

  const score = getHeatInRadius(circle);
  const { label, color } = uhviCategory(score);
  const dot = document.getElementById('heat-radius-dot');
  const val = document.getElementById('heat-radius-val');
  if (dot) dot.style.background = color;
  if (val) val.textContent = score != null ? `${score.toFixed(3)} · ${label}` : '—';
}

function countCrimesInRadius(circle) {
  if (!crimeGeoJSON?.features.length) return 0;
  return crimeGeoJSON.features.filter(f =>
    turf.booleanPointInPolygon(turf.point(f.geometry.coordinates), circle)
  ).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// UHVI
// ─────────────────────────────────────────────────────────────────────────────

function getHeatInRadius(circle) {
  if (!districtsGeoJSON) return null;
  const scores = districtsGeoJSON.features
    .filter(f => f.properties._uhvi != null && turf.booleanIntersects(circle, f))
    .map(f => f.properties._uhvi);
  if (!scores.length) return null;
  return +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4);
}

function uhviCategory(score) {
  if (score == null)  return { label: '—',           color: '#cccccc' };
  if (score < 0.55)   return { label: 'Low',          color: '#ffffb2' };
  if (score < 0.65)   return { label: 'Moderate',     color: '#fecc5c' };
  if (score < 0.75)   return { label: 'Mod–High',     color: '#fd8d3c' };
  if (score < 0.85)   return { label: 'High',         color: '#f03b20' };
  return                     { label: 'Very High',    color: '#bd0026' };
}

function parseUHVI(text) {
  if (!text) return {};
  const lines = text.trim().split('\n');
  const headers = lines[0].split(';').map(h => h.trim());
  const codeIdx = headers.indexOf('DISTRICT_CODE');
  const uhviIdx = headers.indexOf('AVG_UHVI_A');
  if (codeIdx === -1 || uhviIdx === -1) return {};

  const sums = {}, counts = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(';');
    const distNum = parseInt(cols[codeIdx]) / 100 - 900;
    const uhvi = parseFloat(cols[uhviIdx].replace(',', '.'));
    if (isNaN(distNum) || isNaN(uhvi)) continue;
    sums[distNum]   = (sums[distNum]   || 0) + uhvi;
    counts[distNum] = (counts[distNum] || 0) + 1;
  }

  const result = {};
  for (const k of Object.keys(sums))
    result[+k] = +(sums[k] / counts[k]).toFixed(4);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Family data
// ─────────────────────────────────────────────────────────────────────────────

function loadFamilyData() {
  FAMILY_LAYERS.forEach(({ id, wfsType, file }) => {
    const fetchUrl = file ? `/data/${file}` : WFS_BASE + wfsType;
    const isCSV = fetchUrl.toLowerCase().endsWith('.csv');

    fetch(fetchUrl)
      .then(r => { if (!r.ok) throw new Error(r.status); return isCSV ? r.text() : r.json(); })
      .then(raw => isCSV ? csvToGeoJSON(raw) : raw)
      .then(data => {
        familyData[id] = data;
        if (state.radiusCenter) {
          const center = [state.radiusCenter.lng, state.radiusCenter.lat];
          const circle = turf.circle(center, state.radiusKm, { units: 'kilometers' });
          updateRadiusOverlay(circle);
        }
      })
      .catch(() => { familyData[id] = emptyFC(); });
  });
}

function csvToGeoJSON(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const latKey = headers.find(h => /^(lat|latitude)$/i.test(h));
  const lngKey = headers.find(h => /^(lng|lon|longitude)$/i.test(h));
  if (!latKey || !lngKey) return emptyFC();

  const features = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const props = Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
    const lat = parseFloat(props[latKey]);
    const lng = parseFloat(props[lngKey]);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
  }).filter(Boolean);

  return { type: 'FeatureCollection', features };
}

function buildFamilyCard(layerLabel, p) {
  const name = p.BEZEICHNUNG || p.STANDORT || p.FILIALE || p.NAME || p.OBJNAME || layerLabel;
  const addr = p.ADRESSE || p.STRASSE || p.STREET || '';
  const rows = [
    addr                && `<div class="popup-stat"><span>Address</span><strong>${addr}</strong></div>`,
    p.BEZIRK            && `<div class="popup-stat"><span>Bezirk</span><strong>${p.BEZIRK}</strong></div>`,
    p.STOCK             && `<div class="popup-stat"><span>Floor</span><strong>${p.STOCK}</strong></div>`,
    p.TELEFON           && `<div class="popup-stat"><span>Phone</span><strong>${p.TELEFON}</strong></div>`,
    p.PHONE             && `<div class="popup-stat"><span>Phone</span><strong>${p.PHONE}</strong></div>`,
    p.CATEGORY_NAME     && `<div class="popup-stat"><span>Category</span><strong>${p.CATEGORY_NAME}</strong></div>`,
    p.SUBCATEGORY_NAME  && `<div class="popup-stat"><span>Type</span><strong>${p.SUBCATEGORY_NAME}</strong></div>`,
    p.OEFFNUNGSZEIT     && `<div class="popup-stat"><span>Hours</span><strong>${p.OEFFNUNGSZEIT}</strong></div>`,
    p.INFO              && `<div class="popup-stat"><span>Location</span><strong>${p.INFO}</strong></div>`,
    p.HINWEIS           && `<div class="popup-stat"><span>Availability</span><strong>${p.HINWEIS}</strong></div>`,
    p.ERREICHBARKEIT    && `<div class="popup-stat"><span>Transit</span><strong>${p.ERREICHBARKEIT}</strong></div>`,
    p.TRAEGER           && `<div class="popup-stat"><span>Operator</span><strong>${p.TRAEGER}</strong></div>`,
    p.SCHULTYP          && `<div class="popup-stat"><span>Type</span><strong>${p.SCHULTYP}</strong></div>`,
    p.FLAECHE           && `<div class="popup-stat"><span>Area</span><strong>${p.FLAECHE} m²</strong></div>`,
    p.WEBLINK1          && `<div class="popup-stat"><span>Website</span><strong><a href="${p.WEBLINK1}" target="_blank" style="color:var(--blue)">Open ↗</a></strong></div>`,
    p.WEBSITE           && `<div class="popup-stat"><span>Website</span><strong><a href="${p.WEBSITE}" target="_blank" style="color:var(--blue)">Open ↗</a></strong></div>`,
  ].filter(Boolean).join('');
  return `
    <div class="map-popup-card">
      <h4>${name}</h4>
      <span class="popup-meta" style="background:var(--green)">${layerLabel}</span>
      ${rows || '<p style="font-size:.75rem;color:var(--ink-muted);padding:4px 0">No attributes available</p>'}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('status-text');
  if (!el) return;
  el.textContent = msg;
  el.className = `status-text${isError ? ' error' : ''}`;
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

main();
