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
// Returns { status, color, remainingMin, minutesUntilNext, radius, opacity }.
export function poolState(pool, now = montrealNow()) {
  const today = (pool.schedule[now.dayKey] || []).map((r) => [toMin(r[0]), toMin(r[1])]);
  const intervals = mergeIntervals(today);

  let remainingMin = 0;
  let openNow = false;
  let closesInMin = null;          // minutes until the currently-open session ends
  let minutesUntilNext = Infinity; // until the next not-yet-started session today
  for (const [s, e] of intervals) {
    if (now.minutes >= s && now.minutes < e) { openNow = true; remainingMin += e - now.minutes; closesInMin = e - now.minutes; }
    else if (s > now.minutes) { remainingMin += e - s; minutesUntilNext = Math.min(minutesUntilNext, s - now.minutes); }
  }

  let status = 'none';
  if (openNow) status = 'open';
  else if (remainingMin > 0) status = 'upcoming';

  // When today's hours are all past and the pool has a real schedule, look
  // ahead up to 6 days to find the next session and stay blue rather than
  // going grey. remainingMin is set to the next day's total so circle size
  // encodes available time for that day.
  if (status === 'none' && !pool.scheduleUnavailable) {
    const todayIndex = DAY_KEYS.indexOf(now.dayKey);
    for (let d = 1; d <= 6; d++) {
      const nextKey = DAY_KEYS[(todayIndex + d) % 7];
      const nextIntervals = mergeIntervals((pool.schedule[nextKey] || []).map((r) => [toMin(r[0]), toMin(r[1])]));
      if (!nextIntervals.length) continue;
      minutesUntilNext = nextIntervals[0][0] + d * 1440 - now.minutes;
      remainingMin = nextIntervals.reduce((sum, [s, e]) => sum + (e - s), 0);
      status = 'upcoming';
      break;
    }
  }

  return {
    status,
    color: COLORS[status],
    remainingMin,
    closesInMin,
    minutesUntilNext: isFinite(minutesUntilNext) ? minutesUntilNext : null,
    radius: radiusFor(status, remainingMin),
    opacity: opacityFor(status, minutesUntilNext),
  };
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
