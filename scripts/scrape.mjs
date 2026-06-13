#!/usr/bin/env node
// FREE ADULT SWIM — data scraper
//
// Builds data/pools.json by scraping the montreal.ca /lieux/<slug> pages listed
// in candidates.txt. From each page it extracts: coordinates (JSON-LD), the pool
// name, and the "Pour les adultes" / lane-swim ("Nage en couloir") free-swim
// schedules.
//
// A page is kept only if (a) it describes an INDOOR pool — the page body mentions
// a "piscine intérieure" and is not an outdoor-only pool — and (b) it currently
// advertises at least one adult or adult-lane free-swim session. The City's 2023
// open dataset is NOT used to classify indoor/outdoor: it miscategorises several
// real indoor pools (Annie-Pelletier, Henri-Bourassa, …). The page's own
// "intérieure/extérieure" wording is the reliable signal.
//
// Pools that are closed for the season (no current schedule) simply don't appear.
//
// No third-party dependencies: just Node 18+ (global fetch). Run rarely (monthly).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PAGE_BASE = 'https://montreal.ca/lieux/';
const DEDUPE_RADIUS_M = 60; // two slugs resolving to the same physical pool
const UA = 'la-piscine-municipale data bot (+https://github.com/maphouse/la-piscine-municipale)';

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Section headings that count as "free adult swim" for this project:
//  - "Pour les adultes (18 ans et plus)" → adult open swim
//  - "Pour la nage en couloir" / "Couloirs de natation" → adult lane swim
// Excluded: "Pour toutes et tous", "Pour la famille", "Pour les enfants", etc.
function classifyHeading(h) {
  const t = h.toLowerCase();
  if (/toutes\s+et\s+tous|famille|enfant|parent|p[ée]riode\s+libre\s+famil/.test(t)) return null;
  if (/adulte/.test(t)) return 'adult';
  if (/nage\s+en\s+couloir|couloirs?\s+de\s+natation|nage\s+en\s+longueur/.test(t)) return 'lane';
  return null;
}

