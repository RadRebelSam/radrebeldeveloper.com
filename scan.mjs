#!/usr/bin/env node
/**
 * Rebuilds projects.json (and icons/) from what actually exists on the domain.
 *
 *   node scan.mjs            # refresh the manifest and the icons
 *   node scan.mjs --dry      # print what it would write, touch nothing
 *
 * Discovery is certificate transparency: any subdomain that gets an HTTPS
 * certificate is published to the public CT logs within minutes, so a new
 * project reaches the board without anyone editing a list.
 *
 * Each host is then fetched for three things:
 *   - its <title> and description, which become the sticker copy
 *   - its favicon, which becomes the sticker's face
 *   - whether that favicon is its own
 * A subdomain still serving the host's placeholder icon has nothing shipped on
 * it yet, so it is marked "building" and gets the dashed placeholder sticker.
 *
 * overrides.json wins over everything scraped:
 *   { "ricksanchez": { "category": "site", "tagline": "…" } }
 *
 * No dependencies. Node 18+.
 */

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pack from './pack.mjs';

const DOMAIN = 'radrebeldeveloper.com';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'projects.json');
const PAGE = resolve(HERE, 'index.html');
const OVERRIDES = resolve(HERE, 'overrides.json');
const EXTRAS = resolve(HERE, 'extras.json');
const ICON_DIR = resolve(HERE, 'icons');
const DRY = process.argv.includes('--dry');

/* Subdomains that are infrastructure, not projects. */
const IGNORE = new Set(['www', 'mail', 'webmail', 'cpanel', 'ftp', 'autodiscover', 'autoconfig']);

/* Icons served from somewhere else are the host's placeholder, not the project's. */
const PLACEHOLDER_HOSTS = [/hostinger\.com$/i, /hpanel\./i];

/* ---------------------------------------------------------------- discovery */

