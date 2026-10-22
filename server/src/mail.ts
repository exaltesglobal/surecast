// Email: sign-in codes and failure alerts, sent through SMTP (Hostinger mail works).
// Without SMTP settings (local development) messages are printed to the console.
import nodemailer from 'nodemailer';

import { config, emailConfigured } from './config.js';

let transport: nodemailer.Transporter | null = null;
const sent: { to: string; subject: string; text: string }[] = [];

/** The last messages "sent" without SMTP, for tests. */
export const outbox = () => sent;

export async function sendEmail(to: string | string[], subject: string, text: string, html?: string) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) return;
  if (!emailConfigured()) {
    for (const r of recipients) sent.push({ to: r, subject, text });
    if (sent.length > 200) sent.splice(0, sent.length - 200);
    if (!process.env.QUIET_EMAIL) console.log(`[email to ${recipients.join(', ')}] ${subject}\n${text}\n`);
    return;
  }
  const s = config.email.smtp!;
  transport ??= nodemailer.createTransport({ host: s.host, port: s.port, secure: s.port === 465, auth: { user: s.user, pass: s.pass } });
  await transport.sendMail({ from: config.email.from, to: recipients.join(', '), subject, text, html });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A plain, branded HTML wrapper. Every email also has a text version. */
export function emailHtml(title: string, paragraphs: string[], button?: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#FAF8F5;font-family:Figtree,Segoe UI,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:32px 24px">
<div style="font-family:Archivo,Arial,sans-serif;font-weight:800;font-size:20px;letter-spacing:-0.02em">Surecast<span style="color:#FF7A1A">.</span></div>
<h1 style="font-family:Archivo,Arial,sans-serif;font-size:22px;margin:24px 0 12px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px;white-space:pre-line">${esc(p)}</p>`).join('')}
${button ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="background:#111827;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${esc(button.label)}</a></p>` : ''}
<p style="font-size:12px;color:#4B5563;margin-top:32px">Every post goes out. Or you know why.</p>
</div></body></html>`;
}
