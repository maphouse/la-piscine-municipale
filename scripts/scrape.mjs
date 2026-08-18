#!/usr/bin/env node
// FREE ADULT SWIM — data scraper
//
// Builds data/pools.json by scraping the montreal.ca /lieux/<slug> pages listed
// in candidates.txt. From each page it extracts: coordinates (JSON-LD), the pool
// name, and the "Pour les adultes" / lane-swim ("Nage en couloir") free-swim
// schedules.
//
// A page is kept if it describes an INDOOR pool — the page body mentions a "piscine
// intérieure" and is not an outdoor-only pool. The City's 2023 open dataset is NOT
// used to classify indoor/outdoor: it miscategorises several real indoor pools
// (Annie-Pelletier, Henri-Bourassa, …). The page's own "intérieure/extérieure"
// wording is the reliable signal.
//
// Every indoor pool then lands in exactly one of three states, decided by dates and
// nothing else:
//
//   hours       a posted schedule period covers today and lists adult/lane/public
//               sessions → the map shows them, sized and coloured by time of day.
//   no hours    the page publishes no free-swim hours that apply today: its periods
//               have lapsed (Bain Morgan still shows its 7 mars – 19 juin table), or
//               it posts "Horaire : Non indiqué" outright (Gadbois, Calixa-Lavallée
//               and the other long-term closures) → a RED dot.
//   unparsable  listed in link-only.txt: a pool known to run free adult swim whose
//               hours never appear in machine-readable form → a GREY dot.
//
// The map deliberately does NOT try to explain WHY a pool has no hours. The City's
// "Fermé temporairement" banners are free text typed by facility staff — one pool's
// banner announces a season-long closure, another's is a leftover notice for a single
// holiday last June — and parsing that prose to sort renovation from summer break
// from lapsed data buys nothing a swimmer can use. Red means "no hours posted for
// today", which is a fact about the schedule, not a guess about the building. The
// pool's own page is one click away in the popup for anyone who wants the reason.
//
// No third-party dependencies: just Node 18+ (global fetch). Run rarely (monthly).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PAGE_BASE = 'https://montreal.ca/lieux/';
const DEDUPE_RADIUS_M = 60; // two slugs resolving to the same physical pool
const MAX_SCRAPE_INTERVAL_DAYS = 1; // refresh daily: pools post next season's hours without warning
const FETCH_DELAY_MS = 300;         // spacing between page fetches — a trickle, not a burst
const UA = 'la-piscine-municipale data bot (+https://github.com/maphouse/la-piscine-municipale)';

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Section headings we harvest, in priority order:
//  - "Pour les adultes (18 ans et plus)"                → 'adult'  (adult open swim)
//  - "Pour la nage en couloir" / "Couloirs de natation" → 'lane'   (adult lap swim,
//    incl. "Nage en longueur lors des périodes de baignade libre")
//  - "Pour toutes et tous" / "Grand public"             → 'public' (open for all —
//    lap swimmers can use part of the pool; shown only when the front-end "adult
//    swim only" toggle is off). A pool with ONLY open-for-all hours still appears,
//    but the front-end hides it while "adult swim only" is on.
// Excluded: family / kids / adapted swim.
function classifyHeading(h) {
  const t = h.toLowerCase();
  if (/famille|enfant|parent|p[ée]riode\s+libre\s+famil|handicap|adapt/.test(t)) return null;
  if (/adulte/.test(t)) return 'adult';
  if (/nage\s+en\s+couloir|couloirs?\s+de\s+natation|nage\s+en\s+longueur/.test(t)) return 'lane';
  if (/toutes\s+et\s+tous|grand\s+public/.test(t)) return 'public';
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// A slot can be struck out in place: the City appends a status after the times in
// the same cell — "9 h 00 à 15 h 55 - Annulé". The times are still there, so a plain
// match reads a cancelled session as an ordinary one; Claude-Robillard cancelled all
// twelve of its 22 août – 4 septembre sessions that way. Each range is therefore
// checked against the text that follows it, up to the next range in the cell.
//
// Only "annulé" is recognised, because that is the only annotation the City actually
// uses: of 715 schedule cells across every candidate page, 14 carry any text beside
// the times, and all 14 say exactly that. Should another status appear later
// ("reporté", "complet"), it goes unrecognised and we are no worse off than before —
// this check can only ever remove hours from the map, never invent them.
const CANCELLED = /annul/i;

function parseTimeRanges(cellHtml) {
  const txt = cellHtml.replace(/&nbsp;|&#160;/g, ' ').replace(/<[^>]+>/g, ' ');
  const re = /(\d{1,2})\s*h\s*(\d{0,2})\s*(?:à|–|-|au?)\s*(\d{1,2})\s*h\s*(\d{0,2})/gi;
  const found = [...txt.matchAll(re)];
  const ranges = [];
  for (let i = 0; i < found.length; i++) {
    const m = found[i];
    const sh = +m[1], sm = m[2] ? +m[2] : 0, eh = +m[3], em = m[4] ? +m[4] : 0;
    if (sh > 23 || eh > 24) continue;
    const tail = txt.slice(m.index + m[0].length, i + 1 < found.length ? found[i + 1].index : txt.length);
    if (CANCELLED.test(tail)) continue;
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
// datetime="2026-06-19…">. We keep ONLY the period in effect today.
//
// There is no fallback to a neighbouring period. Hours outside their stated dates
// are not a statement about today — a table posted for 7 mars – 19 juin says nothing
// about August, whether the pool is shut for renovations, closed for the summer, or
// simply slow to publish the next season. Serving them anyway is how Bain Morgan came
// to advertise spring hours all summer. When nothing covers today the pool has no
// hours, and main() gives it a red marker; the nearest posted period is still
// reported so the popup can say when the last (or next) one runs.
const toDays = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

function montrealTodayDays() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return toDays(g('year'), g('month'), g('day'));
}

// Returns { html, periodStart, periodEnd }. `html` is the schedule segment for the
// period covering today, or '' when no posted period does. periodStart/periodEnd are
// "YYYY-MM-DD" strings for the period reported — the covering one, or (when html is
// '') the nearest posted period, upcoming preferred on a tie, purely for display.
// Both are null when the page carries no machine-readable date ranges at all.
function selectScheduleHtml(html) {
  const re = /<time datetime="(\d{4})-(\d{2})-(\d{2})[^"]*">[\s\S]*?<\/time>\s*au\s*<time datetime="(\d{4})-(\d{2})-(\d{2})/gi;
  const labels = [];
  let m;
  while ((m = re.exec(html))) {
    labels.push({
      pos: m.index,
      start: toDays(+m[1], +m[2], +m[3]),
      end: toDays(+m[4], +m[5], +m[6]),
      startStr: `${m[1]}-${m[2]}-${m[3]}`,
      endStr: `${m[4]}-${m[5]}-${m[6]}`,
    });
  }
  if (!labels.length) return { html, periodStart: null, periodEnd: null };

  const seg = (i) => html.slice(labels[i].pos, i + 1 < labels.length ? labels[i + 1].pos : labels[i].pos + 6000);
  const today = montrealTodayDays();

  // Periods that actually contain today.
  const current = labels.map((l, i) => i).filter((i) => today >= labels[i].start && today <= labels[i].end);
  if (current.length) {
    return {
      html: current.map(seg).join('\n'),
      periodStart: labels[current[0]].startStr,
      periodEnd: labels[current[current.length - 1]].endStr,
    };
  }

  // Nothing covers today: no schedule, but report the nearest posted period (upcoming
  // preferred on a tie) so the popup can say when hours last ran or next resume.
  let best = 0, bestKey = Infinity;
  labels.forEach((l, i) => {
    const upcoming = l.start > today;
    const gap = upcoming ? l.start - today : today - l.end;
    const key = gap * 2 + (upcoming ? 0 : 1);
    if (key < bestKey) { bestKey = key; best = i; }
  });
  // Only report it if that period actually carries free-swim sessions this map counts.
  // These dates are no longer shown to anyone — they drive nextScrapeDate, so that a
  // pool sitting red between two seasons gets re-scraped the day its hours resume —
  // and a period holding only family or lesson hours is not a boundary worth waking
  // for.
  return extractSchedule(seg(best))
    ? { html: '', periodStart: labels[best].startStr, periodEnd: labels[best].endStr }
    : { html: '', periodStart: null, periodEnd: null };
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
        // Any session — adult/lane OR "open for all" — puts the pool on the map. A
        // pool with only open-for-all hours (no dedicated adult/lane) is shown only
        // when the front-end "adult swim only" toggle is off (see app.js).
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
  let first = true;
  for (const slug of slugs) {
    const url = PAGE_BASE + slug;
    if (!first) await sleep(FETCH_DELAY_MS);
    first = false;
    let html;
    try { html = await fetchText(url, slug); }
    catch (e) { console.log(`  skip ${slug}: ${e.message}`); continue; }

    if (!isIndoor(html)) { console.log(`  skip ${slug}: not an indoor pool`); continue; }

    const coords = extractCoords(html);
    if (!coords) { console.log(`  skip ${slug}: no coordinates`); continue; }

    const base = { slug, name: extractName(html), url, lat: coords.lat, lng: coords.lng };
    const { html: scheduleHtml, periodStart, periodEnd } = selectScheduleHtml(html);
    const schedule = scheduleHtml ? extractSchedule(scheduleHtml) : null;

    if (schedule) {
      const total = Object.values(schedule).reduce((n, day) => n + day.length, 0);
      const poolEntry = { ...base, schedule };
      if (periodStart) poolEntry.periodStart = periodStart;
      if (periodEnd) poolEntry.periodEnd = periodEnd;
      pools.push(poolEntry);
      console.log(`  ✓ ${slug} (${total} sessions${periodStart ? ` [${periodStart} → ${periodEnd}]` : ''} — ${base.name})`);
    } else if (linkOnly.has(slug)) {
      // Known to run free adult swim, but its hours never appear in a parsable form —
      // grey. Checked before the red case: absent hours here mean "we can't read them",
      // not "there are none". Once such a page does publish a parsable schedule the
      // branch above wins and the pool joins the map properly.
      pools.push({ ...base, schedule: emptyWeek(), scheduleUnavailable: true });
      console.log(`  ◐ ${slug}: link-only grey marker (no parsable schedule)`);
    } else {
      // No hours apply today. The pool still goes on the map, in red: an indoor
      // municipal pool with nothing posted is exactly what a swimmer needs to see,
      // and a pool that has been dark for months is worth showing as dark rather
      // than quietly dropping. The nearest posted period rides along for the popup.
      const poolEntry = { ...base, schedule: emptyWeek(), scheduleUnavailable: true, noUpcomingHours: true };
      if (periodStart) { poolEntry.periodStart = periodStart; poolEntry.periodEnd = periodEnd; }
      pools.push(poolEntry);
      console.log(`  ✕ ${slug}: no hours posted for today${periodStart ? ` (nearest period ${periodStart} → ${periodEnd})` : ' (no schedule on page)'}`);
    }
  }

  // De-duplicate pools that resolved to the same physical location (some pools have
  // two slugs, e.g. "piscine-saint-charles" and "centre-saint-charles"). The most
  // informative entry sorts first and therefore wins: real hours, then a known
  // link-only pool, then a red marker that at least names its last posted period,
  // and only then a page with nothing on it. Without this a facility hub page
  // listing "Horaire : Non indiqué" could mask the live pool behind it.
  const rank = (p) => (!p.scheduleUnavailable ? 0 : !p.noUpcomingHours ? 1 : p.periodStart ? 2 : 3);
  const deduped = [];
  for (const p of pools.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr'))) {
    if (deduped.some((q) => haversine(p.lat, p.lng, q.lat, q.lng) < DEDUPE_RADIUS_M)) continue;
    deduped.push(p);
  }
  deduped.sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  // nextScrapeDate: the next day on which any pool's state could change — the day
  // after a period ends (its hours stop) or the day a posted period starts (a red
  // pool's hours resume) — capped at MAX_SCRAPE_INTERVAL_DAYS, which is now 1, so in
  // practice the workflow scrapes every day and this only ever moves the date earlier.
  //
  // The cap does the real work. Boundaries only predict changes the CURRENT file can
  // see: a pool whose summer schedule lapsed contributes no future boundary at all, so
  // when the borough posts its fall hours nothing wakes the scraper. Under the old
  // weekly cap Henri-Bourassa could have sat red for a week after reopening. Daily
  // costs 45 requests against pages robots.txt leaves open, and the write below is
  // skipped when nothing changed, so a quiet day makes no commit and no deploy.
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  const addDays = (dateStr, n) => {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const boundaries = [];
  for (const p of deduped) {
    if (p.periodEnd && p.periodEnd >= todayStr) boundaries.push(addDays(p.periodEnd, 1));
    if (p.periodStart && p.periodStart > todayStr) boundaries.push(p.periodStart);
  }
  boundaries.sort();
  const cap = addDays(todayStr, MAX_SCRAPE_INTERVAL_DAYS);
  const boundary = boundaries.length ? boundaries[0] : null;
  const nextScrapeDate = boundary && boundary < cap ? boundary : cap;
  console.log(`\nNext scheduled refresh: ${nextScrapeDate}` +
    (nextScrapeDate === boundary ? ` (next period boundary)` : ` (daily cap)`));

  const out = {
    generated: new Date().toISOString(),
    source: 'https://montreal.ca (City of Montreal pool pages)',
    timezone: 'America/Toronto',
    nextScrapeDate,
    count: deduped.length,
    pools: deduped,
  };
  // Write only when the harvested pools actually differ. `generated` and
  // nextScrapeDate move on every run, so writing unconditionally would commit and
  // redeploy the site daily to say nothing — and would date-stamp the map's "last
  // updated" line as though the schedules had changed. Leaving the file untouched
  // makes a no-change day genuinely silent; the stale nextScrapeDate it keeps is
  // already in the past, so tomorrow's run goes ahead regardless.
  const outPath = join(ROOT, 'data', 'pools.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(outPath, 'utf-8')); } catch { /* first run */ }
  if (previous && JSON.stringify(previous.pools) === JSON.stringify(out.pools)) {
    console.log(`\nNo schedule changes — data/pools.json left untouched (${deduped.length} pools).`);
    return;
  }
  await mkdir(join(ROOT, 'data'), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote data/pools.json with ${deduped.length} pools (from ${slugs.length} candidates).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
