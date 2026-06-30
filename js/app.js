// FREE ADULT SWIM — map application.
import { poolState, montrealNow, COLORS, DAY_KEYS } from './symbology.js';
import { STRINGS } from './i18n.js';
import { downloadICS } from './ics.js';

const MONTREAL = { center: [-73.61, 45.53], zoom: 11 };
const BASEMAP = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

let lang = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
let pools = [];
let map;
let hoverPopup = null;
let hoverSlug = null;
let geolocate = null;

const t = () => STRINGS[lang];

// Crosshair icon for the custom geolocate button that lives in the legend.
const LOCATE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';

// Swimmer (Material "pool" glyph) appended to the legend title.
const SWIMMER_ICON = '<svg class="title-swimmer" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22 21c-1.11 0-1.73-.37-2.18-.64-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.07.64-2.18.64s-1.73-.37-2.18-.64c-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.08.64-2.19.64s-1.73-.37-2.18-.64c-.37-.23-.6-.36-1.15-.36s-.78.13-1.15.36c-.46.27-1.08.64-2.19.64v-2c.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.6.36 1.15.36s.78-.13 1.15-.36c.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36v2zm0-4.5c-1.11 0-1.73-.37-2.18-.64-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.07.64-2.18.64s-1.73-.37-2.18-.64c-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.08.64-2.19.64s-1.73-.37-2.18-.64c-.37-.23-.6-.36-1.15-.36s-.78.13-1.15.36c-.46.27-1.08.64-2.19.64v-2c.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.6.36 1.15.36s.78-.13 1.15-.36c.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36v2zM8.67 12c.55-.34 1.24-.6 2.16-.6 1.11 0 1.73.37 2.18.64.37.23.6.36 1.15.36.56 0 .78-.13 1.15-.36.4-.24.91-.51 1.67-.6L8.4 5.71c-.45.27-.71.75-.71 1.29 0 .57.31 1.07.78 1.34l1.7.98c-.49.1-.94.31-1.32.54-.37.22-.59.35-1.15.35-.56 0-.78-.13-1.15-.36-.45-.27-1.07-.64-2.18-.64v2c.56 0 .78.13 1.15.36.27.16.6.34 1.07.46zm6.83-4.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';

async function init() {
  const res = await fetch('data/pools.json', { cache: 'no-cache' });
  const data = await res.json();
  pools = data.pools;

  // Keep the viewport on the pools' extent (Montreal island) — derive a padded
  // bounding box from the data so users can't wander off to the rest of the world.
  const lons = pools.map((p) => p.lng), lats = pools.map((p) => p.lat);
  const pad = 0.06;
  const maxBounds = [
    [Math.min(...lons) - pad, Math.min(...lats) - pad],
    [Math.max(...lons) + pad, Math.max(...lats) + pad],
  ];

  map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP,
    center: MONTREAL.center,
    zoom: MONTREAL.zoom,
    minZoom: 10,
    maxBounds,
    attributionControl: false,
  });
  // Added to the map (so it works) but its default UI is hidden via CSS — we
  // trigger it from a custom button in the legend instead.
  geolocate = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  });
  map.addControl(geolocate, 'bottom-right');

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
    map.on('mousemove', 'pools', onMarkerHover);
    map.on('mouseleave', 'pools', () => {
      map.getCanvas().style.cursor = '';
      hoverSlug = null;
      if (hoverPopup) hoverPopup.remove();
    });
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

// Build the popup DOM for a pool (shared by hover preview and click).
function buildPopupEl(pool) {
  const st = poolState(pool);
  const tr = t();

  let line;
  if (pool.scheduleUnavailable) {
    line = `${tr.seeSource}`;
  } else if (st.status === 'open') {
    line = `${tr.open} · ${fmtMinutes(st.closesInMin)} ${tr.tillClose}`;
  } else if (st.status === 'upcoming') {
    line = `${tr.nextIn} ${fmtCountdown(st.minutesUntilNext)} ${tr.at} ${nextSessionLabel(pool)}`;
  } else {
    line = `${tr.noToday}`;
  }

  const directions = `https://www.google.com/maps/dir/?api=1&destination=${pool.lat},${pool.lng}&travelmode=walking`;
  // Link-only pools have no parsable schedule — no dropdown, no .ics.
  const schedule = pool.scheduleUnavailable ? '' : `
      <details class="week-dd">
        <summary>${tr.weekHeading}</summary>
        <div class="week">${weekSummary(pool)}</div>
      </details>
      <button class="btn btn-ics" type="button">${tr.popupIcs}</button>`;
  // Scheduled pools: the page link rides on the title (with ↗). Greyed link-only
  // pools have no title link — instead their status line ("Schedule on the
  // pool's page ↗") is itself the link out.
  const title = pool.scheduleUnavailable
    ? `<h2 style="color:${st.color}">${escapeHtml(pool.name)}</h2>`
    : `<h2 style="color:${st.color}"><a class="pool-link" href="${pool.url}" target="_blank" rel="noopener" title="${tr.popupVisit}">${escapeHtml(pool.name)} ↗</a></h2>`;
  const statusHtml = pool.scheduleUnavailable
    ? `<a class="status-link" href="${pool.url}" target="_blank" rel="noopener">${line} ↗</a>`
    : line;
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `
    ${title}
    <div class="status">${statusHtml}</div>
    <div class="actions">
      <a class="btn" href="${directions}" target="_blank" rel="noopener">${tr.popupDirections}</a>
      ${schedule}
    </div>`;
  const ics = el.querySelector('.btn-ics');
  if (ics) ics.addEventListener('click', () => downloadICS(pool, t()));
  return el;
}

