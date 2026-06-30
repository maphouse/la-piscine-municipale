// Client-side .ics generation. Builds a calendar of weekly-recurring events from a
// pool's free adult-swim schedule, anchored to America/Toronto so daylight-saving
// shifts are handled by the user's calendar app.

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ICS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// A self-contained America/Toronto VTIMEZONE (EST/EDT) so events land at the right
// wall-clock time in every calendar client.
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Toronto',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

const pad = (n) => String(n).padStart(2, '0');
const hhmmToParts = (hhmm) => hhmm.split(':').map(Number);

// Date (Y/M/D in Montreal) of the next occurrence of weekday `targetDow`, no
// earlier than `periodStart` (YYYY-MM-DD). Advances by weeks if needed so that
// DTSTART never lands before the schedule's published start date.
function nextDateForDow(targetDow, periodStart) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g('weekday')];
  const base = new Date(Date.UTC(+g('year'), +g('month') - 1, +g('day')));
  base.setUTCDate(base.getUTCDate() + ((targetDow - dow + 7) % 7));
  if (periodStart) {
    const [py, pm, pd] = periodStart.split('-').map(Number);
    const floor = new Date(Date.UTC(py, pm - 1, pd));
    while (base < floor) base.setUTCDate(base.getUTCDate() + 7);
  }
  return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
}

const fold = (line) => {
  // RFC 5545: fold lines longer than 75 octets.
  if (line.length <= 73) return line;
  const chunks = [];
  let s = line;
  while (s.length > 73) { chunks.push(s.slice(0, 73)); s = ' ' + s.slice(73); }
  chunks.push(s);
  return chunks.join('\r\n');
};

const esc = (s) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');

export function buildICS(pool, t) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//la-piscine-municipale//FREE ADULT SWIM//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc('FREE ADULT SWIM — ' + pool.name)}`,
    'X-WR-TIMEZONE:America/Toronto',
    ...VTIMEZONE,
  ];

  // Only set UNTIL for future/current periods; gap-fallback pools (periodEnd in
  // the past) keep infinite recurrence so their ICS doesn't show zero events.
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  const until = (pool.periodEnd && pool.periodEnd >= todayStr) ? `;UNTIL=${pool.periodEnd.replace(/-/g, '')}T235959Z` : '';

  let seq = 0;
  for (let dow = 0; dow < 7; dow++) {
    const sessions = pool.schedule[DAY_KEYS[dow]] || [];
    if (!sessions.length) continue;
    const { y, m, d } = nextDateForDow(dow, pool.periodStart);
    const dateStr = `${y}${pad(m)}${pad(d)}`;
    for (const [start, end, type] of sessions) {
      const [sh, sm] = hhmmToParts(start);
      const [eh, em] = hhmmToParts(end);
      const label = type === 'lane' ? (t.lane || 'Adult lane swim') : (t.adult || 'Adult swim');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${pool.slug}-${DAY_KEYS[dow]}-${start.replace(':', '')}-${seq++}@maphouse.github.io`,
        `DTSTAMP:${stamp}`,
        `SUMMARY:${esc(label + ' — ' + pool.name)}`,
        `DTSTART;TZID=America/Toronto:${dateStr}T${pad(sh)}${pad(sm)}00`,
        `DTEND;TZID=America/Toronto:${dateStr}T${pad(eh)}${pad(em)}00`,
        `RRULE:FREQ=WEEKLY${until}`,
        `LOCATION:${esc(pool.name)}`,
        `DESCRIPTION:${esc((t.icsDescription || 'Downloaded from {siteUrl}\nSchedule changes seasonally.\nMore info at {poolUrl}').replace('{siteUrl}', 'https://maphouse.github.io/la-piscine-municipale/').replace('{poolUrl}', pool.url))}`,
        `URL:${pool.url}`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n');
}

export function downloadICS(pool, t) {
  const blob = new Blob([buildICS(pool, t)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `free-adult-swim-${pool.slug}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
