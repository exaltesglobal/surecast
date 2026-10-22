import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { assertConfig, config, emailConfigured } from './config.js';
import { closeDb, migrate } from './db.js';
import { tick } from './engine/publisher.js';
import { adapters } from './platforms/index.js';

assertConfig();
await migrate();

// The scheduler runs every 20 seconds while the app is awake. Hostinger can put an idle
// Node app to sleep, so the hPanel cron job also calls /v1/cron/tick every minute.
if (config.runScheduler) {
  const run = () => tick('interval').catch((e) => console.error('Scheduler tick failed', e));
  setInterval(run, 20_000).unref();
  setTimeout(run, 3_000).unref();
}

serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  const on = adapters()
    .filter((a) => a.available())
    .map((a) => a.label);
  console.log(`Surecast on :${info.port} · email: ${emailConfigured() ? 'SMTP' : 'console'} · platforms: ${on.join(', ')}`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const)
  process.on(sig, async () => {
    await closeDb().catch(() => undefined);
    process.exit(0);
  });
