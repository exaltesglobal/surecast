// The moments calendar: dates worth posting about (Diwali, Mother's Day, World Environment Day)
// next to the agency's own dates (a client's anniversary, a launch). Fixed dates and weekday
// rules ("second Sunday of May") are computed for any year. Festivals that follow the lunar
// calendar move every year, so they come from a table and are marked approximate.
import { HttpError } from '../auth.js';
import { all, run } from '../db.js';
import { newId } from '../util.js';

export type Region = 'global' | 'in' | 'us' | 'uk';
export type Moment = { id: string; date: string; name: string; note: string; region: Region | 'custom'; kind: 'holiday' | 'awareness' | 'shopping' | 'fun' | 'custom'; approximate: boolean; clientId?: string | null; yearly?: boolean };

type Rule = { name: string; region: Region; kind: Moment['kind']; note?: string } & ({ md: [number, number] } | { nth: [month: number, weekday: number, n: number] } | { easter: number } | { after: [rule: string, days: number] });

// month is 1-12; weekday 0 = Sunday; n = -1 means the last one in the month.
const RULES: Rule[] = [
  { name: "New Year's Day", md: [1, 1], region: 'global', kind: 'holiday' },
  { name: 'National Youth Day', md: [1, 12], region: 'in', kind: 'awareness', note: 'Swami Vivekananda Jayanti' },
  { name: 'Lohri', md: [1, 13], region: 'in', kind: 'holiday' },
  { name: 'Makar Sankranti / Pongal', md: [1, 14], region: 'in', kind: 'holiday', note: 'Pongal runs over four days in Tamil Nadu.' },
  { name: 'Republic Day', md: [1, 26], region: 'in', kind: 'holiday' },
  { name: 'World Cancer Day', md: [2, 4], region: 'global', kind: 'awareness' },
  { name: "Valentine's Day", md: [2, 14], region: 'global', kind: 'fun' },
  { name: "International Women's Day", md: [3, 8], region: 'global', kind: 'awareness' },
  { name: 'Pi Day', md: [3, 14], region: 'global', kind: 'fun' },
  { name: 'International Day of Happiness', md: [3, 20], region: 'global', kind: 'awareness' },
  { name: 'World Water Day', md: [3, 22], region: 'global', kind: 'awareness' },
  { name: "April Fools' Day", md: [4, 1], region: 'global', kind: 'fun' },
  { name: 'World Health Day', md: [4, 7], region: 'global', kind: 'awareness' },
  { name: 'Good Friday', easter: -2, region: 'global', kind: 'holiday' },
  { name: 'Easter Sunday', easter: 0, region: 'global', kind: 'holiday' },
  { name: 'Earth Day', md: [4, 22], region: 'global', kind: 'awareness' },
  { name: 'World Book Day', md: [4, 23], region: 'global', kind: 'awareness' },
  { name: 'Labour Day / May Day', md: [5, 1], region: 'global', kind: 'holiday' },
  { name: 'Star Wars Day', md: [5, 4], region: 'global', kind: 'fun', note: '"May the Fourth be with you."' },
  { name: "Mother's Day", nth: [5, 0, 2], region: 'global', kind: 'shopping', note: 'Second Sunday of May in India, the US and most countries. The UK celebrates Mothering Sunday in March.' },
  { name: 'World Bee Day', md: [5, 20], region: 'global', kind: 'awareness' },
  { name: 'Memorial Day', nth: [5, 1, -1], region: 'us', kind: 'holiday' },
  { name: 'Global Running Day', nth: [6, 3, 1], region: 'global', kind: 'fun' },
  { name: 'World Environment Day', md: [6, 5], region: 'global', kind: 'awareness' },
  { name: "Father's Day", nth: [6, 0, 3], region: 'global', kind: 'shopping', note: 'Third Sunday of June in India, the US and the UK.' },
  { name: 'International Yoga Day', md: [6, 21], region: 'global', kind: 'awareness' },
  { name: 'World Social Media Day', md: [6, 30], region: 'global', kind: 'fun' },
  { name: "National Doctors' Day", md: [7, 1], region: 'in', kind: 'awareness' },
  { name: 'Independence Day', md: [7, 4], region: 'us', kind: 'holiday' },
  { name: 'Friendship Day', nth: [8, 0, 1], region: 'in', kind: 'fun', note: 'First Sunday of August in India.' },
  { name: 'International Youth Day', md: [8, 12], region: 'global', kind: 'awareness' },
  { name: 'Independence Day', md: [8, 15], region: 'in', kind: 'holiday' },
  { name: 'World Photography Day', md: [8, 19], region: 'global', kind: 'fun' },
  { name: "Teachers' Day", md: [9, 5], region: 'in', kind: 'awareness' },
  { name: 'Labor Day', nth: [9, 1, 1], region: 'us', kind: 'holiday' },
  { name: 'Hindi Diwas', md: [9, 14], region: 'in', kind: 'awareness' },
  { name: "Engineers' Day", md: [9, 15], region: 'in', kind: 'awareness' },
  { name: 'World Tourism Day', md: [9, 27], region: 'global', kind: 'awareness' },
  { name: 'International Coffee Day', md: [10, 1], region: 'global', kind: 'fun' },
  { name: 'Gandhi Jayanti', md: [10, 2], region: 'in', kind: 'holiday' },
  { name: 'World Mental Health Day', md: [10, 10], region: 'global', kind: 'awareness' },
  { name: 'World Food Day', md: [10, 16], region: 'global', kind: 'awareness' },
  { name: 'Halloween', md: [10, 31], region: 'global', kind: 'fun' },
  { name: 'World Kindness Day', md: [11, 13], region: 'global', kind: 'awareness' },
  { name: "Children's Day", md: [11, 14], region: 'in', kind: 'awareness' },
  { name: 'Thanksgiving', nth: [11, 4, 4], region: 'us', kind: 'holiday' },
  { name: 'Black Friday', after: ['Thanksgiving', 1], region: 'global', kind: 'shopping' },
  { name: 'Small Business Saturday', after: ['Thanksgiving', 2], region: 'us', kind: 'shopping' },
  { name: 'Cyber Monday', after: ['Thanksgiving', 4], region: 'global', kind: 'shopping' },
  { name: 'Christmas Day', md: [12, 25], region: 'global', kind: 'holiday' },
  { name: "New Year's Eve", md: [12, 31], region: 'global', kind: 'fun' },
];

