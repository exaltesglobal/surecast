const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

export const graphemes = (s: string) => [...segmenter.segment(s)].length;
export const codepoints = (s: string) => [...s].length;

export const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** X counts every link as 23 characters and most emoji and CJK characters as 2. */
export function xLength(s: string) {
  let n = 0;
  const withoutUrls = s.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037) ? 1 : 2;
  }
  return n;
}

/** Mastodon counts every link as 23 characters, whatever its length. */
export function mastodonLength(s: string) {
  let n = 0;
  const rest = s.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  return n + codepoints(rest);
}