function onMarkerClick(e) {
  const pool = pools.find((p) => p.slug === e.features[0].properties.slug);
  if (hoverPopup) hoverPopup.remove();
  hoverSlug = null;
  new maplibregl.Popup({ closeButton: false, offset: 8, maxWidth: '240px' })
    .setLngLat(e.lngLat)
    .setDOMContent(buildPopupEl(pool))
    .addTo(map);
}

// Hover preview: a transient popup that follows the marker under the cursor.
function onMarkerHover(e) {
  map.getCanvas().style.cursor = 'pointer';
  const slug = e.features[0].properties.slug;
  if (!hoverPopup) {
    hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, maxWidth: '240px' });
  }
  if (slug !== hoverSlug) {
    hoverSlug = slug;
    hoverPopup.setDOMContent(buildPopupEl(pools.find((p) => p.slug === slug)));
  }
  hoverPopup.setLngLat(e.lngLat).addTo(map);
}

function fmtMinutes(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${m ? String(m).padStart(2, '0') : ''}`.trim() : `${m} min`;
}

// Compact countdown for the popup: "2h 05m" / "45m".
function fmtCountdown(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function nextSessionLabel(pool) {
  const now = montrealNow();
  const tr = t();
  const todayRemaining = (pool.schedule[now.dayKey] || [])
    .map((r) => ({ s: toMin(r[0]), txt: `${r[0]}–${r[1]}` }))
    .filter((x) => x.s > now.minutes)
    .sort((a, b) => a.s - b.s);
  if (todayRemaining.length) return todayRemaining[0].txt;
  const todayIndex = DAY_KEYS.indexOf(now.dayKey);
  for (let d = 1; d <= 6; d++) {
    const nextDayIndex = (todayIndex + d) % 7;
    const nextKey = DAY_KEYS[nextDayIndex];
    const nextSessions = (pool.schedule[nextKey] || [])
      .map((r) => ({ s: toMin(r[0]), txt: `${r[0]}–${r[1]}` }))
      .sort((a, b) => a.s - b.s);
    if (nextSessions.length) return `${tr.days[nextDayIndex]} ${nextSessions[0].txt}`;
  }
  return '—';
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

let legendCollapsed = false;

function renderLegend() {
  const tr = t();
  const sw = (c, o, label) =>
    `<div class="lg-row"><span class="lg-dot" style="background:${c};opacity:${o}"></span>${label}</div>`;
  const body = legendCollapsed ? '' : `
      <div class="lg-body">
        <div class="lg-heading">${tr.legendHeading} ${SWIMMER_ICON}</div>
        ${sw(COLORS.open, 0.95, tr.open)}
        ${sw(COLORS.upcoming, 0.7, tr.upcoming)}
        ${sw(COLORS.none, 0.45, tr.none)}
        <div class="lg-attr">
          ${tr.creditBy} <a href="https://github.com/maphouse" target="_blank" rel="noopener">@maphouse</a><br>
          ${tr.builtBy} · <span class="lg-transp">${tr.transparency}</span><br>
          ${tr.dataAttr}<br>${tr.mapAttr}<br>
          <a href="https://github.com/maphouse/la-piscine-municipale/issues" target="_blank" rel="noopener">${tr.reportIssue}</a>
        </div>
      </div>`;
  document.getElementById('legend').innerHTML = `
    <div class="lg-inner">
      <div class="lg-head">
        <h1 class="lg-title">${tr.title}</h1>
        <div class="lg-btns">
          <button id="langtoggle" type="button" title="${tr.other}">${tr.other}</button>
          <button id="geoloc" type="button" title="${tr.locate}">${LOCATE_ICON}</button>
          <button id="mintoggle" type="button" title="${legendCollapsed ? '+' : '–'}">${legendCollapsed ? '+' : '–'}</button>
        </div>
      </div>${body}
    </div>`;
  document.getElementById('langtoggle').addEventListener('click', () => {
    lang = lang === 'en' ? 'fr' : 'en';
    renderLegend();
  });
  document.getElementById('geoloc').addEventListener('click', () => {
    if (geolocate) geolocate.trigger();
  });
  document.getElementById('mintoggle').addEventListener('click', () => {
    legendCollapsed = !legendCollapsed;
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
