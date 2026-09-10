#!/usr/bin/env node
/**
 * Writes a single self-contained report.html from whatever results exist.
 *
 * No CDN, no network, no build step: one file you can open or email. The
 * emphasis is deliberately on DENOMINATORS. Every mistake made while reading
 * this benchmark was a denominator mistake -- trials that never ran, or were
 * invalidated, or timed out, silently folded into a rate and read as a finding
 * about the product. So every rate here shows its numerator, its denominator,
 * and every excluded trial with the reason it was excluded.
 *
 *   node bench/dashboard.mjs [--out docs/report.html]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RESULTS = join(ROOT, 'bench', 'results');
const outArg = process.argv.indexOf('--out');
const OUT = outArg >= 0 ? join(ROOT, process.argv[outArg + 1]) : join(ROOT, 'docs', 'report.html');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const esc = (v) =>
  String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function latestDir(kind, prefix = '') {
  const dir = join(RESULTS, kind);
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir).filter((n) => n.startsWith(prefix) && !n.endsWith('.json'));
  return entries.length === 0 ? null : join(dir, entries.sort().at(-1));
}

/** Agent pilot: rates over graded trials, with every exclusion itemised. */
function agentSection() {
  const dir = latestDir('agents', 'pilot-');
  if (dir === null)
    return { html: '<p class="none">No agent pilot has been run.</p>', title: null };
  const trialsDir = join(dir, 'trials');
  if (!existsSync(trialsDir)) return { html: '<p class="none">Pilot has no trial records.</p>' };
  const records = readdirSync(trialsDir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJson(join(trialsDir, n)));

  const arms = ['A', 'B', 'C', 'D'];
  const label = {
    A: 'A — baseline (git only)',
    B: 'B — + zg',
    C: 'C — + zg + git why',
    D: 'D — + git why',
  };
  const rows = arms.map((arm) => {
    const mine = records.filter((r) => r.arm === arm);
    const invalid = mine.filter((r) => r.invalidation_reason);
    const rest = mine.filter((r) => !r.invalidation_reason);
    const timeout = rest.filter((r) => r.exit_reason === 'wall_clock_timeout');
    const blocked = rest.filter(
      (r) => r.exit_reason !== 'completed' && r.exit_reason !== 'wall_clock_timeout',
    );
    const completed = rest.filter((r) => r.exit_reason === 'completed');
    const graded = completed.filter((r) => r.evidence_grade && r.evidence_grade.goldSha);
    const hits = graded.filter((r) => r.evidence_grade.citedGoldSha).length;
    const gwCalls = completed.reduce((n, r) => n + (r.git_why_calls ?? 0), 0);
    const cost = mine.reduce((n, r) => n + (r.actual_billed_cost ?? 0), 0);
    return {
      arm,
      hits,
      graded: graded.length,
      ungraded: completed.length - graded.length,
      timeout: timeout.length,
      blocked: blocked.length,
      invalid: invalid.length,
      gwCalls,
      cost,
      planned: mine.length,
    };
  });

  const bar = (r) => {
    if (r.graded === 0) return '<span class="none">no graded trials</span>';
    const pct = Math.round((100 * r.hits) / r.graded);
    return `<div class="bar"><span style="width:${pct}%"></span></div><b>${r.hits}/${r.graded}</b> <span class="dim">(${pct}%)</span>`;
  };

  const excluded = records.filter(
    (r) => r.invalidation_reason || (r.exit_reason && r.exit_reason !== 'completed'),
  );

  const html = `
<table>
<thead><tr><th>arm</th><th>cited the verified commit</th><th>timed out</th><th>never started</th><th>invalidated</th><th>git why calls</th><th>cost</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(label[r.arm])}</td><td>${bar(r)}</td><td>${r.timeout || '—'}</td><td>${r.blocked || '—'}</td><td>${r.invalid || '—'}</td><td>${r.gwCalls || '—'}</td><td>$${r.cost.toFixed(4)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>
<p class="note">Rates are over <b>graded</b> trials only. A trial that timed out, never started, or was
invalidated is not a wrong answer, and folding it into the rate would shrink the denominator and read as a
finding about the tool. Those trials are counted in their own columns and listed below.</p>
${
  excluded.length === 0
    ? '<p class="ok">No trial was excluded.</p>'
    : `<details><summary>${excluded.length} excluded trial(s), with reasons</summary><ul>${excluded
        .map(
          (r) =>
            `<li><code>${esc(r.task_id)}</code> arm ${esc(r.arm)} — ${esc(r.invalidation_reason ?? r.exit_reason)}</li>`,
        )
        .join('')}</ul></details>`
}`;
  return { html, title: dir.split('/').at(-1) };
}

/** Retrieval: latest external (real repositories) run, by mode. */
function retrievalSection() {
  const dir = latestDir('external-v2');
  if (dir === null) return '<p class="none">No external-repository retrieval run found.</p>';
  const summaryPath = join(dir, 'summary.json');
  if (!existsSync(summaryPath)) return '<p class="none">Run has no summary.</p>';
  const s = readJson(summaryPath);
  const rows = s.overallByMode ?? [];
  if (rows.length === 0) return '<p class="none">Run scored no cases.</p>';
  return `<p class="dim">${esc(dir.split('/').at(-1))} · ${rows[0].n} cases</p>
<table><thead><tr><th>mode</th><th>Hit@1</th><th>Hit@3</th><th>Hit@5</th><th>MRR</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${esc(r.mode)}</td><td>${(r.hit1 ?? 0).toFixed(3)}</td><td>${(r.hit3 ?? 0).toFixed(3)}</td><td>${(r.hit5 ?? 0).toFixed(3)}</td><td><b>${(r.mrr ?? 0).toFixed(3)}</b></td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
}

const agent = agentSection();
const html = `<!doctype html>
<meta charset="utf-8"><title>Git Why — benchmark dashboard</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:60rem;margin:2rem auto;padding:0 1.25rem}
h1{margin-bottom:.15rem} h2{margin-top:2.25rem;border-bottom:1px solid #8884;padding-bottom:.3rem}
table{border-collapse:collapse;width:100%;margin:.75rem 0}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #8883;vertical-align:middle}
th{font-weight:600;font-size:.85rem;text-transform:uppercase;letter-spacing:.04em;opacity:.7}
td:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
td:nth-child(2){text-align:left}
.bar{display:inline-block;width:7rem;height:.5rem;background:#8883;border-radius:3px;overflow:hidden;margin-right:.5rem;vertical-align:middle}
.bar span{display:block;height:100%;background:#3b82f6}
.dim{opacity:.65} .none{opacity:.6;font-style:italic}
.ok{color:#16a34a}
.note{font-size:.9rem;opacity:.8;border-left:3px solid #8884;padding-left:.75rem;margin:1rem 0}
code{font-size:.9em} details{margin:.75rem 0} summary{cursor:pointer}
footer{margin-top:3rem;font-size:.85rem;opacity:.6}
</style>
<h1>Git Why — benchmark dashboard</h1>
<p class="dim">Generated ${new Date().toISOString()} · self-contained, no network</p>

<h2>Agent usefulness pilot${agent.title ? ` <span class="dim">${esc(agent.title)}</span>` : ''}</h2>
${agent.html}

<h2>Retrieval on real repositories</h2>
${retrievalSection()}

<footer>Every rate shows its numerator and denominator. Excluded trials are itemised rather than dropped.
Full methodology and limits: docs/report.md</footer>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`[bench/dashboard] wrote ${OUT} (${html.length} bytes)`);
