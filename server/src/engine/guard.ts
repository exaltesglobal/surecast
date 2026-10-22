// The brand safety guard. Each client can list words that must never appear in their posts
// (a competitor's name, a banned claim, a swear word) and lines that must always appear (an ad
// disclosure, a licence number, a regulator's warning). In "block" mode a post that breaks a
// rule cannot be scheduled and is stopped at publish time; in "warn" mode it is flagged.
import { json } from '../db.js';

export type Guard = { banned: string[]; required: string[]; mode: 'block' | 'warn' };
export const EMPTY_GUARD: Guard = { banned: [], required: [], mode: 'warn' };

const list = (v: unknown) =>
  [...new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n|,/) : []).map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, 120)))].slice(0, 200);

export function cleanGuard(v: unknown): Guard {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { banned: list(src.banned), required: list(src.required), mode: src.mode === 'block' ? 'block' : 'warn' };
}

export const parseGuard = (raw: unknown): Guard => cleanGuard(json(raw, EMPTY_GUARD));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive match, so "ass" does not flag "class". Phrases and symbols match as written. */
function contains(text: string, term: string) {
  const edge = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
  const pattern = `${edge(term[0]) ? '(?<![\\p{L}\\p{N}])' : ''}${escape(term)}${edge(term.at(-1)!) ? '(?![\\p{L}\\p{N}])' : ''}`;
  return new RegExp(pattern, 'iu').test(text);
}

/** Problems with a piece of text under a guard, in plain language. */
export function guardIssues(guard: Guard, text: string) {
  const issues: string[] = [];
  const found = guard.banned.filter((w) => contains(text, w));
  if (found.length) issues.push(`Uses ${found.length === 1 ? 'a word' : 'words'} this brand never allows: ${found.map((w) => `"${w}"`).join(', ')}.`);
  const missing = guard.required.filter((w) => !text.toLowerCase().includes(w.toLowerCase()));
  if (missing.length) issues.push(`Missing ${missing.length === 1 ? 'a line' : 'lines'} this brand always needs: ${missing.map((w) => `"${w}"`).join(', ')}.`);
  return issues;
}

export const guardActive = (g: Guard) => g.banned.length > 0 || g.required.length > 0;
