import { Bot, Download, KeyRound, Webhook } from 'lucide-react';
import { Link } from 'react-router';

import { CopyField, ErrorBanner, Loading, useLoad } from '../components/ui';
import { api } from '../lib/api';

type Spec = { servers: { url: string }[]; tags: { name: string }[]; paths: Record<string, Record<string, { tags: string[]; summary: string }>> };

export function DevelopersPage() {
  const { data, error } = useLoad(() => api<Spec>('/openapi.json'));
  const origin = location.origin;
  const base = `${origin}/v1`;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Loading />;
  const ops = Object.entries(data.paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, op]) => ({ path, method, ...op })));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API and AI agents</h1>
          <p>Everything in Surecast can be done from your own code, Zapier, or an AI agent like Claude.</p>
        </div>
        <a className="btn" href="/v1/openapi.json" download="surecast-openapi.json">
          <Download size={16} /> OpenAPI file
        </a>
      </div>

      <div className="grid two" style={{ alignItems: 'start' }}>
        <div className="stack">
          <section className="card pad stack">
            <div className="row" style={{ gap: 8 }}>
              <KeyRound size={18} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0 }}>1. Get a key</h3>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Create an API key in <Link to="/settings">Settings</Link>. Send it with every request. A key acts for its workspace with editor rights.
            </p>
            <label className="field">
              Base URL
              <CopyField value={base} />
            </label>
            <pre className="code">{`curl ${base}/clients \\
  -H "Authorization: Bearer sc_live_..."

curl ${base}/posts \\
  -H "Authorization: Bearer sc_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"cli_...","body":"Hello!","channelIds":["chn_..."],"action":"queue"}'`}</pre>
            <p className="tiny muted" style={{ margin: 0 }}>
              Errors come back as JSON with a plain-language <code className="inline">error</code> message, and per-channel <code className="inline">details</code> when a post does not fit a network.
            </p>
          </section>

          <section className="card pad stack">
            <div className="row" style={{ gap: 8 }}>
              <Bot size={18} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0 }}>2. Connect an AI agent (MCP)</h3>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Surecast is an MCP server. Claude, ChatGPT, Cursor and other agents can list clients, write and schedule posts, check the brand guard, pull the emergency brake, plan around holidays, turn a link into a campaign and answer the inbox.
            </p>
            <label className="field">
              Server URL
              <CopyField value={`${origin}/mcp`} />
            </label>
            <strong className="small">Claude Code</strong>
            <pre className="code">{`claude mcp add --transport http surecast ${origin}/mcp \\
  --header "Authorization: Bearer sc_live_..."`}</pre>
            <strong className="small">Claude Desktop, Cursor and others (mcp.json)</strong>
            <pre className="code">{`{
  "mcpServers": {
    "surecast": {
      "type": "http",
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer sc_live_..." }
    }
  }
}`}</pre>
          </section>

          <section className="card pad stack">
            <div className="row" style={{ gap: 8 }}>
              <Webhook size={18} style={{ color: 'var(--accent)' }} />
              <h3 style={{ margin: 0 }}>3. Get told when things happen</h3>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Add a webhook in <Link to="/settings">Settings</Link>. Surecast posts JSON for <code className="inline">post.published</code>, <code className="inline">post.failed</code>,{' '}
              <code className="inline">client.paused</code> and <code className="inline">client.resumed</code>. Check the <code className="inline">X-Surecast-Signature</code> header: the hex HMAC-SHA256 of the raw body with the webhook's secret.
            </p>
            <pre className="code">{`import { createHmac, timingSafeEqual } from 'node:crypto';
const expected = createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));`}</pre>
          </section>
        </div>

        <section className="card">
          <div className="card-head">
            <h2>Endpoints</h2>
            <span className="tiny muted">{ops.length} operations</span>
          </div>
          {data.tags.map((t) => (
            <div key={t.name}>
              <div className="card-body" style={{ paddingBottom: 4 }}>
                <strong className="small">{t.name}</strong>
              </div>
              {ops
                .filter((o) => o.tags[0] === t.name)
                .map((o) => (
                  <div key={`${o.method} ${o.path}`} className="endpoint">
                    <span className={`method ${o.method}`}>{o.method.toUpperCase()}</span>
                    <div>
                      <code className="mono">{o.path}</code>
                      <div className="tiny muted">{o.summary}</div>
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
