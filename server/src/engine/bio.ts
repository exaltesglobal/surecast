// Link-in-bio pages: one small public page per client at /b/<slug>, with their buttons and
// their latest posts. Every link on the page is a tracked short link, so clicks show up in
// analytics next to the posts' own clicks.
import { HttpError } from '../auth.js';
import { all, json, one, run } from '../db.js';
import { URL_RE } from '../platforms/text.js';
import { mediaUrl } from './content.js';
import { shortBase, shortCode } from './links.js';

export type BioLink = { label: string; url: string };
export type BioPage = { slug: string; title: string; bio: string; links: BioLink[]; showPosts: boolean; accent: string; published: boolean; saved: boolean };

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'page';

export async function getBio(workspaceId: string, clientId: string): Promise<BioPage> {
  const client = await one<{ name: string }>('SELECT name FROM clients WHERE id = ? AND workspace_id = ?', [clientId, workspaceId]);
  if (!client) throw new HttpError(404, 'Brand not found.');
  const row = await one('SELECT * FROM bio_pages WHERE client_id = ?', [clientId]);
  if (!row) return { slug: slugify(client.name), title: client.name, bio: '', links: [], showPosts: true, accent: '#FF7A1A', published: true, saved: false };
  return { slug: row.slug, title: row.title, bio: row.bio, links: json<BioLink[]>(row.links, []), showPosts: !!row.show_posts, accent: row.accent, published: !!row.published, saved: true };
}

export async function saveBio(workspaceId: string, clientId: string, b: Record<string, any>) {
  const current = await getBio(workspaceId, clientId);
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : current.slug;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) throw new HttpError(422, 'The page address can use lowercase letters, numbers and dashes (up to 40).');
  const taken = await one<{ client_id: string }>('SELECT client_id FROM bio_pages WHERE slug = ?', [slug]);
  if (taken && taken.client_id !== clientId) throw new HttpError(409, `The address "${slug}" is already taken. Try another.`);
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 120) : current.title;
  if (!title) throw new HttpError(422, 'Give the page a title.');
  const bio = typeof b.bio === 'string' ? b.bio.trim().slice(0, 500) : current.bio;
  const raw: unknown[] = Array.isArray(b.links) ? b.links : current.links;
  if (raw.length > 20) throw new HttpError(422, 'A page can have up to 20 buttons.');
  const links: BioLink[] = [];
  for (const [i, l] of raw.entries()) {
    const label = typeof (l as BioLink)?.label === 'string' ? (l as BioLink).label.trim().slice(0, 80) : '';
    const url = typeof (l as BioLink)?.url === 'string' ? (l as BioLink).url.trim() : '';
    if (!label && !url) continue;
    if (!label) throw new HttpError(422, `Button ${i + 1} needs a label.`);
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000) throw new HttpError(422, `Button "${label}" needs a full link starting with https://.`);
    links.push({ label, url });
  }
  const accent = typeof b.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : current.accent;
  const showPosts = b.showPosts === undefined ? current.showPosts : !!b.showPosts;
  const published = b.published === undefined ? current.published : !!b.published;
  await run(
    `INSERT INTO bio_pages (client_id, workspace_id, slug, title, bio, links, show_posts, accent, published, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE slug = VALUES(slug), title = VALUES(title), bio = VALUES(bio), links = VALUES(links), show_posts = VALUES(show_posts), accent = VALUES(accent), published = VALUES(published), updated_at = VALUES(updated_at)`,
    [clientId, workspaceId, slug, title, bio, JSON.stringify(links), showPosts ? 1 : 0, accent, published ? 1 : 0, new Date()],
  );
  return getBio(workspaceId, clientId);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The public page as HTML, or null when there is no published page at that address. */
