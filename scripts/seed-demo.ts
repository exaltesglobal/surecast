// Fills a workspace with sample clients, channels and posts so you can try the app
// without connecting real accounts. Usage: npx tsx scripts/seed-demo.ts you@example.com
// Never run it against production.
import { config } from '../server/src/config.js';
import { all, closeDb, migrate, one, run } from '../server/src/db.js';
import { rollupPost } from '../server/src/engine/publisher.js';
import { savePost } from '../server/src/engine/posts.js';
import { encrypt, newId, token } from '../server/src/util.js';

if (config.production) throw new Error('Refusing to seed demo data in production');
const email = process.argv[2];
if (!email) throw new Error('Pass the email you sign in with');
await migrate();
const user = await one<{ id: string; email: string; name: string }>('SELECT id, email, name FROM users WHERE email = ?', [email.toLowerCase()]);
if (!user) throw new Error('Sign in once first so the account exists');
const ws = (await one<{ workspace_id: string }>('SELECT workspace_id FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1', [user.id]))!.workspace_id;
const now = Date.now();
const H = 3_600_000;

const clients = [
  { name: 'Acme Bakery', tz: 'Asia/Kolkata', color: '#FF7A1A', approval: false, channels: [['bluesky', 'Acme Bakery', '@acmebakery.bsky.social', 'ok'], ['mastodon', 'Acme Bakery', '@acme@mastodon.social', 'ok'], ['telegram', 'Acme Deals', '@acmedeals', 'ok']] },
  { name: 'Northwind Fitness', tz: 'Europe/London', color: '#1185FE', approval: true, channels: [['bluesky', 'Northwind', '@northwind.fit', 'expiring'], ['linkedin', 'Northwind Fitness', 'Northwind Fitness', 'ok']] },
  { name: 'Lotus Dental', tz: 'America/New_York', color: '#1E7A4C', approval: false, channels: [['mastodon', 'Lotus Dental', '@lotus@fosstodon.org', 'disconnected'], ['telegram', 'Lotus Smiles', '@lotussmiles', 'ok']] },
] as const;

const texts = [
  'Fresh sourdough is out of the oven. First 20 loaves get a free jar of our honey butter.',
  'Five-minute mobility routine you can do at your desk. Save this for later.',
  'Did you know? Flossing once a day lowers your risk of gum disease by up to 40%.',
  'Weekend special: buy two croissants, get a coffee on us. Saturday and Sunday only.',
  'New class alert: Sunrise HIIT starts Monday at 6:30 am. Book your spot through the link in bio.',
  'Meet Dr. Patel, our newest team member, who specialises in gentle care for nervous patients.',
  'Behind the scenes: how we laminate 81 layers of butter into every croissant.',
  'Member spotlight: Sarah ran her first half marathon this weekend. So proud of you!',
];

for (const [ci, c] of clients.entries()) {
  const clientId = newId('cli');
  await run('INSERT INTO clients (id, workspace_id, name, timezone, color, approval_required, share_token, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    clientId, ws, c.name, c.tz, c.color, c.approval ? 1 : 0, token(18), c.approval ? 'client@example.com' : null, new Date(),
  ]);
  const chIds: string[] = [];
  for (const [platform, name, handle, status] of c.channels) {
    const id = newId('chn');
    chIds.push(id);
    await run(
      'INSERT INTO channels (id, workspace_id, client_id, platform, name, handle, external_id, credentials, status, status_detail, token_expires_at, last_checked_at, last_ok_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ws, clientId, platform, name, handle, `demo-${id}`, encrypt({ demo: true }), status,
       status === 'expiring' ? 'Connection expires in 4 days. Reconnect to renew it.' : status === 'disconnected' ? 'The Mastodon connection has expired or was revoked. Reconnect this channel.' : null,
       status === 'expiring' ? new Date(now + 4 * 24 * H) : null, new Date(), new Date(), new Date()],
    );
  }
  // Past posts: published (one failed), upcoming scheduled, a draft.
  for (let i = 0; i < 6; i++) {
    const when = new Date(now - (i + 1) * 26 * H - ci * 3 * H);
    const id = await savePost(ws, user, { clientId, body: texts[(i + ci) % texts.length], channelIds: chIds.slice(0, 2), action: 'draft' });
    await run('UPDATE posts SET scheduled_at = ? WHERE id = ?', [when, id]);
    const targets = await all<{ id: string }>('SELECT id FROM post_targets WHERE post_id = ?', [id]);
    for (const [ti, t] of targets.entries()) {
      const fail = ci === 2 && i === 0 && ti === 0;
      const retried = i === 2 && ti === 1;
      await run(
        `UPDATE post_targets SET status = ?, due_at = ?, attempts = ?, published_at = ?, remote_url = ?, error_code = ?, error_message = ?, error_hint = ? WHERE id = ?`,
        [fail ? 'failed' : 'published', when, retried ? 2 : 1, fail ? null : new Date(when.getTime() + (retried ? 61_000 : 2_000)), fail ? null : 'https://bsky.app/profile/demo/post/demo',
         fail ? 'unauthorized' : null, fail ? 'Mastodon returned 401: The access token was revoked' : null, fail ? 'The Mastodon connection has expired or was revoked. Reconnect this channel.' : null, t.id],
      );
      if (retried) await run("INSERT INTO attempts (id, target_id, number, started_at, finished_at, outcome, error_code, http_status, message) VALUES (?, ?, 1, ?, ?, 'temporary_error', 'server_error', 503, 'Bluesky returned 503: Service Unavailable')", [newId('att'), t.id, when, when]);
      await run('INSERT INTO attempts (id, target_id, number, started_at, finished_at, outcome, error_code, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        newId('att'), t.id, retried ? 2 : 1, when, when, fail ? 'auth_error' : 'success', fail ? 'unauthorized' : null, fail ? 'Mastodon returned 401: The access token was revoked' : null,
      ]);
      if (fail) await run("INSERT INTO alerts (id, workspace_id, dedupe_key, kind, severity, title, detail, client_id, post_id, target_id, created_at) VALUES (?, ?, ?, 'post_failed', 'error', ?, ?, ?, ?, ?, ?)", [
        newId('alr'), ws, `target:${t.id}:failed`, `Post for ${c.name} did not go out on Mastodon (Lotus Dental)`, 'Mastodon returned 401: The access token was revoked. Reconnect this channel.', clientId, id, t.id, new Date(),
      ]);
    }
    await rollupPost(id);
  }
  for (let i = 0; i < 5; i++) {
    const when = new Date(now + (i * 31 + 5 + ci * 7) * H);
    await savePost(ws, user, { clientId, body: texts[(i + ci + 3) % texts.length], channelIds: c.channels[i % c.channels.length][3] === 'disconnected' ? chIds.slice(1) : chIds, action: 'schedule', scheduledAt: when.toISOString() });
  }
  await savePost(ws, user, { clientId, body: 'Draft: holiday opening hours (to confirm)', channelIds: chIds, action: 'draft' });
}
await run("INSERT INTO alerts (id, workspace_id, dedupe_key, kind, severity, title, detail, created_at) VALUES (?, ?, 'demo:expiring', 'token_expiring', 'warning', 'Bluesky channel \"Northwind\" expires in 4 days', 'Reconnect it from the Channels page so scheduled posts keep going out.', ?)", [newId('alr'), ws, new Date()]);
console.log('Demo data added.');
await closeDb();
