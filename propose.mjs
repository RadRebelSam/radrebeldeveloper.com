#!/usr/bin/env node
/**
 * Turns judge-proposal.json into the body of a pull request, and says whether
 * there is anything to propose at all.
 *
 *   node propose.mjs body   # writes the markdown to stdout
 *   node propose.mjs count  # prints "<adds> <asks>"
 *   node propose.mjs any    # exits 0 if there is something to propose, 1 if not
 *
 * Kept out of the workflow file because a shell heredoc inside a YAML block
 * scalar is one stray indent away from an unparseable workflow.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let p = { add: [], ask: [], skip: [] };
try { p = JSON.parse(await readFile(resolve(HERE, 'judge-proposal.json'), 'utf8')); } catch {}

const mode = process.argv[2] || 'body';

if (mode === 'any') process.exitCode = (p.add.length || p.ask.length) ? 0 : 1;
else if (mode === 'count') console.log(`${p.add.length} ${p.ask.length}`);
else {
  const out = [
    'Jev judged the repositories that have appeared since the last run.',
    'Merging adds the ones below to the board. Take anything you disagree with',
    'out of the diff first, or close this to leave it all off.',
    ''
  ];

  if (p.add.length) out.push(
    '### Adding', '',
    '| repo | usable | course work | kind | goes to |',
    '| --- | --- | --- | --- | --- |',
    ...p.add.map(r => `| ${r.repo} | ${r.usable} | ${r.coursework} | ${r.kind} | ${r.site} |`),
    ''
  );

  if (p.ask.length) out.push(
    '### Held back', '',
    '| repo | usable | course work | kind | why |',
    '| --- | --- | --- | --- | --- |',
    ...p.ask.map(r => `| ${r.repo} | ${r.usable} | ${r.coursework} | ${r.kind} | ${r.why} |`),
    '',
    'To take one of these, add its host to `extras.json` on this branch.',
    ''
  );

  if (p.skip.length) out.push(
    `<details><summary>${p.skip.length} nobody else could use</summary>`, '',
    ...p.skip.map(r => `- ${r.repo} — usable ${r.usable}`),
    '', '</details>'
  );

  console.log(out.join('\n'));
}
