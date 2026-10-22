// All settings come from environment variables (Hostinger: Websites > app.surecast.live > Environment variables).
import { existsSync, readFileSync } from 'node:fs';

// Local development: read .env if present. Hostinger sets real environment variables.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  production: env.NODE_ENV === 'production',
  /** Where people reach the app, used in emails, OAuth redirects and public media links. */
  publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  appSecret: env.APP_SECRET ?? '',
  cronSecret: env.CRON_SECRET ?? '',
  db: {
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER ?? '',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME ?? '',
  },
  email: {
    from: env.EMAIL_FROM ?? '',
    smtp: env.SMTP_HOST ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' } : null,
  },
  linkedin: app(env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET),
  meta: app(env.META_APP_ID, env.META_APP_SECRET),
  x: app(env.X_CLIENT_ID, env.X_CLIENT_SECRET),
  threads: app(env.THREADS_APP_ID, env.THREADS_APP_SECRET),
  pinterest: app(env.PINTEREST_APP_ID, env.PINTEREST_APP_SECRET),
  google: app(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  /** The AI writing assistant. Switched off when no key is set. */
  ai: {
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.AI_MODEL || 'claude-opus-5-5',
    /** Requests per workspace per day, so one runaway script can't run up the bill. */
    dailyLimit: Number(env.AI_DAILY_LIMIT) || 300,
  },
  /** Chitthi, the WhatsApp Business app agencies connect for approvals, alerts and client chats. */
  chitthiUrl: (env.CHITTHI_URL || 'https://app.chitthi.live').replace(/\/+$/, ''),
  /** People who are always Surecast superadmins, comma separated. Others are added in the admin panel. */
  adminEmails: (env.ADMIN_EMAILS ?? '').split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
  /** Posts more than this many minutes late are held for review instead of going out. */
  lateLimitMinutes: Number(env.LATE_LIMIT_MINUTES) || 120,
  /** Run the scheduler inside the web process. Tests turn this off and call tick() directly. */
  runScheduler: env.RUN_SCHEDULER !== 'false',
};

function app(id?: string, secret?: string) {
  return id && secret ? { id, secret } : null;
}

export const emailConfigured = () => !!(config.email.from && config.email.smtp);

export function assertConfig() {
  const problems: string[] = [];
  if (config.production && config.appSecret.length < 32) problems.push('APP_SECRET must be a long random value (32+ characters)');
  if (!config.db.user || !config.db.database) problems.push('DB_USER and DB_NAME must be set');
  if (config.production && !emailConfigured()) problems.push('Email must be configured (EMAIL_FROM and SMTP_*): sign-in codes and alerts are sent by email');
  if (config.production && !config.cronSecret) problems.push('CRON_SECRET must be set so the hPanel cron job can wake the scheduler');
  if (!config.appSecret) config.appSecret = 'dev-only-secret-dev-only-secret-dev-only';
  if (problems.length) {
    console.error(`Configuration problems:\n - ${problems.join('\n - ')}`);
    if (config.production) process.exit(1);
  }
}
