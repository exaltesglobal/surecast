import { bluesky } from './bluesky.js';
import { linkedin } from './linkedin.js';
import { mastodon } from './mastodon.js';
import { facebook, instagram } from './meta.js';
import { telegram } from './telegram.js';
import type { Adapter, Platform } from './types.js';
import { x } from './x.js';

const ADAPTERS: Record<Platform, Adapter> = { bluesky, mastodon, telegram, linkedin, facebook, instagram, x };

/** Tests swap in fake adapters here. */
const overrides = new Map<string, Adapter>();

export function adapter(platform: string): Adapter {
  const a = overrides.get(platform) ?? ADAPTERS[platform as Platform];
  if (!a) throw new Error(`Unknown platform ${platform}`);
  return a;
}

export const adapters = () => Object.values(ADAPTERS).map((a) => overrides.get(a.platform) ?? a);

export function overrideAdapter(a: Adapter | null, platform?: string) {
  if (a) overrides.set(a.platform, a);
  else if (platform) overrides.delete(platform);
  else overrides.clear();
}

export * from './types.js';
