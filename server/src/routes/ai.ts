// The AI writing assistant.
import { Hono } from 'hono';

import { requireUser, type Env } from '../auth.js';
import { adaptPost, aiUsage, altText, editPost, learnVoice, postIdeas, reviewPost, suggestHashtags, writePosts } from '../engine/ai.js';
import { body } from './workspace.js';

export const aiRoutes = new Hono<Env>()
  .use('/ai/*', requireUser)
  .get('/ai/status', async (c) => c.json(await aiUsage(c.get('workspaceId'))))
  .post('/ai/write', async (c) => c.json(await writePosts(c.get('workspaceId'), await body(c))))
  .post('/ai/adapt', async (c) => c.json(await adaptPost(c.get('workspaceId'), await body(c))))
  .post('/ai/hashtags', async (c) => c.json(await suggestHashtags(c.get('workspaceId'), await body(c))))
  .post('/ai/alt-text', async (c) => c.json(await altText(c.get('workspaceId'), await body(c))))
  .post('/ai/edit', async (c) => c.json(await editPost(c.get('workspaceId'), await body(c))))
  .post('/ai/review', async (c) => c.json(await reviewPost(c.get('workspaceId'), await body(c))))
  .post('/ai/ideas', async (c) => c.json(await postIdeas(c.get('workspaceId'), await body(c))))
  .post('/ai/learn-voice', async (c) => c.json(await learnVoice(c.get('workspaceId'), String((await body(c)).clientId ?? ''))));