// Lunar and lunisolar festivals. Dates can shift by a day by region and moon sighting.
const LUNAR: Record<number, [string, string, Region][]> = {
  2026: [
    ['02-17', 'Chinese New Year', 'global'],
    ['02-18', 'Ramadan begins', 'global'],
    ['03-04', 'Holi', 'in'],
    ['03-20', 'Eid al-Fitr', 'global'],
    ['05-27', 'Eid al-Adha (Bakrid)', 'global'],
    ['08-26', 'Onam', 'in'],
    ['08-28', 'Raksha Bandhan', 'in'],
    ['09-04', 'Janmashtami', 'in'],
    ['09-14', 'Ganesh Chaturthi', 'in'],
    ['10-11', 'Navratri begins', 'in'],
    ['10-20', 'Dussehra', 'in'],
    ['11-08', 'Diwali', 'in'],
  ],
  2027: [
    ['02-06', 'Chinese New Year', 'global'],
    ['02-08', 'Ramadan begins', 'global'],
    ['03-10', 'Eid al-Fitr', 'global'],
    ['03-22', 'Holi', 'in'],
    ['05-17', 'Eid al-Adha (Bakrid)', 'global'],
    ['08-17', 'Raksha Bandhan', 'in'],
    ['08-25', 'Janmashtami', 'in'],
    ['09-04', 'Ganesh Chaturthi', 'in'],
    ['09-12', 'Onam', 'in'],
    ['09-30', 'Navratri begins', 'in'],
    ['10-09', 'Dussehra', 'in'],
    ['10-29', 'Diwali', 'in'],
  ],
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** Easter Sunday (Gregorian), by the anonymous algorithm. */
export function easter(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return utc(y, month, ((h + l - 7 * m + 114) % 31) + 1);
}

/** The nth weekday of a month (n = -1 for the last one). */
export function nthWeekday(y: number, month: number, weekday: number, n: number) {
  if (n > 0) {
    const first = utc(y, month, 1);
    return utc(y, month, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7);
  }
  const last = utc(y, month + 1, 0);
  return utc(y, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7));
}

