// Symbology — turns a pool's weekly schedule + the current Montreal time into the
// visual encoding described in the project: colour (status), size (free adult-swim
// minutes remaining today), and opacity (nearness in time of upcoming sessions).

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const COLORS = {
  open: '#1a9850',     // currently open — green
  upcoming: '#2c7fb8', // free hours coming up (today or next occurrence) — blue
  none: '#6b7280',     // no parsable schedule (link-only pools only) — grey
};

// "HH:MM" -> minutes since midnight.
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Current Montreal time as { dayKey, minutes-since-midnight }.
export function montrealNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0; // some environments emit 24 at midnight
  return { dayKey: DAY_KEYS[wd], minutes: hour * 60 + parseInt(get('minute'), 10) };
}

// Merge overlapping/adjacent [start,end] intervals (minutes) into a clean set so a
// pool that lists overlapping adult + lane sessions isn't double-counted.
function mergeIntervals(intervals) {
  const sorted = intervals.map((i) => [...i]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (out.length && s <= out[out.length - 1][1]) {
      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    } else out.push([s, e]);
  }
  return out;
}

// Compute the visual state for one pool right now.
// Returns { status, color, remainingMin, minutesUntilNext, radius, opacity, rings }.
export function poolState(pool, now = montrealNow(), includePublic = false) {
  // "Open for all" (type 'public') sessions are only counted when the "adult swim
  // only" toggle is off; otherwise the state reflects adult/lane sessions alone.
  const keep = (r) => includePublic || r[2] !== 'public';
  const today = (pool.schedule[now.dayKey] || []).filter(keep).map((r) => [toMin(r[0]), toMin(r[1])]);
  const intervals = mergeIntervals(today);

  // The day's *remaining* segments — the currently-open session's leftover plus every
  // not-yet-started session — each tagged open/upcoming, ordered soonest→latest.
  let segments = [];
  let openNow = false;
  let closesInMin = null;          // minutes until the currently-open session ends
  let minutesUntilNext = Infinity; // until the next not-yet-started session today
  for (const [s, e] of intervals) {
    if (now.minutes >= s && now.minutes < e) { openNow = true; closesInMin = e - now.minutes; segments.push({ start: s, remaining: e - now.minutes, open: true, minutesUntil: 0 }); }
    else if (s > now.minutes) { minutesUntilNext = Math.min(minutesUntilNext, s - now.minutes); segments.push({ start: s, remaining: e - s, open: false, minutesUntil: s - now.minutes }); }
  }
  segments.sort((a, b) => a.start - b.start);
  let remainingMin = segments.reduce((sum, seg) => sum + seg.remaining, 0);

  let status = 'none';
  if (openNow) status = 'open';
  else if (remainingMin > 0) status = 'upcoming';

  // When today's hours are all past and the pool has a real schedule, look
  // ahead up to 6 days to find the next session and stay blue rather than
  // going grey. The rings then encode that day's sessions (all upcoming).
  if (status === 'none' && !pool.scheduleUnavailable) {
    const todayIndex = DAY_KEYS.indexOf(now.dayKey);
    for (let d = 1; d <= 6; d++) {
      const nextKey = DAY_KEYS[(todayIndex + d) % 7];
      const nextIntervals = mergeIntervals((pool.schedule[nextKey] || []).filter(keep).map((r) => [toMin(r[0]), toMin(r[1])]));
      if (!nextIntervals.length) continue;
      minutesUntilNext = nextIntervals[0][0] + d * 1440 - now.minutes;
      segments = nextIntervals.map(([s, e]) => ({ start: s, remaining: e - s, open: false, minutesUntil: s + d * 1440 - now.minutes }));
      remainingMin = segments.reduce((sum, seg) => sum + seg.remaining, 0);
      status = 'upcoming';
      break;
    }
  }

  const rings = ringsFor(status, segments, remainingMin);

  return {
    status,
    color: COLORS[status],
    remainingMin,
    closesInMin,
    minutesUntilNext: isFinite(minutesUntilNext) ? minutesUntilNext : null,
    radius: rings[0].radius,
    opacity: opacityFor(status, minutesUntilNext),
    rings,
  };
}

