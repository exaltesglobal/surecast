// Each client can have weekly posting times ("Tuesday 09:00"). "Add to queue" puts a post in
// the next free one, in the client's own time zone.
import { HttpError } from '../auth.js';
import { all, json } from '../db.js';
import { tzOffsetMs, zonedToUtc } from '../util.js';

export type Slot = { day: number; time: string };

export function cleanSlots(v: unknown): Slot[] {
  if (!Array.isArray(v)) return [];
  const out = new Map<string, Slot>();
  for (const s of v) {
    const day = Number((s as Slot)?.day);
    const time = String((s as Slot)?.time ?? '');
    if (Number.isInteger(day) && day >= 0 && day <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) out.set(`${day} ${time}`, { day, time });
  }
  return [...out.values()].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time)).slice(0, 100);
}

/** The next posting time with nothing else from this client scheduled in it. */
export async function nextQueueSlot(client: { id: string; timezone: string; queue_slots: string | null }, now = new Date(), skip: Date[] = []) {
  const slots = cleanSlots(json(client.queue_slots, []));
  if (!slots.length) throw new HttpError(422, 'Set up posting times for this brand first (Brands > the brand > Posting times).');
  const taken = new Set(
    (
      await all<{ scheduled_at: Date }>(
        "SELECT scheduled_at FROM posts WHERE client_id = ? AND scheduled_at >= ? AND status NOT IN ('cancelled', 'failed', 'draft')",
        [client.id, now],
      )
    ).map((r) => r.scheduled_at.getTime()),
  );
  for (const d of skip) taken.add(d.getTime());
  const local = new Date(now.getTime() + tzOffsetMs(now.getTime(), client.timezone));
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + i));
    for (const s of slots.filter((x) => x.day === day.getUTCDay())) {
      const [h, m] = s.time.split(':').map(Number);
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m, client.timezone);
      if (at.getTime() > now.getTime() + 60_000 && !taken.has(at.getTime())) return at;
    }
  }
  throw new HttpError(422, 'The queue is full for the next year. Add more posting times.');
}
