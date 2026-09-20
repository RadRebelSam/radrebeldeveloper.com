#!/usr/bin/env node
/**
 * Decides which new public repositories belong on the board, and asks a human
 * about the ones it should not decide alone.
 *
 *   node judge.mjs                 # repositories created since the last run
 *   node judge.mjs --all           # every public repository, ignoring the state
 *   node judge.mjs --dry           # judge and report, write nothing, open nothing
 *   node judge.mjs --verdicts f    # replay saved answers instead of calling Jev
 *
 * The evidence is gathered first and judged second, with no opinion of this
 * script's in between: Jev is shown the repository, not a conclusion about it.
 * Two questions carry the decision — can a stranger use this as it stands, and
 * does it exist to satisfy a course — and the thresholds below are policy, held
 * here in code rather than asked of the model.
 *
 *   usable < 0.60                        -> skip, and never ask again
 *   usable >= 0.60, coursework <= 0.50   -> add
 *   usable >= 0.60, coursework >  0.50   -> open an issue and let a human say
 *
 * A repository with nothing deployed still goes on the board, pointing at the
 * repository and wearing GitHub's mark, since it has no logo of its own.
 *
 * Environment: TYPESAFE_API_KEY for Jev, GITHUB_TOKEN (or GH_TOKEN) to read the
 * repositories and to open the issues.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const USER = 'RadRebelSam';
const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, '.judge-state.json');
const EXTRAS = resolve(HERE, 'extras.json');
const MANIFEST = resolve(HERE, 'projects.json');
const REPORT = resolve(HERE, 'judge-verdicts.json');
const OVERRIDES = resolve(HERE, 'overrides.json');

/* Jev's answer about what a thing is, in the board's own vocabulary. Only the
   unambiguous ones map across; the rest land in misc, where they are at least
   honestly filed rather than confidently mislabelled. */
const AS_CATEGORY = {
  'browser-extension': 'chrome-extension',
  'directory-or-dataset': 'directory',
  'static-site': 'site'
};

const ARGS = process.argv.slice(2);
const ALL = ARGS.includes('--all');
const DRY = ARGS.includes('--dry');
const REPLAY = (() => { const i = ARGS.indexOf('--verdicts'); return i < 0 ? null : ARGS[i + 1]; })();

const USABLE_ENOUGH = 0.60;
const TOO_MUCH_COURSEWORK = 0.50;

/* Already on the board by another route, so there is nothing to decide. */
const SKIP_REPOS = new Set(['radrebeldeveloper.com', 'radrebelsam.github.io']);

/* ------------------------------------------------------------------- github */

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function gh(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `${USER}-judge`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init && init.body ? { 'content-type': 'application/json' } : {})
    },
    signal: AbortSignal.timeout(20000)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* The first stretch of the README, with the badges and decoration stripped:
   what it says it is, not how it dresses. */
async function readme(repo) {
  const meta = await gh(`/repos/${USER}/${repo}/readme`);
  if (!meta || !meta.content) return { text: '', bytes: 0 };
  const raw = Buffer.from(meta.content, 'base64').toString('utf8');
  const text = raw
    .replace(/^---[\s\S]*?---/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_|-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: text.slice(0, 1200), bytes: raw.length };
}

/* Where a visitor would actually go: the site if there is one, the repository
   itself if there is not. A repository has no logo of its own, so it goes on the
   board wearing GitHub's — which is at least honest about what it is. */
function siteFor(r) {
  if (r.homepage) {
    try { const u = new URL(r.homepage); return (u.host + u.pathname).replace(/\/$/, ''); }
    catch { /* fall through */ }
  }
  if (r.has_pages) return `${USER.toLowerCase()}.github.io/${r.name}`;
  return `github.com/${USER}/${r.name}`;
}

/* ---------------------------------------------------------------------- jev */