// Split a pool's symbol into concentric rings — one per remaining session of the
// relevant day. The outermost ring is the soonest session, the innermost the last
// of the day. Each session's RADIAL extent is proportional to its minutes — the
// innermost disc's radius, or an outer ring's thickness — so equal-length sessions
// read the same size whether they land in the centre or on the rim (the whole
// symbol's radius still encodes total remaining time via radiusFor). Each ring is
// coloured by its own status (open now vs. upcoming) and carries
// its OWN opacity — how soon that session begins — so a distant session stays faint
// even when an earlier one is imminent. The white outline that gives every marker its
// figure-ground doubles as the separator between bands. Because the bands are drawn as
// non-overlapping annuli (see app.js), those per-ring opacities never compound.
// Grey / link-only pools stay a single small fixed dot.
//
// Floor (px) on the radial spacing between band boundaries. A middle band loses
// GAP_WIDTH (2px) to the transparent gaps carved on each side (see app.js), so this
// must exceed that or a short session's band vanishes. Kept just above it so it
// rarely fires: clamping trades away radial proportionality, and too large a floor
// makes unequal sessions (e.g. 25 vs 50 min) render at the same thickness.
const RING_MIN_GAP = 3;

function ringsFor(status, segments, remainingMin) {
  if (status === 'none') {
    return [{ color: COLORS.none, radius: radiusFor('none', remainingMin), opacity: 0.45 }];
  }
  // Per-ring colour + nearness opacity, in schedule order (soonest → latest).
  const vis = segments.map((s) => ({
    color: COLORS[s.open ? 'open' : 'upcoming'],
    opacity: opacityFor(s.open ? 'open' : 'upcoming', s.minutesUntil),
    remaining: s.remaining,
  }));
  const R = radiusFor(status, remainingMin);
  if (vis.length <= 1) return [{ color: vis[0].color, radius: R, opacity: vis[0].opacity }];

  const total = remainingMin || 1;
  // Boundary radii, innermost disc → outer edge. Divide the radius *linearly* by
  // minutes (accumulating from the centre outward, latest session first) so each
  // session's radial extent is proportional to its length: a 1-hour innermost disc
  // has the same radius as a 1-hour outer ring's thickness. The outer edge lands
  // exactly on R, keeping overall size honest.
  const fromCentre = [...vis].reverse();
  const bounds = [];
  let cumMin = 0;
  for (const v of fromCentre) { cumMin += v.remaining; bounds.push(R * (cumMin / total)); }
  // Anchor the outer edge at R, then walk inward enforcing a minimum band width so
  // very unequal sessions stay legible (this trades a little area accuracy for it).
  const n = bounds.length;
  bounds[n - 1] = R;
  for (let k = n - 2; k >= 0; k--) bounds[k] = Math.max(1, Math.min(bounds[k], bounds[k + 1] - RING_MIN_GAP));
  // Emit outer (soonest) → inner (latest); rings[0].radius === R.
  const rings = [];
  for (let i = n - 1; i >= 0; i--) rings.push({ color: fromCentre[i].color, radius: bounds[i], opacity: fromCentre[i].opacity });
  return rings;
}

// Size ∝ minutes of free adult swim remaining today. sqrt keeps it area-proportional
// (a true proportional-symbol map). Grey pools get a small fixed dot.
function radiusFor(status, remainingMin) {
  if (status === 'none') return 7;
  return Math.min(26, 7 + 1.05 * Math.sqrt(remainingMin));
}

// Opacity ∝ nearness in time, looking forward across days.
//  - open now: full.
//  - upcoming: starts within 1 h → near-full; 18 h away → faintest; linear.
//  - none (link-only grey pools): low fixed.
function opacityFor(status, minutesUntilNext) {
  if (status === 'open') return 0.95;
  if (status === 'none') return 0.45;
  const near = 60, far = 1200, hi = 0.95, lo = 0.08;
  const m = Math.max(near, Math.min(far, minutesUntilNext));
  return hi - ((m - near) / (far - near)) * (hi - lo);
}