async function discover() {
  const names = new Set();
  let after = '';

  for (let page = 0; page < 10; page++) {
    const url = `https://api.certspotter.com/v1/issuances?domain=${DOMAIN}` +
                `&include_subdomains=true&expand=dns_names${after ? `&after=${after}` : ''}`;
    /* The CT API rate-limits an impatient caller. Back off and wait rather than
       failing the run — a half-finished discovery would mean a half-empty board. */
    let res;
    for (let tries = 0; ; tries++) {
      res = await fetch(url, { headers: { 'User-Agent': `${DOMAIN}-scan` } });
      if (res.status !== 429) break;
      if (tries === 3) throw new Error('certspotter is rate-limiting us — try again in a few minutes');
      const wait = Number(res.headers.get('retry-after')) || (20 * (tries + 1));
      console.log(`  rate-limited, waiting ${wait}s…`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    if (!res.ok) throw new Error(`certspotter ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;

    for (const row of rows) {
      for (const dns of row.dns_names || []) {
        if (!dns.endsWith(`.${DOMAIN}`) || dns.startsWith('*')) continue;
        const slug = dns.slice(0, -(DOMAIN.length + 1));
        if (slug.includes('.') || IGNORE.has(slug)) continue;
        names.add(slug);
      }
    }
    after = rows[rows.length - 1].id;
  }
  return [...names].sort();
}

/* ------------------------------------------------------------------ parsing */

const decode = s => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, m =>
  ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[m]));

function tag(html, re) {
  const m = html.match(re);
  return m ? decode(m[1].trim()) : '';
}

function clip(s, n) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(' ', n - 1);
  return s.slice(0, cut > 20 ? cut : n - 1).trim() + '…';
}

/* Every <link rel="…icon…">, ranked: the biggest version of the mark wins. */
function iconCandidates(html, pageUrl) {
  const out = [];
  const links = html.match(/<link\b[^>]*>/gi) || [];

  for (const link of links) {
    const rel = (link.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/icon/i.test(rel)) continue;
    const href = (link.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;

    const sizes = (link.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
    const px = Math.max(0, ...sizes.split(/\s+/).map(s => parseInt(s, 10) || 0));
    const type = (link.match(/type=["']([^"']+)["']/i) || [])[1] || '';

    /* Stickers are ~200px, not 16px. An apple-touch-icon is the full mark; a
       plain favicon is often a squashed cut of it that turns to mush when blown
       up, so the big one wins even when both are SVG. */
    let score = px;
    if (/svg/i.test(type) || /\.svg($|\?)/i.test(href)) score = Math.max(score, 256);
    if (/apple-touch-icon/i.test(rel)) score = Math.max(score, 400);
    if (/\.ico($|\?)/i.test(href)) score = Math.min(score, 64);   /* legacy container */
    if (!score) score = 32;

    try { out.push({ url: new URL(href, pageUrl).href, score }); } catch {}
  }

  out.push({ url: new URL('/favicon.ico', pageUrl).href, score: 1 });
  out.sort((a, b) => b.score - a.score);
  return out;
}

const EXT = {
  'image/png': 'png', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg',
  'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico'
};

/* Downloads the best icon that is actually the project's own.
   The file is named after a hash of its CONTENT, so when a site changes its
   favicon the sticker points at a new filename and no cache anywhere — browser,
   CDN or host — can keep serving the old picture. An unchanged favicon keeps its
   name and nothing downstream re-downloads it. */
async function grabIcon(slug, candidates) {
  for (const c of candidates) {
    if (PLACEHOLDER_HOSTS.some(re => re.test(new URL(c.url).hostname))) continue;
    try {
      const res = await fetch(c.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = EXT[type];
      if (!ext) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;                 /* an empty stub is not an icon */

      const stamp = createHash('sha256').update(buf).digest('hex').slice(0, 8);
      const rel = `icons/${slug}.${stamp}.${ext}`;
      if (!DRY) {
        await mkdir(ICON_DIR, { recursive: true });
        await writeFile(resolve(HERE, rel), buf);
      }
      return rel;
    } catch { /* try the next candidate */ }
  }
  return '';
}

/* Anything in icons/ the new manifest no longer points at is a previous version
   of a logo, or a project that went away. Delete it so the folder never grows. */
async function pruneIcons(keep) {
  let removed = 0;
  let names = [];
  try { names = await readdir(ICON_DIR); } catch { return 0; }
  for (const name of names) {
    if (keep.has(`icons/${name}`)) continue;
    if (!DRY) await unlink(resolve(ICON_DIR, name));
    removed++;
  }
  return removed;
}

/* A first guess only — overrides.json is where categories are really decided. */
function guessCategory(blob) {
  if (/chrome extension|browser extension|add-?on|web store/.test(blob)) return 'chrome-extension';
  if (/obsidian/.test(blob)) return 'obsidian-plugin';
  if (/claude skill|agent skill|\bskill\b/.test(blob)) return 'skill';
  if (/directory|curated list|awesome list|catalog/.test(blob)) return 'directory';
  if (/pricing|subscribe|free trial|sign ?up|dashboard/.test(blob)) return 'saas';
  if (/fan site|fan-made|concept|hub/.test(blob)) return 'site';
  return 'misc';
}

/* ------------------------------------------------------------------ probing */

async function probe(target, named) {
  /* target is either a subdomain slug or a full "host[/path]" from extras.json */
  const external = target.includes('.');
  const host = external ? target : `${target}.${DOMAIN}`;
  const tail = target.split('/').filter(Boolean).pop() || target;
  const slug = (external && tail === target.split('/')[0] ? tail.split('.')[0] : tail).toLowerCase();
  const url = `https://${host}`;
  const base = { slug, host, name: slug, tagline: '', category: 'misc', icon: '', status: 'building' };

  /* Certificate transparency remembers a host forever, so a subdomain that has
     since been deleted keeps turning up here. One that does not answer at all —
     no DNS, no connection — is gone rather than unfinished, and is dropped from
     the manifest entirely. Tried twice, so one flaky moment can't erase a
     project that is really still there.
     A host you named yourself in extras.json is the exception: you meant it, so
     silence means "not up yet", not "deleted". */
  let html = '';
  let reached = false;
  for (let attempt = 0; attempt < 2 && !reached; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
      reached = true;
      if (!res.ok) return { ...base, tagline: `Not serving yet (HTTP ${res.status}).` };
      html = (await res.text()).slice(0, 80000);
    } catch {
      if (attempt) {
        return named ? { ...base, tagline: 'Not live yet.' } : null;
      }
    }
  }

  /* A bare repository has no logo of its own, so it borrows GitHub's — one
     shared file rather than a copy per repository, since the bytes are the same.
     The title GitHub serves is "GitHub - user/repo: description", which is the
     description twice over once the host is already saying where it lives. */
  const onGitHub = host.startsWith('github.com/');
  const icon = onGitHub
    ? await grabIcon('github', [{ url: 'https://github.com/fluidicon.png', score: 1 }])
    : await grabIcon(slug, iconCandidates(html, url));

  const title = tag(html, /<title[^>]*>([^<]*)<\/title>/i);
  const desc = tag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)
            || tag(html, /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i);

  /* No favicon of its own means nobody has shipped this subdomain yet. */
  if (!icon) {
    return { ...base, tagline: 'No favicon yet — still being built.' };
  }

  if (onGitHub) {
    const repo = host.split('/').pop();
    return {
      slug,
      host,
      name: repo.replace(/[-_]+/g, ' ').toLowerCase(),
      tagline: clip(desc.replace(/\s+-\s+[\w.-]+\/[\w.-]+\s*$/, ''), 64),
      category: guessCategory(`${title} ${desc}`.toLowerCase()),
      icon,
      status: 'live'
    };
  }

  /* "Decoder - What do they actually mean?" -> name + tagline */
  const parts = title.split(/\s+[—–|-]\s+/);
  const rest = parts.slice(1).join(' — ').trim();

  return {
    slug,
    host,
    name: (parts[0] || slug).trim().toLowerCase(),
    tagline: clip(rest || desc, 64),
    category: guessCategory(`${title} ${desc}`.toLowerCase()),
    icon,
    status: 'live'
  };
}

/* --------------------------------------------------------------------- main */

const slugs = await discover();
if (!slugs.length) {
  console.error('no subdomains found — refusing to overwrite projects.json');
  process.exit(1);
}

let extras = [];
try { extras = (JSON.parse(await readFile(EXTRAS, 'utf8')).hosts || []); } catch {}

const projects = [];
for (const t of slugs) {
  const p = await probe(t, false);                    /* serial: be polite */
  if (p) projects.push(p);
}
for (const t of extras) {
  const p = await probe(t, true);                     /* named by hand: never dropped */
  if (p) projects.push(p);
}

let overrides = {};
try { overrides = JSON.parse(await readFile(OVERRIDES, 'utf8')); } catch {}
for (const p of projects) {
  Object.assign(p, overrides[p.slug] || {});
  /* a hand-supplied logo counts as shipped — some hosts just never set a favicon */
  if (p.icon && p.status !== 'live' && !(overrides[p.slug] || {}).status) p.status = 'live';
}

/* live first, then alphabetical: an unbuilt subdomain never takes the front row */
projects.sort((a, b) =>
  (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1) || a.slug.localeCompare(b.slug));

const dropped = await pruneIcons(new Set(projects.map(p => p.icon).filter(Boolean)));

const next = { site: DOMAIN, generated: new Date().toISOString(), projects };

let prev = null;
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
const same = prev && JSON.stringify(prev.projects) === JSON.stringify(next.projects);

/* index.html carries an inline copy of the manifest so the file still works when
   it is opened straight from disk; keep that copy honest instead of stale. */
async function syncFallback() {
  const html = await readFile(PAGE, 'utf8');
  const open = '/* @generated:fallback', close = '/* @end:fallback */';
  const a = html.indexOf(open), b = html.indexOf(close);
  if (a < 0 || b < 0) return false;

  const body = projects.map(p => '    ' + JSON.stringify({
    slug: p.slug, host: p.host, name: p.name, tagline: p.tagline,
    category: p.category, icon: p.icon, status: p.status
  })).join(',\n');

  const block = open + ' — rewritten by scan.mjs, do not edit by hand */\n' +
                '  var FALLBACK = {projects:[\n' + body + '\n  ]};\n  ' + close;

  const out = html.slice(0, a) + block + html.slice(b + close.length);
  if (out === html) return false;
  await writeFile(PAGE, out);
  return true;
}

if (DRY) {
  console.log(JSON.stringify(next, null, 2));
} else if (same) {
  console.log(`no change — ${projects.length} projects`);
} else {
  await writeFile(OUT, JSON.stringify(next, null, 2) + '\n');
  console.log(`wrote projects.json — ${projects.length} projects`);
  if (await syncFallback()) console.log('synced the inline copy in index.html');
}
for (const p of projects) {
  console.log(`  ${p.status === 'live' ? '●' : '○'} ${p.host.padEnd(38)} ${p.category.padEnd(17)} ${p.tagline}`);
}
if (dropped) console.log(`pruned ${dropped} stale icon file${dropped === 1 ? '' : 's'}`);

/* The upload is only ever as fresh as the manifest, so rebuild it here rather
   than leaving it to be remembered. */
if (!DRY) {
  const z = await pack();
  console.log(`packed dist/radrebeldeveloper.com.zip — ${z.files} files, ${(z.packed / 1024).toFixed(0)} KB`);
}