export async function renderBio(slug: string): Promise<string | null> {
  const page = await one('SELECT * FROM bio_pages WHERE slug = ? AND published = 1', [slug]);
  if (!page) return null;
  const client = await one<{ id: string; name: string; archived_at: Date | null }>('SELECT id, name, archived_at FROM clients WHERE id = ?', [page.client_id]);
  if (!client || client.archived_at) return null;
  const scope = `bio:${client.id}`;
  const track = async (url: string) => shortBase() + (await shortCode({ workspaceId: page.workspace_id, clientId: client.id, scope, url }));
  const avatar = (await one<{ avatar_url: string | null }>("SELECT avatar_url FROM channels WHERE client_id = ? AND avatar_url IS NOT NULL AND avatar_url <> '' ORDER BY created_at LIMIT 1", [client.id]))?.avatar_url;

  const buttons: string[] = [];
  for (const l of json<BioLink[]>(page.links, [])) buttons.push(`<a class="btn" href="${esc(await track(l.url))}" rel="noopener">${esc(l.label)}</a>`);

  const cards: string[] = [];
  if (page.show_posts) {
    // The latest posts that went out, newest first, one card per post.
    const posts = await all<{ id: string; body: string; media_ids: string; url: string | null }>(
      `SELECT p.id, p.body, p.media_ids, MIN(t.remote_url) AS url FROM posts p JOIN post_targets t ON t.post_id = p.id
       WHERE p.client_id = ? AND t.status = 'published' GROUP BY p.id, p.body, p.media_ids ORDER BY MAX(t.published_at) DESC LIMIT 12`,
      [client.id],
    );
    for (const p of posts) {
      const ids = json<string[]>(p.media_ids, []);
      const img = ids.length ? await one<{ public_key: string; alt: string | null }>('SELECT public_key, alt FROM media WHERE id = ?', [ids[0]]) : null;
      const link = p.body.match(URL_RE)?.[0];
      const href = link ? await track(link) : p.url;
      if (!href) continue;
      const text = p.body.replace(URL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 140);
      cards.push(
        `<a class="card" href="${esc(href)}" rel="noopener">${img ? `<img src="${esc(mediaUrl(img.public_key))}" alt="${esc(img.alt ?? '')}" loading="lazy">` : ''}<span>${esc(text || 'Open')}</span></a>`,
      );
    }
  }

  const accent = /^#[0-9a-fA-F]{6}$/.test(page.accent) ? page.accent : '#FF7A1A';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)}</title><meta name="description" content="${esc(page.bio || page.title)}">
<meta property="og:title" content="${esc(page.title)}">${avatar ? `<meta property="og:image" content="${esc(avatar)}">` : ''}
<style>
:root{--accent:${accent};--bg:#F8F6F2;--ink:#14161C;--muted:#5D6270;--card:#fff;--line:#E7E3DC}
@media (prefers-color-scheme:dark){:root{--bg:#101217;--ink:#F3F1EC;--muted:#A3A8B4;--card:#1A1D24;--line:#2A2E37}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px 24px;text-align:center}
.avatar{width:88px;height:88px;border-radius:50%;object-fit:cover;border:3px solid var(--accent)}
h1{font-size:24px;margin:12px 0 4px}p.bio{color:var(--muted);margin:0 0 24px;white-space:pre-line}
.btn{display:block;padding:14px 16px;margin:0 0 12px;border-radius:12px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}
.btn:hover{filter:brightness(1.05)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-top:28px;text-align:left}
.card{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;color:inherit;text-decoration:none;font-size:14px}
.card img{width:100%;aspect-ratio:1;object-fit:cover}.card span{padding:10px 12px}
footer{margin-top:32px;font-size:12px;color:var(--muted)}footer a{color:inherit}
</style></head>
<body><main>
${avatar ? `<img class="avatar" src="${esc(avatar)}" alt="">` : ''}
<h1>${esc(page.title)}</h1>${page.bio ? `<p class="bio">${esc(page.bio)}</p>` : ''}
${buttons.join('\n')}
${cards.length ? `<div class="grid">${cards.join('\n')}</div>` : ''}
<footer>Made with <a href="https://surecast.live">Surecast</a></footer>
</main></body></html>`;
}
