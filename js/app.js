// FREE ADULT SWIM — map application.
import { poolState, montrealNow, COLORS, DAY_KEYS } from './symbology.js';
import { STRINGS } from './i18n.js';
import { downloadICS } from './ics.js';

const MONTREAL = { center: [-73.61, 45.53], zoom: 11 };
const BASEMAP = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const GAP_WIDTH = 2; // px width of the transparent gap carved between a pool's ring bands

// Build-session metering shown in the legend. BUILD_TOKENS is the one figure
// kept by hand — Claude usage isn't visible to the data-refresh Action, so
// (unlike the "last updated" date, which tracks data/pools.json's `generated`
// timestamp) it can't self-update. The billed cost and energy are estimated
// from it via these blended per-million-token rates, calibrated to the original
// 41.8M tokens ≈ US$30 ≈ 90 Wh metering.
const BUILD_TOKENS = 41_800_000;
const USD_PER_MTOK = 0.72; // blended, incl. cheap cache reads
const WH_PER_MTOK = 2.15; // rough energy estimate

// Touch devices (phones/tablets): start the credits collapsed, and place popups BELOW
// their point (anchor 'top') instead of above — a thumb is less likely to hide them.
const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
const POPUP_ANCHOR = IS_TOUCH ? 'top' : 'bottom';

// Ambient centre-of-viewport pan-preview — PARKED for now (needs UX tuning). Flip to
// true to bring it back; all its code is kept below, gated on this flag. With it off,
// popups are plain tap-to-open / tap-again-to-close.
const PAN_PREVIEW = false;

let lang = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
let pools = [];
let generated = null; // ISO timestamp of the last data refresh, from pools.json
let adultOnly = true; // experimental toggle: false also counts "open for all" hours
let map;
let geolocate = null;
let clickPopup = null;  // the currently-open click/tap popup
let clickSlug = null;   // slug the open popup belongs to (for tap-again-to-close)
// Pan-preview state (only used when PAN_PREVIEW is on):
let centerPopup = null;
let centerSlug = null;
let hasPanned = false;
let previewSuppressed = false;

const t = () => STRINGS[lang];

// Crosshair icon for the custom geolocate button that lives in the legend.
const LOCATE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';

// Swimmer (Material "pool" glyph) appended to the legend title.
const SWIMMER_ICON = '<svg class="title-swimmer" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22 21c-1.11 0-1.73-.37-2.18-.64-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.07.64-2.18.64s-1.73-.37-2.18-.64c-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.08.64-2.19.64s-1.73-.37-2.18-.64c-.37-.23-.6-.36-1.15-.36s-.78.13-1.15.36c-.46.27-1.08.64-2.19.64v-2c.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.6.36 1.15.36s.78-.13 1.15-.36c.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36v2zm0-4.5c-1.11 0-1.73-.37-2.18-.64-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.07.64-2.18.64s-1.73-.37-2.18-.64c-.37-.22-.6-.36-1.15-.36-.56 0-.78.13-1.15.36-.46.27-1.08.64-2.19.64s-1.73-.37-2.18-.64c-.37-.23-.6-.36-1.15-.36s-.78.13-1.15.36c-.46.27-1.08.64-2.19.64v-2c.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36.56 0 .78-.13 1.15-.36.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.6.36 1.15.36s.78-.13 1.15-.36c.46-.27 1.08-.64 2.19-.64s1.73.37 2.18.64c.37.23.59.36 1.15.36v2zM8.67 12c.55-.34 1.24-.6 2.16-.6 1.11 0 1.73.37 2.18.64.37.23.6.36 1.15.36.56 0 .78-.13 1.15-.36.4-.24.91-.51 1.67-.6L8.4 5.71c-.45.27-.71.75-.71 1.29 0 .57.31 1.07.78 1.34l1.7.98c-.49.1-.94.31-1.32.54-.37.22-.59.35-1.15.35-.56 0-.78-.13-1.15-.36-.45-.27-1.07-.64-2.18-.64v2c.56 0 .78.13 1.15.36.27.16.6.34 1.07.46zm6.83-4.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>';