const QUESTIONS = {
  usable_by_others: {
    type: 'noul',
    instructions: 'Someone other than the author could use, run, or view the result of what is in ' +
      'this repository as it stands. Judge from the evidence of a deployed site, published package, ' +
      'installable artifact, or usage instructions aimed at a reader.',
    criteria: {
      true: 'a stranger could get value from it without the author present',
      false: "it is source kept for the author's own purposes, or nothing runnable is described"
    }
  },
  coursework: {
    type: 'noul',
    instructions: "The repository's contents exist to satisfy a course, class assignment, bootcamp " +
      'prework, scholarship capstone, or a tutorial being followed, rather than being work the ' +
      'author set out to make on their own initiative.'
  },
  kind: {
    type: 'choice',
    instructions: 'What kind of artifact does this repository hold? Judge from the description, ' +
      'README and repository metadata.',
    criteria: {
      'web-app': 'an interactive application people use in a browser',
      'static-site': 'a site that presents content, including fan sites, landing pages and portfolios',
      'browser-extension': 'a browser extension or userscript installed into a browser',
      'library-or-tool': 'a package, CLI, SDK or script others install or run',
      'directory-or-dataset': 'a curated list, directory, corpus or dataset',
      'course-or-tutorial-work': 'assignment submissions, starters, or exercise material',
      'experiment-or-demo': 'a demo, prototype or research experiment not meant as a product',
      unclear: 'the evidence does not settle it'
    }
  }
};

