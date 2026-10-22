# Surecast

**Every post goes out. Or you know why.**

Surecast is a social media scheduler for agencies. It's built around one promise: a scheduled post is published, or you are told immediately, in plain words, why it wasn't and what to do about it.

## What's in it

- **Reliable publishing engine.** Each post is sent to each channel as a separate job, and every attempt is logged. Temporary errors (rate limits, timeouts, platform outages) are retried with backoff. Permanent errors stop at once and explain the fix. A post is never sent twice: jobs are claimed atomically, and if publishing is interrupted on a platform that can't de-duplicate, the post is flagged for a person to check instead of being retried blind.
- **Pre-flight checks.** 15 minutes before each slot, Surecast checks the connection and the content and warns you if the post would fail.
- **Watchdog.** A post that misses its slot by more than 2 hours (for example during server downtime) is held for review. It is not published hours late.
- **Channel health.** Every connection is checked every 6 hours. You get a warning a week before a token expires. When a channel disconnects, its posts wait, and they go out automatically as soon as you reconnect it.
- **Alerts** on screen and by email, de-duplicated, so one problem sends one email.
- **Clients.** Each client has its own channels, time zone, colour and approval setting.
- **Client approvals** through a no-login portal link, with an approve-all button and change requests.
- **Proof-of-publish reports.** A monthly report for each client that lists every post, when it went out and its live link. It's printable and can be shared as a link.
- **Calendar, composer and queue.** The composer lets you change the text for each network, shows live character counts against each platform's rules, previews the post, and takes images with alt text. Editing a post keeps its scheduled time.
- **Team** with unlimited seats and owner, admin and editor roles.
- **Writing assistant** (AI). Drafts three post options from a short brief, rewrites a post (shorter, punchier, better hook, call to action, translate, or any instruction), adapts one post into a version for each network within its limits, suggests hashtags, writes image alt text, reviews a post for typos, risky claims and leftover placeholders before it goes out, and suggests post ideas. It writes in each client's **brand voice**, which you can describe by hand or have it learn from the client's past posts. It never changes a post on its own: every suggestion has a "Use this" button. Each workspace gets a daily request limit (`AI_DAILY_LIMIT`, default 300).
- **API keys and signed webhooks**, so scripts and Zapier can schedule posts.
- **An MCP server**, so AI agents can plan, schedule and report on posts and answer comments.
- **A unified inbox** for comments and replies from every network, with AI reply suggestions in each client's voice.
- **Dark mode**, and a layout that works on mobile.

### Networks

| Network | Status |
|---|---|
| Bluesky | Works now (connects with an app password) |
| Mastodon | Works now (OAuth on any server) |
| Telegram channels | Works now (connects with a bot token) |
| LinkedIn | Built. Switched on when `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` are set |
| Facebook Pages and Instagram | Built. Switched on when `META_APP_ID` and `META_APP_SECRET` are set; the Meta app must pass App Review |
| X | Built. Switched on when `X_CLIENT_ID` and `X_CLIENT_SECRET` are set; needs a paid API plan (Basic or higher for inbox replies) |
| Threads | Built. Switched on when `THREADS_APP_ID` and `THREADS_APP_SECRET` are set (a Meta app with the Threads use case) |
| Pinterest | Built. Switched on when `PINTEREST_APP_ID` and `PINTEREST_APP_SECRET` are set; each board is a channel, every Pin needs an image |
| Google Business Profile | Built. Switched on when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set; Google must grant Business Profile API access |
| YouTube | Built. Switched on by the same `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Google Business; each YouTube channel is a channel, every post is one video (first line = title) |
| TikTok | Built. Switched on when `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` are set; every post is one video, private until TikTok audits the app |

The OAuth redirect URLs to register with each developer app are:

- `https://app.surecast.live/v1/oauth/linkedin/callback`
- `https://app.surecast.live/v1/oauth/facebook/callback` (used by both Facebook and Instagram)
- `https://app.surecast.live/v1/oauth/x/callback`
- `https://app.surecast.live/v1/oauth/threads/callback`
- `https://app.surecast.live/v1/oauth/pinterest/callback`
- `https://app.surecast.live/v1/oauth/google/callback`
- `https://app.surecast.live/v1/oauth/youtube/callback` (same Google app)
- `https://app.surecast.live/v1/oauth/tiktok/callback`
- `https://app.surecast.live/v1/oauth/mastodon/callback` (registered automatically on each Mastodon server)

## Stack

