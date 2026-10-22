import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { authenticate, HttpError, type Env } from './auth.js';
import { adminRoutes } from './routes/admin.js';
import { agencyRoutes, hookRoutes } from './routes/agency.js';
import { aiRoutes } from './routes/ai.js';
import { analyticsRoutes, linkRoutes } from './routes/analytics.js';
import { channelRoutes } from './routes/channels.js';
import { driveRoutes } from './routes/drive.js';
import { inboxRoutes } from './routes/inbox.js';
import { insightRoutes } from './routes/insights.js';
import { libraryRoutes } from './routes/library.js';
import { mcpRoutes } from './routes/mcp.js';
import { openApiRoutes } from './routes/openapi.js';
import { postRoutes } from './routes/posts.js';
import { mediaRoutes, publicRoutes } from './routes/public.js';
import { accountRoutes, workspaceRoutes } from './routes/workspace.js';

// The built web app lives in web/dist at the repository root.
const webRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');

export function createApp() {
  const app = new Hono<Env>();
  app.use(secureHeaders({ crossOriginResourcePolicy: false, xFrameOptions: 'DENY', referrerPolicy: 'strict-origin-when-cross-origin' }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, details: (err as HttpError & { details?: unknown }).details }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
  });

  const v1 = new Hono<Env>();
  v1.use(authenticate);
  v1.route('/', publicRoutes);
  v1.route('/', hookRoutes);
  v1.route('/', openApiRoutes);
  v1.route('/', accountRoutes);
  v1.route('/', driveRoutes);
  v1.route('/', channelRoutes);
  v1.route('/', workspaceRoutes);
  v1.route('/', postRoutes);
  v1.route('/', insightRoutes);
  v1.route('/', aiRoutes);
  v1.route('/', libraryRoutes);
  v1.route('/', analyticsRoutes);
  v1.route('/', inboxRoutes);
  v1.route('/', mcpRoutes);
  v1.route('/', agencyRoutes);
  v1.route('/', adminRoutes);
  v1.all('*', (c) => c.json({ error: 'Not found' }, 404));
  app.route('/v1', v1);
  // Agents can also use the shorter https://app.surecast.live/mcp.
  app.use('/mcp', authenticate);
  app.route('/', mcpRoutes);
  app.route('/', mediaRoutes);
  app.route('/', linkRoutes);

  if (existsSync(webRoot)) {
    const index = readFileSync(join(webRoot, 'index.html'), 'utf8');
    app.use('/assets/*', serveStatic({ root: webRoot, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use('*', serveStatic({ root: webRoot }));
    // Single-page app: every other path gets index.html.
    app.get('*', (c) => c.html(index, 200, { 'Cache-Control': 'no-cache' }));
  } else {
    app.get('/', (c) => c.text('Surecast API is running. Build the web app with `npm run build` to serve it here.'));
  }
  return app;
}
