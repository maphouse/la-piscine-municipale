// FREE ADULT SWIM — map application.
import { poolState, montrealNow, COLORS, DAY_KEYS } from './symbology.js';
import { STRINGS } from './i18n.js';
import { downloadICS } from './ics.js';

const MONTREAL = { center: [-73.61, 45.53], zoom: 11 };
const BASEMAP = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

let lang = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
let pools = [];
let map;

const t = () => STRINGS[lang];

async function init() {
  const res = await fetch('data/pools.json', { cache: 'no-cache' });
  const data = await res.json();
  pools = data.pools;

  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP,
    center: MONTREAL.center,
    zoom: MONTREAL.zoom,
    attributionControl: false,
  });
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }), 'top-right');

  map.on('load', () => {
    map.addSource('pools', { type: 'geojson', data: featureCollection() });
    map.addLayer({
      id: 'pools',
      type: 'circle',
      source: 'pools',
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'opacity'],
        // Thick, fully-opaque white ring for figure-ground on every marker,
        // including the faint grey ones.
        'circle-stroke-width': 3,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-opacity': 1,
      },
    });

    map.on('click', 'pools', onMarkerClick);
    map.on('mouseenter', 'pools', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'pools', () => (map.getCanvas().style.cursor = ''));
  });

  renderChrome();
  // Live update: recompute symbology every minute so colour/size/opacity track time.
  setInterval(refresh, 60 * 1000);
}

function featureCollection() {
  return {
    type: 'FeatureCollection',
    features: pools.map((p) => {
      const st = poolState(p);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { slug: p.slug, radius: st.radius, color: st.color, opacity: st.opacity },
      };
    }),
  };
}

function refresh() {
  if (map && map.getSource('pools')) map.getSource('pools').setData(featureCollection());
}

function onMarkerClick(e) {
  const slug = e.features[0].properties.slug;
  const pool = pools.find((p) => p.slug === slug);
  const st = poolState(pool);
  const tr = t();

  let line;
  if (st.status === 'open') {
    line = `<span class="dot" style="background:${COLORS.open}"></span>${tr.open} · ${fmtMinutes(st.closesInMin)} ${tr.tillClose}`;
  } else if (st.status === 'upcoming') {
    line = `<span class="dot" style="background:${COLORS.upcoming}"></span>${tr.nextLabel}: ${nextSessionLabel(pool)}`;
  } else {
    line = `<span class="dot" style="background:${COLORS.none}"></span>${tr.noToday}`;
  }

  const directions = `https://www.google.com/maps/dir/?api=1&destination=${pool.lat},${pool.lng}&travelmode=walking`;
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `
    <h2>${escapeHtml(pool.name)}</h2>
    <div class="status">${line}</div>
    <div class="actions">
      <a class="btn" href="${directions}" target="_blank" rel="noopener">${tr.popupDirections}</a>
      <a class="btn" href="${pool.url}" target="_blank" rel="noopener">${tr.popupVisit}</a>
      <button class="btn btn-ics" type="button">${tr.popupIcs}</button>
    </div>
    <div class="week" hidden>${weekSummary(pool)}</div>`;
  el.querySelector('.btn-ics').addEventListener('click', () => downloadICS(pool, t()));

  new maplibregl.Popup({ offset: 14, maxWidth: '300px' })
    .setLngLat(e.lngLat)
    .setDOMContent(el)
    .addTo(map);
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${m ? String(m).padStart(2, '0') : ''}`.trim() : `${m} min`;
}

function nextSessionLabel(pool) {
  const now = montrealNow();
  const today = (pool.schedule[now.dayKey] || [])
    .map((r) => ({ s: toMin(r[0]), txt: `${r[0]}–${r[1]}` }))
    .filter((x) => x.s > now.minutes)
    .sort((a, b) => a.s - b.s);
  return today.length ? today[0].txt : '—';
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Compact weekly schedule (today highlighted), shown inside the popup.
function weekSummary(pool) {
  const now = montrealNow();
  const tr = t();
  return DAY_KEYS.map((k, i) => {
    const sess = pool.schedule[k] || [];
    if (!sess.length) return '';
    const ranges = sess.map((r) => `${r[0]}–${r[1]}`).join(', ');
    const isToday = k === now.dayKey;
    return `<div class="day${isToday ? ' today' : ''}"><span class="dname">${tr.days[i]}</span> ${ranges}</div>`;
  }).join('');
}

// --- Chrome: legend (with title inside), language toggle ---
function renderChrome() {
  document.getElementById('app').insertAdjacentHTML('beforeend', `<div id="legend"></div>`);
  renderLegend();
}

function renderLegend() {
  const tr = t();
  const sw = (c, o, label) =>
    `<div class="lg-row"><span class="lg-dot" style="background:${c};opacity:${o}"></span>${label}</div>`;
  document.getElementById('legend').innerHTML = `
    <div class="lg-inner">
      <div class="lg-head">
        <h1 class="lg-title">${tr.title}</h1>
        <button id="langtoggle" type="button" title="${tr.other}">${tr.other}</button>
      </div>
      <div class="lg-heading">${tr.legendHeading}</div>
      ${sw(COLORS.open, 0.95, tr.open)}
      ${sw(COLORS.upcoming, 0.9, tr.upcoming)}
      ${sw(COLORS.none, 0.28, tr.none)}
      <div class="lg-note">
        <span class="g-dot g-sm"></span><span class="g-arrow">→</span><span class="g-dot g-lg"></span>
        <span class="g-txt">${tr.size}</span>
      </div>
      <div class="lg-note">
        <span class="g-dot g-lg g-faint"></span><span class="g-arrow">→</span><span class="g-dot g-lg"></span>
        <span class="g-txt">${tr.opacity}</span>
      </div>
      <div class="lg-attr">
        ${tr.builtBy} <a href="https://github.com/maphouse" target="_blank" rel="noopener">@maphouse</a><br>
        ${tr.dataAttr}<br>${tr.mapAttr}<br>
        <span class="lg-transp">${tr.transparency}</span>
      </div>
    </div>`;
  document.getElementById('langtoggle').addEventListener('click', () => {
    lang = lang === 'en' ? 'fr' : 'en';
    renderLegend();
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init().catch((err) => {
  document.getElementById('app').insertAdjacentHTML('beforeend',
    `<div id="loaderr">Could not load pool data.<br><small>${escapeHtml(String(err))}</small></div>`);
});