async function init() {
  const res = await fetch('data/pools.json', { cache: 'no-cache' });
  const data = await res.json();
  pools = data.pools;
  generated = data.generated;

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

    // Each pool is drawn as two kinds of feature (see featureCollection): an invisible
    // full-size 'hit' disc for interaction, and one 'band' per session. Bands are
    // translucent so nearness reads through; they're drawn as non-overlapping annuli
    // pulled apart by a small unpainted gap, so the basemap shows through between rings
    // and the per-ring opacities never compound. Layer order bottom→top: hit, bands.
    map.addLayer({
      id: 'pools-hit',
      type: 'circle',
      source: 'pools',
      filter: ['==', ['get', 'role'], 'hit'],
      paint: { 'circle-radius': ['get', 'radius'], 'circle-color': '#000', 'circle-opacity': 0 },
    });
    map.addLayer({
      id: 'pools-bands',
      type: 'circle',
      source: 'pools',
      filter: ['==', ['get', 'role'], 'band'],
      paint: {
        // Innermost session is a filled disc; each outer session is a ring, drawn as
        // an outward stroke (circle-stroke-width = band thickness, anchored at the
        // band's inner radius) with no fill. Adjacent bands are pulled apart by a small
        // gap (see featureCollection) so neither overlap nor a white overlay is needed —
        // the basemap shows through. Both fill and stroke carry the session's opacity.
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'fillOpacity'],
        'circle-stroke-width': ['get', 'strokeWidth'],
        'circle-stroke-color': ['get', 'strokeColor'],
        'circle-stroke-opacity': ['get', 'strokeOpacity'],
      },
    });

    map.on('click', 'pools-hit', onMarkerClick);
    map.on('mouseenter', 'pools-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pools-hit', () => { map.getCanvas().style.cursor = ''; });
    // Tapping the map away from any marker closes an open popup.
    map.on('click', (e) => {
      if (clickPopup && !map.queryRenderedFeatures(e.point, { layers: ['pools-hit'] }).length) clickPopup.remove();
    });

    if (PAN_PREVIEW) {
      // Centre preview: the pool nearest the viewport centre pops its popup, but only
      // once the user has started panning (nothing pops on load). 'move' also fires on
      // zoom/programmatic moves; the `hasPanned` gate keeps those quiet until a pan.
      map.on('move', updateCenterPreview);
      map.on('dragstart', () => { hasPanned = true; });
    }
  });

  renderChrome();
  // Live update: recompute symbology every minute so colour/size/opacity track time.
  setInterval(refresh, 60 * 1000);
}

function featureCollection() {
  const features = [];
  for (const p of pools) {
    const st = poolState(p, undefined, !adultOnly);
    const rings = st.rings; // outer (soonest) → inner (latest); radius descending
    const geometry = { type: 'Point', coordinates: [p.lng, p.lat] };
    // Invisible full-size disc: the interaction target for the whole symbol.
    features.push({ type: 'Feature', geometry, properties: { role: 'hit', slug: p.slug, radius: rings[0].radius } });
    rings.forEach((ring, i) => {
      const outer = ring.radius;
      const inner = i < rings.length - 1 ? rings[i + 1].radius : 0;
      // Carve a see-through gap at each *internal* boundary by pulling the band edge
      // back by GAP_WIDTH/2, so the basemap shows between bands (no white overlay). The
      // symbol's outer edge (i === 0) and its centre (innermost) border nothing, so
      // they're left untrimmed.
      const outerDraw = i === 0 ? outer : outer - GAP_WIDTH / 2;
      const innerDraw = inner <= 0 ? 0 : inner + GAP_WIDTH / 2;
      if (innerDraw <= 0) {
        // Innermost (or only) session — a filled disc [0, outerDraw].
        features.push({ type: 'Feature', geometry, properties: {
          role: 'band', slug: p.slug, radius: outerDraw,
          color: ring.color, fillOpacity: ring.opacity, strokeColor: ring.color, strokeWidth: 0, strokeOpacity: 0,
        } });
      } else {
        // Outer session — a ring. MapLibre strokes grow OUTWARD from circle-radius, so
        // radius = innerDraw with strokeWidth = (outerDraw - innerDraw) fills exactly
        // [innerDraw, outerDraw]; the trimmed gaps above and below reveal the basemap.
        features.push({ type: 'Feature', geometry, properties: {
          role: 'band', slug: p.slug, radius: innerDraw,
          color: ring.color, fillOpacity: 0, strokeColor: ring.color, strokeWidth: Math.max(0.5, outerDraw - innerDraw), strokeOpacity: ring.opacity,
        } });
      }
    });
  }
  return { type: 'FeatureCollection', features };
}

function refresh() {
  if (map && map.getSource('pools')) map.getSource('pools').setData(featureCollection());
  if (PAN_PREVIEW) { centerSlug = null; updateCenterPreview(); }
}