async function fetchText(url, label) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'fr-CA,fr' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.text();
}

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Indoor pools mention a "piscine intérieure" / "bassin intérieur". Outdoor-only
// pages say "extérieure" and never "intérieur". Facilities with both an indoor
// and an outdoor pool count as indoor (they have an indoor bassin).
function isIndoor(html) {
  return /int(?:é|e|&eacute;|&#233;)rieur/i.test(html);
}

// --- HTML schedule extraction ---
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();

function parseTimeRanges(cellHtml) {
  const txt = cellHtml.replace(/&nbsp;|&#160;/g, ' ').replace(/<[^>]+>/g, ' ');
  const re = /(\d{1,2})\s*h\s*(\d{0,2})\s*(?:à|–|-|au?)\s*(\d{1,2})\s*h\s*(\d{0,2})/gi;
  const ranges = [];
  let m;
  while ((m = re.exec(txt))) {
    const sh = +m[1], sm = m[2] ? +m[2] : 0, eh = +m[3], em = m[4] ? +m[4] : 0;
    if (sh > 23 || eh > 24) continue;
    ranges.push([`${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
                 `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`]);
  }
  return ranges;
}

function dayIndexFromText(t) {
  const s = t.toLowerCase();
  for (let i = 0; i < DAYS.length; i++) if (s.includes(DAYS[i])) return i;
  return -1;
}

// Parse one <table>…</table> (the schedule following an included heading) into
// { sun:[], mon:[[start,end],…], … }
function parseScheduleTable(tableHtml) {
  const week = Object.fromEntries(DAY_KEYS.map((k) => [k, []]));
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  for (const tr of tableHtml.match(rowRe) || []) {
    const cells = [...tr.matchAll(/<t[dh][\s\S]*?<\/t[dh]>/gi)].map((c) => c[0]);
    if (cells.length < 2) continue;
    const di = dayIndexFromText(stripTags(cells[0]));
    if (di < 0) continue;
    const ranges = parseTimeRanges(cells.slice(1).join(' '));
    if (ranges.length) week[DAY_KEYS[di]].push(...ranges);
  }
  return week;
}

// --- Period selection ---
// Pool pages render several schedule "periods" (e.g. a spring-break week and the
// regular season), each with its own adult tables. Each period header carries a
// machine-readable range: <time datetime="2026-03-07…">…</time> au <time
// datetime="2026-06-19…">. We keep the period in effect today; when today falls in
// a gap between posted periods (common at seasonal transitions, e.g. the regular
// schedule has ended but the summer one hasn't started), we fall back to the
// nearest period, preferring the next upcoming one, so the pool still appears.
const toDays = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

function montrealTodayDays() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return toDays(g('year'), g('month'), g('day'));
}

// Returns the HTML segment(s) for the period to display, or the whole page if it
// has no period selector.
function selectScheduleHtml(html) {
  const re = /<time datetime="(\d{4})-(\d{2})-(\d{2})[^"]*">[\s\S]*?<\/time>\s*au\s*<time datetime="(\d{4})-(\d{2})-(\d{2})/gi;
  const labels = [];
  let m;
  while ((m = re.exec(html))) {
    labels.push({ pos: m.index, start: toDays(+m[1], +m[2], +m[3]), end: toDays(+m[4], +m[5], +m[6]) });
  }
  if (!labels.length) return html; // simple page, no period selector

  const seg = (i) => html.slice(labels[i].pos, i + 1 < labels.length ? labels[i + 1].pos : labels[i].pos + 6000);
  const today = montrealTodayDays();

  // Periods that actually contain today.
  const current = labels.map((l, i) => i).filter((i) => today >= labels[i].start && today <= labels[i].end);
  if (current.length) return current.map(seg).join('\n');

  // Gap fallback: nearest period by day distance, upcoming preferred on a tie.
  let best = -1, bestKey = Infinity;
  labels.forEach((l, i) => {
    const upcoming = l.start > today;
    const gap = upcoming ? l.start - today : today - l.end;
    const key = gap * 2 + (upcoming ? 0 : 1);
    if (key < bestKey) { bestKey = key; best = i; }
  });
  return best >= 0 ? seg(best) : '';
}

// Pull every <h3>heading</h3> … <table>…</table> pair from the page and keep the
// schedules under adult / lane-swim headings, tagging each range with its type.
function extractSchedule(html) {
  const headingRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
  const week = Object.fromEntries(DAY_KEYS.map((k) => [k, []]));
  let h, found = false;
  const matches = [...html.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i++) {
    const heading = stripTags(matches[i][1]);
    const type = classifyHeading(heading);
    if (!type) continue;
    // Look at the HTML between this heading and the next heading for a table.
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const between = html.slice(start, end);
    const table = between.match(/<table[\s\S]*?<\/table>/i);
    if (!table) continue;
    const wk = parseScheduleTable(table[0]);
    for (let d = 0; d < DAY_KEYS.length; d++) {
      for (const r of wk[DAY_KEYS[d]]) {
        week[DAY_KEYS[d]].push([r[0], r[1], type]);
        found = true;
      }
    }
  }
  if (!found) return null;
  // Dedupe + sort each day.
  for (const k of DAY_KEYS) {
    const seen = new Set();
    week[k] = week[k]
      .filter((r) => { const key = r[0] + r[1] + r[2]; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  return week;
}

function extractCoords(html) {
  const lat = html.match(/"latitude"\s*:\s*"?(-?\d+\.\d+)/i);
  const lng = html.match(/"longitude"\s*:\s*"?(-?\d+\.\d+)/i);
  return lat && lng ? { lat: parseFloat(lat[1]), lng: parseFloat(lng[1]) } : null;
}

function extractName(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (og) return og[1].trim();
  const t = html.match(/<title[^>]*>([^<|]+)/i);
  return t ? t[1].trim() : null;
}

const readList = async (file) =>
  (await readFile(join(__dirname, file), 'utf-8'))
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

const emptyWeek = () => Object.fromEntries(DAY_KEYS.map((k) => [k, []]));

async function main() {
  const slugs = await readList('candidates.txt');
  // Pools known to offer free adult swim but without a parsable schedule on their
  // City page — shown as grey "link-only" markers.
  const linkOnly = new Set(await readList('link-only.txt'));

  const pools = [];
  for (const slug of slugs) {
    const url = PAGE_BASE + slug;
    let html;
    try { html = await fetchText(url, slug); }
    catch (e) { console.log(`  skip ${slug}: ${e.message}`); continue; }

    if (!isIndoor(html)) { console.log(`  skip ${slug}: not an indoor pool`); continue; }

    const coords = extractCoords(html);
    if (!coords) { console.log(`  skip ${slug}: no coordinates`); continue; }

    const scheduleHtml = selectScheduleHtml(html);
    const schedule = scheduleHtml ? extractSchedule(scheduleHtml) : null;
    if (!schedule) {
      if (linkOnly.has(slug)) {
        pools.push({ slug, name: extractName(html), url, lat: coords.lat, lng: coords.lng, schedule: emptyWeek(), scheduleUnavailable: true });
        console.log(`  ◐ ${slug}: link-only grey marker (no parsable schedule)`);
      } else {
        console.log(`  skip ${slug}: no adult/lane free-swim schedule in effect (closed/off-season?)`);
      }
      continue;
    }

    const total = Object.values(schedule).reduce((n, day) => n + day.length, 0);
    pools.push({ slug, name: extractName(html), url, lat: coords.lat, lng: coords.lng, schedule });
    console.log(`  ✓ ${slug} (${total} weekly sessions — ${extractName(html)})`);
  }

  // De-duplicate pools that resolved to the same physical location (some pools
  // have two slugs, e.g. "piscine-saint-charles" and "centre-saint-charles").
  const deduped = [];
  for (const p of pools.sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
    if (deduped.some((q) => haversine(p.lat, p.lng, q.lat, q.lng) < DEDUPE_RADIUS_M)) continue;
    deduped.push(p);
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'https://montreal.ca (City of Montreal pool pages)',
    timezone: 'America/Toronto',
    count: deduped.length,
    pools: deduped,
  };
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(join(ROOT, 'data', 'pools.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote data/pools.json with ${deduped.length} pools (from ${slugs.length} candidates).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