function ruleDate(r: Rule, y: number): Date {
  if ('md' in r) return utc(y, r.md[0], r.md[1]);
  if ('nth' in r) return nthWeekday(y, ...r.nth);
  if ('easter' in r) return new Date(easter(y).getTime() + r.easter * 86_400_000);
  const base = RULES.find((x) => x.name === r.after[0])!;
  return new Date(ruleDate(base, y).getTime() + r.after[1] * 86_400_000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Built-in moments between two dates (inclusive, YYYY-MM-DD). */
export function builtInMoments(from: string, to: string, regions?: Region[]): Moment[] {
  const out: Moment[] = [];
  const y0 = Number(from.slice(0, 4));
  const y1 = Number(to.slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    for (const r of RULES) out.push({ id: `m-${y}-${slug(r.name)}-${r.region}`, date: iso(ruleDate(r, y)), name: r.name, note: r.note ?? '', region: r.region, kind: r.kind, approximate: false });
    for (const [md, name, region] of LUNAR[y] ?? [])
      out.push({ id: `m-${y}-${slug(name)}`, date: `${y}-${md}`, name, note: 'Follows the lunar calendar: the date can differ by a day by region. Confirm locally.', region, kind: 'holiday', approximate: true });
  }
  return out.filter((m) => m.date >= from && m.date <= to && (!regions?.length || regions.includes(m.region as Region)));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listMoments(workspaceId: string, q: { from?: unknown; to?: unknown; regions?: unknown; clientId?: unknown }) {
  const today = iso(new Date());
  const from = typeof q.from === 'string' && DATE.test(q.from) ? q.from : today;
  const to = typeof q.to === 'string' && DATE.test(q.to) ? q.to : iso(new Date(Date.parse(from) + 60 * 86_400_000));
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) throw new HttpError(422, 'Ask for at most a year of moments at a time.');
  const regions = (typeof q.regions === 'string' ? q.regions.split(',') : []).filter((r): r is Region => ['global', 'in', 'us', 'uk'].includes(r));
  const custom = await all<{ id: string; day: Date; name: string; note: string; client_id: string | null; yearly: number }>(
    `SELECT id, day, name, note, client_id, yearly FROM moments WHERE workspace_id = ?${typeof q.clientId === 'string' && q.clientId ? ' AND (client_id IS NULL OR client_id = ?)' : ''}`,
    typeof q.clientId === 'string' && q.clientId ? [workspaceId, q.clientId] : [workspaceId],
  );
  const own: Moment[] = [];
  for (const m of custom) {
    const d = iso(m.day);
    const years = m.yearly ? Array.from({ length: Number(to.slice(0, 4)) - Number(from.slice(0, 4)) + 1 }, (_, i) => Number(from.slice(0, 4)) + i) : [Number(d.slice(0, 4))];
    for (const y of years) {
      const date = `${y}${d.slice(4)}`;
      if (date >= from && date <= to && (m.yearly || date === d))
        own.push({ id: m.id, date, name: m.name, note: m.note, region: 'custom', kind: 'custom', approximate: false, clientId: m.client_id, yearly: !!m.yearly });
    }
  }
  return { from, to, moments: [...builtInMoments(from, to, regions), ...own].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)) };
}

export async function addMoment(workspaceId: string, b: Record<string, unknown>) {
  const day = typeof b.date === 'string' && DATE.test(b.date) && !Number.isNaN(Date.parse(b.date)) ? b.date : null;
  if (!day) throw new HttpError(422, 'Pick a date.');
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 160) : '';
  if (!name) throw new HttpError(422, 'Give the date a name.');
  let clientId: string | null = null;
  if (typeof b.clientId === 'string' && b.clientId) {
    const c = await all('SELECT id FROM clients WHERE id = ? AND workspace_id = ?', [b.clientId, workspaceId]);
    if (!c.length) throw new HttpError(404, 'Brand not found.');
    clientId = b.clientId;
  }
  const id = newId('mom');
  await run('INSERT INTO moments (id, workspace_id, client_id, day, name, note, yearly, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    id,
    workspaceId,
    clientId,
    day,
    name,
    typeof b.note === 'string' ? b.note.trim().slice(0, 500) : '',
    b.yearly ? 1 : 0,
    new Date(),
  ]);
  return id;
}

export async function deleteMoment(workspaceId: string, id: string) {
  const n = await run('DELETE FROM moments WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!n) throw new HttpError(404, 'That date was not found.');
}