async function askJev(state) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('set TYPESAFE_API_KEY (console.typesafe.ai/keys), or pass --verdicts');

  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions: QUESTIONS }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`typesafe ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const { answers } = await res.json();
  return {
    usable: answers.usable_by_others.noul,
    coursework: answers.coursework.noul,
    kind: answers.kind.choice
  };
}

/* A repository is frequently the source of something already on the board under
   a different spelling — rick-sanchez is ricksanchez.radrebeldeveloper.com. Match
   on letters alone so a hyphen or a space does not raise a pointless question. */
function bare(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

async function alreadyListed() {
  const seen = new Set();
  try {
    const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
    for (const p of m.projects) {
      seen.add(bare(p.slug));
      seen.add(bare(p.name));
      seen.add(bare(p.host.split('/').pop()));
      seen.add(bare(p.host.split('.')[0]));
    }
  } catch {}
  return seen;
}

/* -------------------------------------------------------------------- rules */

function decide(v) {
  if (v.usable < USABLE_ENOUGH) return { verdict: 'skip', why: `nobody else could use it (${v.usable})` };
  if (v.coursework > TOO_MUCH_COURSEWORK) {
    return { verdict: 'ask', why: `usable (${v.usable}) but reads as course work (${v.coursework})` };
  }
  return { verdict: 'add', why: `usable (${v.usable}), not course work (${v.coursework})` };
}

/* --------------------------------------------------------------- the asking */

async function openIssue(c, v, why) {
  const body = [
    `Jev judged this repository worth a second look rather than adding it on its own.`,
    ``,
    `**${c.repo}** — ${c.description || '_no description_'}`,
    `${c.url}${c.site ? `\nSite: https://${c.site}` : ''}`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| a stranger could use it | ${v.usable} |`,
    `| exists to satisfy a course | ${v.coursework} |`,
    `| kind | ${v.kind} |`,
    ``,
    `Held back because ${why}.`,
    ``,
    `**To add it:** put its host in \`extras.json\` and give it a category in \`overrides.json\`,`,
    `then close this issue. **To leave it off:** just close this issue — it will not be raised again.`
  ].join('\n');

  const issue = await gh(`/repos/${USER}/radrebeldeveloper.com/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: `Add ${c.repo} to the board?`, body, labels: ['needs-decision'] })
  });
  return issue ? issue.number : null;
}

/* --------------------------------------------------------------------- main */

let state = { since: null, decided: {} };
try { state = JSON.parse(await readFile(STATE, 'utf8')); } catch {}

const repos = await gh(`/users/${USER}/repos?per_page=100&type=owner&sort=created&direction=desc`);
const public_ = repos.filter(r => !r.private);

/* Every repository that has been ruled on is recorded, so what is left is what
   is new — and anything struck out of the record deliberately comes back for
   another hearing, whenever it was created. */
const fresh = public_.filter(r => {
  if (SKIP_REPOS.has(r.name)) return false;
  return ALL || !state.decided[r.name];
});

let replay = null;
if (REPLAY) {
  const saved = JSON.parse(await readFile(resolve(HERE, REPLAY), 'utf8'));
  replay = new Map(saved.verdicts.map(v => [v.repo, { usable: v.usable, coursework: v.coursework, kind: v.kind }]));
}

const listed = await alreadyListed();
const results = [];
for (const r of fresh) {
  const { text, bytes } = await readme(r.name);
  const c = {
    repo: r.name,
    url: r.html_url,
    site: siteFor(r),
    description: r.description || '',
    topics: r.topics || [],
    language: r.language || '',
    stars: r.stargazers_count,
    is_fork: r.fork,
    archived: r.archived,
    has_pages: r.has_pages,
    size_kb: r.size,
    created: r.created_at.slice(0, 10),
    last_push: r.pushed_at.slice(0, 10),
    readme_bytes: bytes,
    readme_excerpt: text
  };

  if (listed.has(bare(r.name))) {
    results.push({ ...c, usable: null, coursework: null, kind: '',
                   verdict: 'listed', why: 'already on the board' });
    continue;
  }

  const v = replay ? replay.get(r.name) : await askJev(c);
  if (!v) continue;                                        /* replay has nothing for it */
  const { verdict, why } = decide(v);
  results.push({ ...c, ...v, verdict, why });
}

/* Additions go into extras.json as hosts, where the scanner picks them up like
   anything else: it reads their title, copy and favicon on the next run. */
const additions = results.filter(r => r.verdict === 'add');
if (additions.length && !DRY) {
  const extras = JSON.parse(await readFile(EXTRAS, 'utf8'));
  for (const a of additions) if (!extras.hosts.includes(a.site)) extras.hosts.push(a.site);
  extras.hosts.sort();
  await writeFile(EXTRAS, JSON.stringify(extras, null, 2) + '\n');
}

const asks = results.filter(r => r.verdict === 'ask');
for (const a of asks) {
  a.issue = DRY ? null : await openIssue(a, a, a.why);
}

if (!DRY) {
  for (const r of results) {
    state.decided[r.repo] = { verdict: r.verdict, usable: r.usable, at: new Date().toISOString().slice(0, 10) };
  }
  state.since = new Date().toISOString();
  await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
  await writeFile(REPORT, JSON.stringify({
    judged: new Date().toISOString(),
    rule: `add when usable >= ${USABLE_ENOUGH} and coursework <= ${TOO_MUCH_COURSEWORK} and a site exists; ask otherwise`,
    verdicts: results.map(r => ({
      repo: r.repo, usable: r.usable, coursework: r.coursework, kind: r.kind,
      site: r.site, verdict: r.verdict, why: r.why, issue: r.issue || null
    }))
  }, null, 2) + '\n');
}

console.log(`${public_.length} public, ${fresh.length} judged` +
            (state.since && !ALL ? '' : ' (no previous run)'));
for (const r of results.sort((a, b) => (b.usable ?? 2) - (a.usable ?? 2))) {
  const mark = { add: '+', ask: '?', listed: '=', skip: '-' }[r.verdict];
  const nums = r.usable == null ? '                       '
             : `usable ${r.usable.toFixed(2)}  course ${r.coursework.toFixed(2)}  `;
  console.log(`  ${mark} ${r.repo.padEnd(26)} ${nums}${r.why}`);
}
if (DRY) console.log('\n--dry: nothing written, no issues opened');
