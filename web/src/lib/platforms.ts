export const PLATFORM: Record<string, { label: string; color: string; short: string }> = {
  bluesky: { label: 'Bluesky', color: '#1185fe', short: 'B' },
  mastodon: { label: 'Mastodon', color: '#6364ff', short: 'M' },
  telegram: { label: 'Telegram', color: '#229ed9', short: 'T' },
  linkedin: { label: 'LinkedIn', color: '#0a66c2', short: 'in' },
  facebook: { label: 'Facebook', color: '#1877f2', short: 'f' },
  instagram: { label: 'Instagram', color: '#d62976', short: 'IG' },
  x: { label: 'X', color: '#111111', short: 'X' },
  threads: { label: 'Threads', color: '#000000', short: '@' },
  pinterest: { label: 'Pinterest', color: '#e60023', short: 'P' },
  google: { label: 'Google Business', color: '#1a73e8', short: 'G' },
  youtube: { label: 'YouTube', color: '#ff0000', short: 'YT' },
  tiktok: { label: 'TikTok', color: '#010101', short: 'TT' },
  whatsapp: { label: 'WhatsApp', color: '#25d366', short: 'W' },
};

/** Networks where a post can continue as a thread of replies. The rest only take a first comment. */
export const THREADS = ['x', 'bluesky', 'mastodon', 'threads', 'telegram'];

export const platformInfo = (p: string) => PLATFORM[p] ?? { label: p, color: '#4b5563', short: p.slice(0, 1).toUpperCase() };

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  changes_requested: 'Changes requested',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  retrying: 'Retrying',
  published: 'Posted',
  partial: 'Partly failed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
  ok: 'Healthy',
  expiring: 'Expiring',
  failing: 'Failing',
  disconnected: 'Disconnected',
};