// Build the popup DOM for a pool (shared by hover preview and click).
function buildPopupEl(pool) {
  const st = poolState(pool, undefined, !adultOnly);
  const tr = t();

  let line = '';
  if (st.status === 'open') {
    line = `${tr.open} · ${tr.closesIn} ${fmtMinutes(st.closesInMin)}`;
  } else if (st.status === 'upcoming') {
    line = `${tr.nextIn} ${fmtCountdown(st.minutesUntilNext)}<br><span class="status-when">${nextSessionLabel(pool)}</span>`;
  } else if (!pool.scheduleUnavailable) {
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
  // Every pool's title links out to its montreal.ca page (with ↗). Link-only pools
  // (no parsable schedule) simply omit the status line.
  const title = `<h2 style="color:${st.color}"><a class="pool-link" href="${pool.url}" target="_blank" rel="noopener" title="${tr.popupVisit}">${escapeHtml(pool.name)} ↗</a></h2>`;
  const status = pool.scheduleUnavailable ? '' : `<div class="status">${line}</div>`;
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `
    ${title}
    ${status}
    <div class="actions">
      <a class="btn" href="${directions}" target="_blank" rel="noopener">${tr.popupDirections}</a>
      ${schedule}
    </div>`;
  const ics = el.querySelector('.btn-ics');
  if (ics) ics.addEventListener('click', () => downloadICS(pool, t()));
  return el;
}

function onMarkerClick(e) {
  const slug = e.features[0].properties.slug;
  if (PAN_PREVIEW) {
    // Pan-preview mode: tapping the previewed pool dismisses it; any tap suppresses
    // further previews until a manual popup is closed.
    const dismissing = centerPopup && slug === centerSlug;
    hideCenterPopup();
    previewSuppressed = true;
    if (dismissing) return;
  } else if (clickPopup && clickSlug === slug) {
    clickPopup.remove(); // tap the open marker again to close (minimize)
    return;
  }
  if (clickPopup) clickPopup.remove();
  const pool = pools.find((p) => p.slug === slug);
  clickSlug = slug;
  clickPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, anchor: POPUP_ANCHOR, offset: popupOffsetFor(pool), maxWidth: '240px' })
    .setLngLat([pool.lng, pool.lat])
    .setDOMContent(buildPopupEl(pool))
    .addTo(map);
  clickPopup.on('close', () => {
    clickPopup = null; clickSlug = null;
    if (PAN_PREVIEW) { previewSuppressed = false; updateCenterPreview(); }
  });
}

// The on-screen pool nearest the viewport centre (pixel space), or null if the
// current view holds no pool.
function nearestPoolToCenter() {
  if (!map || !pools.length) return null;
  const canvas = map.getCanvas();
  const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
  let best = null, bestPt = null, bestD = Infinity;
  for (const p of pools) {
    const pt = map.project([p.lng, p.lat]);
    const d = (pt.x - cx) ** 2 + (pt.y - cy) ** 2;
    if (d < bestD) { bestD = d; best = p; bestPt = pt; }
  }
  if (!best) return null;
  // Skip when the nearest pool is off-screen (view is over empty area).
  if (bestPt.x < 0 || bestPt.y < 0 || bestPt.x > canvas.clientWidth || bestPt.y > canvas.clientHeight) return null;
  return best;
}

// Pixels the popup tip should sit above the point so it clears the pool's ring.
function popupOffsetFor(pool) {
  const r = poolState(pool, undefined, !adultOnly).radius || 8;
  return Math.round(r) + 10;
}

function hideCenterPopup() {
  if (!centerPopup) return;
  centerPopup.remove();
  centerPopup = null;
  centerSlug = null;
}

// Ambient preview: pop the pool nearest the viewport centre, anchored above its ring
// so the popup never overlaps a large ring. Hidden until the first pan; a clicked
// popup takes precedence.
function updateCenterPreview() {
  if (!hasPanned || clickPopup || previewSuppressed) return;
  const pool = nearestPoolToCenter();
  if (!pool) { hideCenterPopup(); return; }
  if (!centerPopup) {
    // 'popup-preview' makes it pointer-events:none (see CSS) so drags/clicks pass
    // through to the map and the marker beneath — it's a preview, click to interact.
    centerPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, anchor: POPUP_ANCHOR, maxWidth: '240px', className: 'popup-preview' });
  }
  if (pool.slug !== centerSlug) {
    centerSlug = pool.slug;
    centerPopup.setDOMContent(buildPopupEl(pool));
  }
  centerPopup.setOffset(popupOffsetFor(pool));
  centerPopup.setLngLat([pool.lng, pool.lat]).addTo(map);
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
  document.getElementById('app').insertAdjacentHTML('beforeend', `<div id="legend"></div><div id="credits"></div><div id="share"></div>`);
  renderLegend();
  renderCredits();
  renderShare();
}