Surecast runs as one Node 22 app. A Hono API (TypeScript) also serves the React web app, which Vite builds into `web/dist`. Data is kept in MySQL or MariaDB, images and videos included (videos in 4 MB chunks), so uploads survive redeploys. Email goes out over SMTP.

```
server/src/
  engine/      publishing engine, pre-flight, watchdog, channel health, alerts, webhooks
  platforms/   one adapter per network, behind a single interface
  routes/      HTTP API (/v1)
web/src/       React app
scripts/       demo data
```

## Local development

You need Node 22 and MySQL or MariaDB.

```bash
cp .env.example .env          # fill in DB_* (APP_SECRET can stay empty locally)
npm install
npm run dev                   # API on :3000, web app on :5173
npm test                      # engine and API tests (uses the surecast_test database)
npx tsx scripts/seed-demo.ts you@example.com   # optional sample data, after signing in once
```

Without SMTP settings, emails (including sign-in codes) are printed to the console.

## Deploy on Hostinger (app.surecast.live)

1. **Database:** in hPanel, go to Databases > MySQL and create a database and a user. You don't need to import anything, because the app creates its tables on first start.
2. **Email:** create a mailbox such as `alerts@surecast.live` in hPanel > Emails.
3. **Node.js app:** in hPanel > Websites, add the app.surecast.live subdomain as a Node.js app (the marketing site lives separately on surecast.live) connected to this GitHub repository.
   - Build command: `npm ci && npm run build`
   - Start command: `npm start`
   - Node version: 22
4. **Environment variables:** set everything in `.env.example`.
   - `NODE_ENV=production`
   - `PUBLIC_URL=https://app.surecast.live`
   - `DB_HOST=127.0.0.1`
   - `APP_SECRET`: 64 or more random characters. Keep it safe, because changing it disconnects every channel.
   - `CRON_SECRET`: another random string.
   - `EMAIL_FROM` and the `SMTP_*` variables (`smtp.hostinger.com`, port 465). In production, the app won't start if any of these are missing.
   - `ANTHROPIC_API_KEY` (optional) switches on the writing assistant. Create a key at console.anthropic.com. The assistant uses Claude Opus 5.5; set `AI_MODEL` to use a different model.
   - `ADMIN_EMAILS`: the Surecast team emails that get the admin panel at `/admin` as superadmins. Add other staff with narrower roles from the panel.
   - `CHITTHI_URL` (optional) only if Chitthi runs somewhere other than `https://app.chitthi.live`.
5. **Cron job:** in hPanel > Advanced > Cron Jobs, add a job that runs every minute:
   ```
   curl -fsS "https://app.surecast.live/v1/cron/tick?key=YOUR_CRON_SECRET" > /dev/null
   ```
   The app also runs the scheduler every 20 seconds while it is awake. The cron job wakes it if Hostinger has put it to sleep.
6. **Check:** `https://app.surecast.live/v1/health` should return `"ok": true` and show a recent `lastTickAt`.

Never commit `.env` or paste keys into chat. Set them only in Hostinger's environment variables.

## API

Create a key in Settings > API keys, then:

```bash
curl https://app.surecast.live/v1/clients -H "Authorization: Bearer sc_live_..."

curl https://app.surecast.live/v1/posts -H "Authorization: Bearer sc_live_..." -H "Content-Type: application/json" -d '{
  "clientId": "cli_...", "channelIds": ["chn_..."], "body": "Hello!",
  "action": "schedule", "scheduledAt": "2026-11-01T09:00:00Z"
}'
```

Webhooks receive `post.published` and `post.failed`. Each one is signed with a hex HMAC-SHA256 of the raw body, sent in `X-Surecast-Signature`.

## MCP server for AI agents

Surecast is also an MCP server, so Claude, ChatGPT, Cursor and other agents can plan, schedule and check posts, read results and answer comments. Point the agent at `https://app.surecast.live/mcp` (Streamable HTTP) with the header `Authorization: Bearer sc_live_...`. For Claude Code:

```bash
claude mcp add --transport http surecast https://app.surecast.live/mcp --header "Authorization: Bearer sc_live_..."
```

Tools: `list_clients`, `create_post`, `list_posts`, `get_post`, `cancel_post`, `next_free_slot`, `get_analytics`, `best_posting_times`, `list_inbox`, `reply_to_comment` and `draft_posts_with_ai`. Posts made by agents go through the same checks, approval steps and delivery guarantees as posts made in the app.