// "Share 📋" link, bottom-right, styled like the credits. Copies the page URL.
function renderShare() {
  const tr = t();
  const el = document.getElementById('share');
  const label = `<span class="u">${tr.share}</span>`;
  el.innerHTML = `<button id="sharelink" class="share-link" type="button">${label}</button>`;
  document.getElementById('sharelink').addEventListener('click', async () => {
    const b = document.getElementById('sharelink');
    try {
      await navigator.clipboard.writeText(window.location.href);
      b.innerHTML = `${tr.copied} ✓`;
      setTimeout(() => { b.innerHTML = label; }, 1500);
    } catch (e) { /* clipboard unavailable (e.g. insecure context) */ }
  });
}

let legendCollapsed = false;
// Start the credits collapsed on touch devices (limited room), expanded otherwise.
let creditsCollapsed = IS_TOUCH;

function renderLegend() {
  const tr = t();
  const sw = (c, o, label) =>
    `<div class="lg-row"><span class="lg-dot" style="background:${c};opacity:${o}"></span>${label}</div>`;
  const body = legendCollapsed ? '' : `
      <div class="lg-body">
        <div class="lg-heading">${tr.legendHeading} ${SWIMMER_ICON}</div>
        ${sw(COLORS.open, 0.95, tr.open)}
        ${sw(COLORS.upcoming, 1, tr.upcoming)}
        ${sw(COLORS.none, 0.45, tr.none)}
        <label class="lg-toggle" title="${tr.adultOnlyHint}"><input type="checkbox" id="adultonly"${adultOnly ? ' checked' : ''}> ${tr.adultOnly}</label>
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
    renderCredits();
    renderShare();
  });
  document.getElementById('geoloc').addEventListener('click', () => {
    if (geolocate) geolocate.trigger();
  });
  document.getElementById('mintoggle').addEventListener('click', () => {
    legendCollapsed = !legendCollapsed;
    renderLegend();
  });
  const adultOnlyBox = document.getElementById('adultonly');
  if (adultOnlyBox) adultOnlyBox.addEventListener('change', (e) => {
    adultOnly = e.target.checked;
    refresh();               // redraw the ring symbols + centre preview with the new filter
  });
}

// Standalone credits box, bottom-left. A single "Credits" toggle stays pinned at the
// bottom; when expanded the content grows ABOVE it (the box is anchored to the
// viewport bottom, so the button doesn't move).
function renderCredits() {
  const tr = t();
  const el = document.getElementById('credits');
  let bodyHtml = '';
  if (!creditsCollapsed) {
    // Build-metering figures: one token total drives the estimated cost + energy.
    const tokM = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(BUILD_TOKENS / 1e6);
    const usd = Math.round((BUILD_TOKENS / 1e6) * USD_PER_MTOK);
    const wh = Math.round((BUILD_TOKENS / 1e6) * WH_PER_MTOK);
    // Last-updated date, from the data fetch's `generated` timestamp — ISO YYYY-MM-DD
    // (en-CA gives that format) in Montreal time, language-neutral.
    const updated = generated
      ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(generated))
      : null;
    bodyHtml = `
      <div class="cr-body">
        ${updated ? `<span class="lg-updated">${tr.lastUpdated(updated)}</span><br>` : ''}${tr.creditBy} <a href="https://github.com/maphouse" target="_blank" rel="noopener">@maphouse</a><br>
        ${tr.builtBy} · <span class="lg-transp">${tr.transparency(tokM, usd, wh)}</span><br>
        ${tr.dataAttr}<br>${tr.mapAttr}<br>
        <a href="https://github.com/maphouse/la-piscine-municipale/issues" target="_blank" rel="noopener">${tr.reportIssue}</a>
      </div>`;
  }
  el.innerHTML = `${bodyHtml}<button id="creditstoggle" class="cr-chip" type="button">${tr.credits}</button>`;
  document.getElementById('creditstoggle').addEventListener('click', () => { creditsCollapsed = !creditsCollapsed; renderCredits(); });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init().catch((err) => {
  document.getElementById('app').insertAdjacentHTML('beforeend',
    `<div id="loaderr">Could not load pool data.<br><small>${escapeHtml(String(err))}</small></div>`);
});
