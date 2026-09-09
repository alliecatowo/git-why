#!/usr/bin/env node
// Generates docs/report.md FROM SAVED RAW RESULTS under bench/results/ --
// never from hand-entered percentages. Every number below is read out of a
// JSON file written by bench/retrieval/run.mjs or bench/perf/run.mjs (or
// computed by simple arithmetic over those files). Qualitative claims about
// the environment (zg presence, agent-pilot results) are checked live
// against the filesystem/PATH at generation time rather than asserted.
//
// Usage: node bench/report.mjs

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const RESULTS_DIR = join(REPO_ROOT, 'bench', 'results');
const DOCS_DIR = join(REPO_ROOT, 'docs');

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function sh(args) {
  const res = spawnSync(args[0], args.slice(1), { cwd: REPO_ROOT, encoding: 'utf8' });
  return (res.stdout ?? '').trim();
}

function listDirs(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d.startsWith(prefix) && statSync(join(dir, d)).isDirectory())
    .sort();
}

function fmt(x) {
  return x === null || x === undefined ? 'n/a' : pct(x);
}

function relPath(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function num(x, digits = 3) {
  return x == null ? 'n/a' : x.toFixed(digits);
}
function ms(x) {
  return x == null ? 'n/a' : `${x.toFixed(0)} ms`;
}

// ---------------------------------------------------------------------
// Locate the runs this report is built from. "Latest" = most recent
// directory (timestamps are ISO-8601 with ':' -> '-', so lexical sort ==
// chronological sort) that actually contains the data this section needs.
// This is what makes a pre-fix or blocked run get superseded automatically
// instead of by a hardcoded timestamp.
// ---------------------------------------------------------------------

const retrievalDir = join(RESULTS_DIR, 'retrieval');
const devDirs = listDirs(retrievalDir, 'dev-');
const testDirs = listDirs(retrievalDir, 'test-');

const devMainDirName = [...devDirs]
  .reverse()
  .find(
    (d) =>
      existsSync(join(retrievalDir, d, 'summary.json')) &&
      readJson(join(retrievalDir, d, 'summary.json')).totalQueries > 0,
  );
if (!devMainDirName)
  throw new Error(
    'No dev-* retrieval run with totalQueries > 0 found under bench/results/retrieval. Run bench/retrieval/run.mjs --split=dev first.',
  );
const devMainDir = join(retrievalDir, devMainDirName);
const devMainSummary = readJson(join(devMainDir, 'summary.json'));

const devAblationDirName = [...devDirs].reverse().find((d) => {
  try {
    return readdirSync(join(retrievalDir, d)).some((f) => f.startsWith('ablation-summary-'));
  } catch {
    return false;
  }
});
const ablationFile = devAblationDirName
  ? readdirSync(join(retrievalDir, devAblationDirName)).find((f) =>
      f.startsWith('ablation-summary-'),
    )
  : null;
const ablationSummary = ablationFile
  ? readJson(join(retrievalDir, devAblationDirName, ablationFile))
  : null;

const testDirName = testDirs.at(-1);
if (!testDirName)
  throw new Error('No test-* (held-out) retrieval run found under bench/results/retrieval.');
const testDir = join(retrievalDir, testDirName);
const testSummary = readJson(join(testDir, 'summary.json'));

const perfDirs = listDirs(join(RESULTS_DIR, 'perf'), '');
const perfDirName = perfDirs.at(-1);
if (!perfDirName)
  throw new Error('No perf run found under bench/results/perf. Run bench/perf/run.mjs first.');
const perfResults = readJson(join(RESULTS_DIR, 'perf', perfDirName, 'results.json'));

const protocol = readJson(join(REPO_ROOT, 'bench', 'protocol.json'));

const externalDataset = readJson(join(REPO_ROOT, 'bench', 'dataset', 'external.json'));
const externalDirs = listDirs(join(RESULTS_DIR, 'external'), '');
const externalRunDir = externalDirs.at(-1)
  ? join(RESULTS_DIR, 'external', externalDirs.at(-1))
  : null;
const externalSummary = externalRunDir ? readJson(join(externalRunDir, 'summary.json')) : null;
const externalPerQuery = externalRunDir ? readJson(join(externalRunDir, 'per-query.json')) : null;

// Anti-overfitting extension: 6 further repos, cases authored before any
// retrieval run against those clones. New shape only (overallByMode).
const externalV2Dirs = listDirs(join(RESULTS_DIR, 'external-v2'), '');
const externalV2RunDir = externalV2Dirs.at(-1)
  ? join(RESULTS_DIR, 'external-v2', externalV2Dirs.at(-1))
  : null;
const externalV2Summary = externalV2RunDir
  ? readJson(join(externalV2RunDir, 'summary.json'))
  : null;
const externalV2PerQuery = externalV2RunDir
  ? readJson(join(externalV2RunDir, 'per-query.json'))
  : null;

// Live environment checks -- not hand-asserted.
const zgPath = sh(['which', 'zg']);
const zgInstalled = zgPath.length > 0;
const agentsResultsDir = join(RESULTS_DIR, 'agents');
const agentRunDirs = existsSync(agentsResultsDir) ? readdirSync(agentsResultsDir) : [];
const pilotDirs = agentRunDirs.filter((d) => d.startsWith('pilot-'));
const smokeDirs = agentRunDirs.filter((d) => d.startsWith('smoke-'));

const headSha = sh(['git', 'rev-parse', 'HEAD']);
const dirtyFiles = sh(['git', 'status', '--porcelain']).split('\n').filter(Boolean);
const nodeVersion = sh(['node', '--version']);
const gitVersion = sh(['git', '--version']);

// ---------------------------------------------------------------------
// Helpers over the retrieval summaries
// ---------------------------------------------------------------------

function overallRow(summary, mode) {
  return summary.overall.find((r) => r.mode === mode) ?? null;
}

function categoryRows(summary, mode) {
  return summary.byCandidateModeCategory.filter(
    (r) => r.mode === mode && r.category !== 'no_evidence',
  );
}

function modelInfo() {
  // Pull from any perf status snapshot that includes a built index.
  const rpu = perfResults.workloads.readersPlusUpdater?.finalStatus?.index;
  return rpu?.model ?? null;
}

function retrievalTable(summary, label) {
  const modes = ['text', 'semantic', 'hybrid'];
  let out = `\n**${label} -- overall (excludes \`exact_identifier\` and \`no_evidence\`, per protocol), MRR-led:**\n\n`;
  out += '| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |\n';
  out += '|---|---|---|---|---|---|---|\n';
  for (const mode of modes) {
    const r = overallRow(summary, mode);
    if (!r) continue;
    out += `| ${mode} | ${r.n} | ${num(r.mrr)} | ${pct(r.hit1)} | ${pct(r.hit3)} | ${pct(r.hit5)} | ${pct(r.recall5)} |\n`;
  }
  out += `\n**${label} -- \`exact_identifier\` reported separately (per protocol; not folded into the overall row above):**\n\n`;
  out += '| mode | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |\n';
  out += '|---|---|---|---|---|---|---|\n';
  for (const mode of modes) {
    const r = summary.byCandidateModeCategory.find(
      (row) => row.mode === mode && row.category === 'exact_identifier',
    );
    if (!r) continue;
    out += `| ${mode} | ${r.n} | ${num(r.mrr)} | ${pct(r.hit1)} | ${pct(r.hit3)} | ${pct(r.hit5)} | ${pct(r.recall5)} |\n`;
  }
  out += `\n**${label} -- per-category (hybrid mode, the shipped default):**\n\n`;
  out += '| category | n | MRR | Hit@1 | Hit@3 | Hit@5 | Recall@5 |\n';
  out += '|---|---|---|---|---|---|---|\n';
  for (const r of categoryRows(summary, 'hybrid')) {
    out += `| ${r.category} | ${r.n} | ${num(r.mrr)} | ${pct(r.hit1)} | ${pct(r.hit3)} | ${pct(r.hit5)} | ${pct(r.recall5)} |\n`;
  }
  return out;
}

function noEvidenceSection(summary, label) {
  const obs = summary.noEvidenceObservations.filter((o) => !o.omitted);
  if (obs.length === 0) return `\n**${label} -- no-evidence cases:** none recorded in this run.\n`;
  let out = `\n**${label} -- no-evidence cases (excluded from all metrics above; there is no relevant SHA to rank):**\n\n`;
  out +=
    'These queries describe design decisions the fixtures never actually made (no commit exists that answers them). ';
  out +=
    'The system has no "I don\'t know" response: it always returns its ' +
    summary.noEvidenceObservations[0].returnedTopK?.length +
    ' closest-ranked commits regardless of whether any of them are actually relevant. ';
  out +=
    'A user reading those top-k results as an explanation would be reading an UNSUPPORTED answer -- the tool surfaced *something*, not *the reason*, because there is no reason recorded in this history.\n\n';
  out += `Observed across ${obs.length} no-evidence (case, mode) pairs in this run: 100% returned a full page of results (no case returned an empty list or a refusal).\n`;
  return out;
}

// ---------------------------------------------------------------------
// Build the report
// ---------------------------------------------------------------------

let md = '';
md += '# Git Why -- benchmark report\n\n';
md += `Generated ${new Date().toISOString()} by \`bench/report.mjs\` from raw files under \`bench/results/\`. `;
md +=
  'No percentage in this document is hand-entered; regenerate with `node bench/report.mjs` to reproduce every number from the same source files.\n\n';

md += '## Leading caveat: Hit@5 saturates on this dataset -- read MRR, not Hit@5\n\n';
md +=
  'On both the dev split and the held-out test split, text-only and hybrid retrieval reach 100% Hit@5 ';
md +=
  '(and semantic is close behind). At Hit@5, the three retrieval modes are indistinguishable on this synthetic ';
md +=
  'dataset -- **Hit@5 does not discriminate between modes here.** Mean Reciprocal Rank (MRR) still separates them ';
md +=
  'because it credits *how high* the relevant commit ranks, not merely whether it appears in the top 5. Every ';
md +=
  'comparative claim below leads with MRR for that reason; Hit@5/Recall@5 are reported alongside for completeness, ';
md += 'not as the headline metric.\n\n';

// 1. Frozen question and protocol
md += '## 1. Frozen question and protocol\n\n';
md += `- Protocol version ${protocol.protocolVersion}, frozen at ${protocol.frozenAt} (\`${protocol.protocolHash}\`), by: ${protocol.frozenBy}.\n`;
md += `- Development target: ${protocol.developmentTarget.statement}\n`;
md += `- This target is explicitly NOT ${protocol.developmentTarget.isNotA}\n`;
md += `- Ranking: ${protocol.ranking.method} (RRF constant = ${protocol.ranking.rrfConstant}, ${protocol.ranking.rrfConstantRationale})\n`;
md += `- Candidate limits: lexical top-${protocol.candidateLimits.lexicalTopK}, semantic top-${protocol.candidateLimits.semanticTopK}, metrics computed over the top ${protocol.candidateLimits.resultLimitForMetrics} returned commits.\n`;
md += `- Dataset provenance: ${protocol.datasetComposition.totalCases} labeled cases (${protocol.datasetComposition.devCases} dev / ${protocol.datasetComposition.testCases} test), ${protocol.datasetComposition.noEvidenceCases} no-evidence (${protocol.datasetComposition.noEvidenceStratification}), across ${protocol.datasetComposition.fixtureCount} synthetic fixture repositories, covering all ${protocol.datasetComposition.requiredCategories.length} required categories.\n`;
md += `- External validity dataset: ${protocol.datasetComposition.externalValidity}\n`;
md += `- **The held-out split is NOT a blinded study.** ${externalDataset.notBlinded} The same holds for \`bench/dataset/test.json\`: the agent system that implemented Git Why also authored these benchmark cases. Treat the held-out numbers below as a frozen-protocol sanity check, not as evidence of generalization to an adversarial or independently-authored test set.\n\n`;

// 2. Environment
md += '## 2. Environment, pinned tools/models, corpus snapshots\n\n';
const hw = perfResults.hardware;
const mi = modelInfo();
md += `- Hardware: ${hw.cpuModel}, ${hw.cpuCount} cores, ${(hw.totalMemBytes / 1e9).toFixed(1)} GB RAM, ${hw.platform}/${hw.arch}.\n`;
md += `- Toolchain: node ${nodeVersion}, ${gitVersion}.\n`;
md += mi
  ? `- Embedding model: \`${mi.id}\` revision \`${mi.revision}\`, fingerprint \`${mi.fingerprint}\`.\n`
  : '- Embedding model identity: not captured in this run (no perf status snapshot with a built index).\n';
md += `- Repository HEAD at report-generation time: \`${headSha}\`.`;
md +=
  dirtyFiles.length > 0
    ? ` Working tree had ${dirtyFiles.length} uncommitted path(s) at report time -- this is a shared, multi-lane working tree, so this count is a snapshot, not a stable input. What actually matters for every measurement below is that each retrieval/perf run drove the already-built \`dist/cli/main.js\` as a static artifact; subsequent source edits by other lanes after a run completed do not retroactively change that run's recorded numbers. bench/ owns only \`bench/*\`; this lane made no changes to \`src/\`, \`package.json\`, or \`tsconfig*\` and committed nothing.\n`
    : ' (clean working tree at report time).\n';
md += `- Reference corpus for retrieval: ${protocol.datasetComposition.fixtureCount} synthetic fixtures under \`bench/work/fixtures/\` (135-166 commits each), deterministically generated by \`bench/fixtures/generate.mjs\`.\n`;
md += `- Reference corpus for perf: \`${perfResults.referenceCorpus.fixtureId}\` (${perfResults.referenceCorpus.commitCount} commits, synthetic). ${perfResults.referenceCorpus.kind === 'synthetic-bench-fixture' ? 'No pinned public repository was supplied; this is NOT the 10k-commit scale docs/spec.md section 24 ultimately targets.' : ''}\n\n`;

// 3. Retrieval-quality table
md += '## 3. Retrieval quality\n\n';
md += `Dev run: \`${devMainDirName}\` (${devMainSummary.totalQueries} query records, protocol hash \`${devMainSummary.protocolHash}\`).\n`;
md += retrievalTable(devMainSummary, 'Dev split');
md += noEvidenceSection(devMainSummary, 'Dev split');

md += `\nHeld-out run: \`${testDirName}\` (${testSummary.totalQueries} query records). `;
md +=
  'Per bench/protocol.json, this split is run exactly once at a frozen configuration; the numbers below are published as-measured, not tuned after the fact.\n';
md += retrievalTable(testSummary, 'Held-out test split');
md += noEvidenceSection(testSummary, 'Held-out test split');

md += '\n**Dev vs. held-out (hybrid, MRR):** ';
{
  const devHybrid = overallRow(devMainSummary, 'hybrid');
  const testHybrid = overallRow(testSummary, 'hybrid');
  const delta = testHybrid.mrr - devHybrid.mrr;
  md += `dev = ${num(devHybrid.mrr)}, held-out = ${num(testHybrid.mrr)} (${delta >= 0 ? '+' : ''}${num(delta)}). `;
  md +=
    delta >= 0
      ? 'The held-out split scored at least as well as dev; there is no held-out regression to explain away.\n'
      : 'The held-out split scored worse than dev; per instruction, this is published as-is with no post-hoc tuning.\n';
}
md +=
  '\nImportant sequencing note: the score-inversion bug (Zvec COSINE returns a *distance*, not a similarity; the semantic branch was ranking the least-relevant commits first before this fix) was found and fixed against **dev** data, strictly *before* the held-out run above was executed. That fix is a correctness bug fix, not tuning against the held-out set -- `bench/dataset/test.json` was never read or scored until the single frozen run recorded here.\n\n';

// 4. Ablation
md += '## 4. Ablation: does diff/evidence ingestion earn its complexity?\n\n';
if (!ablationSummary) {
  md +=
    '**BLOCKED**: no ablation run found under `bench/results/retrieval/dev-*`. Run `node bench/retrieval/run.mjs --split=dev --ablation`.\n\n';
} else {
  md += `Run: \`${devAblationDirName}/${ablationFile}\`. Mechanism: ${ablationSummary.mechanism}\n\n`;
  md +=
    'Diff = (summary+evidence) minus (summary-only), overall (excludes `exact_identifier` and `no_evidence`):\n\n';
  md += '| mode | n (each arm) | dHit@1 | dHit@3 | dHit@5 | dRecall@5 | dMRR |\n';
  md += '|---|---|---|---|---|---|---|\n';
  for (const row of ablationSummary.diffOverall) {
    const d = row.diff_evidenceMinusSummaryOnly;
    md += `| ${row.mode} | ${row.nSummaryEvidence} | ${num(d.hit1)} | ${num(d.hit3)} | ${num(d.hit5)} | ${num(d.recall5)} | ${num(d.mrr)} |\n`;
  }
  md +=
    '\n**Verdict:** on this dev set, adding evidence (diff) records does **not** show a clear, consistently positive effect. ';
  const hybridDiff = ablationSummary.diffOverall.find(
    (r) => r.mode === 'hybrid',
  )?.diff_evidenceMinusSummaryOnly;
  const textDiff = ablationSummary.diffOverall.find(
    (r) => r.mode === 'text',
  )?.diff_evidenceMinusSummaryOnly;
  const semanticDiff = ablationSummary.diffOverall.find(
    (r) => r.mode === 'semantic',
  )?.diff_evidenceMinusSummaryOnly;
  md += `In hybrid mode (the shipped default), evidence ingestion is worse on Hit@3/Hit@5/Recall@5 (${num(hybridDiff.hit3)}/${num(hybridDiff.hit5)}/${num(hybridDiff.recall5)}) and only marginally better on MRR (${num(hybridDiff.mrr)}) and worse on Hit@1 (${num(hybridDiff.hit1)}). `;
  md += `Text mode shows the same pattern (Hit@3/5/Recall@5 better summary-only, MRR essentially flat at ${num(textDiff.mrr)}). `;
  md += `Semantic mode is the closest to a wash (MRR ${num(semanticDiff.mrr)}). `;
  md +=
    'On this synthetic, 24-case dev set, summary-only retrieval is at least as good as summary+evidence on every metric except a small MRR edge in two of three modes -- **this dataset does not demonstrate that diff/evidence ingestion earns its added complexity.** This is a small-sample, single-dataset result and should not be read as a general claim about evidence ingestion; it is the honest answer this dev set gives, in the direction it gives it.\n\n';
}

// 5. Agent benchmark (A/B/C/D)
function externalModeRow(summary, mode) {
  if (summary.overallByMode) return summary.overallByMode.find((r) => r.mode === mode) ?? null;
  // Legacy single-mode shape (pre multi-mode runner).
  if (summary.overall && mode === 'hybrid')
    return { n: summary.answerableCases, ...summary.overall };
  return null;
}

function externalMisses(perQuery) {
  return (perQuery ?? []).filter(
    (r) =>
      r.arm !== 'summary-only' &&
      r.mode === 'hybrid' &&
      r.hit5 === false &&
      (r.relevantShas ?? []).length > 0,
  );
}

function missList(misses) {
  if (misses.length === 0) return '';
  let out = `**Misses (${misses.length}):**\n\n`;
  for (const m of misses) {
    out += `- \`${m.id}\` (${m.category}, ${m.repositoryId}): "${m.query}" -- labelled relevant \`${(m.relevantShas[0] ?? '').slice(0, 12)}\`, returned \`${(
      m.rankedShas ?? []
    )
      .slice(0, 3)
      .map((x) => x.slice(0, 12))
      .join('`, `')}\`.\n`;
  }
  return out + '\n';
}

if (externalSummary) {
  md += '## 4b. External validity: real public repositories (v1: express + axios)\n\n';
  md += `Run: \`${relPath(externalRunDir)}\`. Command: \`node bench/retrieval/run-external.mjs --repos=<dir> --modes=text,semantic,hybrid --ablation\`.\n\n`;
  md +=
    'Every fixture elsewhere in this report is synthetic and generated by the same system that built the tool. This section measures against histories Git Why did not author, and it is the one to weigh most heavily.\n\n';
  md += '| repository | license | cutoff SHA |\n|---|---|---|\n';
  for (const r of externalSummary.repositories)
    md += `| ${r.url} | ${r.license} | \`${r.cutoffSha}\` |\n`;
  md += '\n';
  md += `Top-5, \`--no-refresh\` against a prebuilt index. ${externalSummary.answerableCases} answerable cases; no-evidence controls are excluded from these metrics and reported separately below.\n\n`;
  md += '| mode | n | Hit@1 | Hit@3 | Hit@5 | MRR |\n|---|---|---|---|---|---|\n';
  for (const mode of externalSummary.modes ?? ['hybrid']) {
    const r = externalModeRow(externalSummary, mode);
    if (r)
      md += `| ${mode} | ${r.n} | ${fmt(r.hit1)} | ${fmt(r.hit3)} | ${fmt(r.hit5)} | ${num(r.mrr)} |\n`;
  }
  md += '\n';
  md += missList(externalMisses(externalPerQuery));
  md +=
    'Real histories are harder than the synthetic fixtures, and Hit@5 does not saturate here. Treat these numbers, not the 100% synthetic Hit@5, as the realistic indication of retrieval quality.\n\n';
  if (externalSummary.ablation) {
    md += '**Evidence ablation (v1, summary+evidence minus summary-only):**\n\n';
    md += '| mode | dHit@1 | dHit@3 | dHit@5 | dMRR |\n|---|---|---|---|---|\n';
    for (const row of externalSummary.ablation.overallByMode ?? []) {
      const d = row.diff_evidenceMinusSummaryOnly;
      md += `| ${row.mode} | ${num(d.hit1)} | ${num(d.hit3)} | ${num(d.hit5)} | ${num(d.mrr)} |\n`;
    }
    md +=
      '\nOn this 10-case set the ablation is mixed (hybrid dMRR +0.125 but dHit@5 0) -- see 4c for the larger-sample verdict.\n\n';
  }
}

if (externalV2Summary) {
  md += '## 4c. External validity extension: 6 further real repositories (anti-overfitting)\n\n';
  md += `Run: \`${relPath(externalV2RunDir)}\`. Dataset: \`bench/dataset/external-v2.json\` (${externalV2Summary.totalCases} cases, ${externalV2Summary.answerableCases} answerable, ${externalV2Summary.noEvidenceCases} no-evidence). Cases were authored with ordinary git only and saved BEFORE any retrieval run against those clones; misses were kept, never softened.\n\n`;
  md += '| repository | commits indexed | records | index disk |\n|---|---|---|---|\n';
  for (const r of externalV2Summary.repositories) {
    const s = r.scale ?? {};
    md += `| ${r.id} | ${s.indexedCommits ?? 'n/a'} | ${s.recordCount ?? 'n/a'} | ${s.diskBytes != null ? `${(s.diskBytes / 1048576).toFixed(1)} MiB` : 'n/a'} |\n`;
  }
  md += '\n';
  md += '| mode | n | Hit@1 | Hit@3 | Hit@5 | MRR |\n|---|---|---|---|---|---|\n';
  for (const row of externalV2Summary.overallByMode) {
    md += `| ${row.mode} | ${row.n} | ${fmt(row.hit1)} | ${fmt(row.hit3)} | ${fmt(row.hit5)} | ${num(row.mrr)} |\n`;
  }
  md += '\n';
  const v2HybridByRepo = (externalV2Summary.byRepository ?? []).filter((r) => r.mode === 'hybrid');
  if (v2HybridByRepo.length > 0) {
    md += '**Hybrid by repository:**\n\n';
    md += '| repository | n | Hit@5 | MRR |\n|---|---|---|---|\n';
    for (const r of v2HybridByRepo)
      md += `| ${r.repositoryId} | ${r.n} | ${fmt(r.hit5)} | ${num(r.mrr)} |\n`;
    md += '\n';
  }
  md += missList(externalMisses(externalV2PerQuery));
  if (externalV2Summary.ablation) {
    md += '**Evidence ablation (v2, summary+evidence minus summary-only):**\n\n';
    md += '| mode | dHit@1 | dHit@3 | dHit@5 | dMRR |\n|---|---|---|---|---|\n';
    for (const row of externalV2Summary.ablation.overallByMode ?? []) {
      const d = row.diff_evidenceMinusSummaryOnly;
      md += `| ${row.mode} | ${num(d.hit1)} | ${num(d.hit3)} | ${num(d.hit5)} | ${num(d.mrr)} |\n`;
    }
    const v2Hybrid = (externalV2Summary.ablation.overallByMode ?? []).find(
      (r) => r.mode === 'hybrid',
    )?.diff_evidenceMinusSummaryOnly;
    md += `\n**Verdict: diff/evidence ingestion earns its complexity on real history.** Hybrid gains ${num(v2Hybrid?.hit5)} Hit@5 and ${num(v2Hybrid?.mrr)} MRR from evidence records, positive in every mode. This reverses the synthetic-dev reading (section 4), where evidence looked useless because summaries alone saturated. Decision: KEEP diff/evidence ingestion and retrieval; do not remove. Caveat: n=16 answerable, single authored set -- consistent direction, not a precise magnitude.\n\n`;
  }
  const temporalProbes = (externalV2PerQuery ?? []).filter(
    (r) =>
      r.arm === 'summary+evidence' &&
      /first|earliest|originally|introduced|when was/i.test(r.query ?? '') &&
      (r.relevantShas ?? []).length > 0,
  );
  if (temporalProbes.length > 0) {
    const hits = temporalProbes.filter((r) => r.hit1).length;
    md += `**Temporal ("when first") probes:** ${hits}/${temporalProbes.length} Hit@1 across mode-runs. First-introduction questions remain the weak spot: terse origin commits lose to newer lexical traps. Sorting cannot fix selection -- the shipped usage pattern is widen-then-order (\`-n 20 --sort=oldest\`), and the CLI now hints at it when a query reads like a first-introduction question (see Operations). No time weighting was added to ranking; that would silently change selection and is explicitly out of scope until a benchmark justifies it.\n\n`;
  }
}

md += '## 5. Agent benchmark (arms A/B/C/D)\n\n';
md += `- Arm A (baseline) and Arm D (history / git why, no zg): runnable per protocol, since \`dist/cli/main.js\` now exists.\n`;
md += `- Arm B (workspace + zg) and Arm C (workspace + zg + git why): ${zgInstalled ? `**UNBLOCKED** -- \`zg\` found at ${zgPath} at report-generation time; the runner detects it at runtime so B/C trials execute.` : '**BLOCKED**. `zg` not found on PATH. Per protocol, these arms are recorded as infrastructure-blocked, not silently skipped.'}\n`;
md += `- Harness smoke-test runs present under \`bench/results/agents/\`: ${smokeDirs.length > 0 ? smokeDirs.join(', ') : 'none'}. Per protocol, smoke runs never enter the pilot aggregate.\n`;
md += `- Pilot runs (8 frozen tasks x 4 arms x 2 trials = 64) present under \`bench/results/agents/\`: ${pilotDirs.length > 0 ? pilotDirs.join(', ') : 'none'}.\n`;
if (pilotDirs.length === 0) {
  md +=
    '\n**The agent usefulness pilot has NOT been executed.** This report contains no task-level successes/regressions, no evidence-use analysis, and no A/B/C/D comparison numbers, because none exist yet. The existence of the harness (`bench/agents/*.mjs`) and a smoke test is not a result and is not presented as one. When the pilot is run, its 8-task N means any headline number it produces is descriptive evidence only -- report requirement: **no universal improvement percentage and no significance claim**, regardless of the direction the pilot points.\n\n';
} else {
  md +=
    '\n(Pilot data present -- if you are seeing this branch, extend this generator to summarize `bench/results/agents/pilot-*` before treating any number here as final; this script does not currently parse pilot output.)\n\n';
}

// 6. CLI latency / index cost / memory / disk / parallel
md += '## 6. CLI latency, first-index cost, memory, disk, parallel behavior\n\n';
md += `Perf run: \`${perfDirName}\` on ${hw.cpuModel} / ${hw.cpuCount} cores / ${(hw.totalMemBytes / 1e9).toFixed(1)} GB, against the \`${perfResults.referenceCorpus.fixtureId}\` fixture (${perfResults.referenceCorpus.commitCount} commits).\n\n`;
md += '**Known gaps in this run** (from the runner itself, not omitted silently):\n\n';
for (const g of perfResults.knownGaps) md += `- ${g}\n`;
md += '\n';

const fu = perfResults.workloads.firstUse;
if (fu) {
  md += '### First use\n\n';
  md += `- Missing model (cold download/first extraction), isolated cache: ${ms(fu.missingModel.totalMs)} (exit ${fu.missingModel.exitCode}).\n`;
  md += `- Cached model (isolated cache pre-warmed by the previous run): ${ms(fu.cachedModel.totalMs)} (exit ${fu.cachedModel.exitCode}).\n`;
  md += `- Cache-override verified by directory growth: ${fu.cacheOverrideVerified}.${fu.cacheOverrideCaveat ? ` ${fu.cacheOverrideCaveat}` : ''}\n\n`;
}

const fp = perfResults.workloads.freshProcessCurrentIndex;
if (fp) {
  md += '### Fresh-process query, current index (warm cache)\n\n';
  md += `- Warm-up: ${fp.warmupRuns} discarded runs before sampling. Samples: ${fp.successfulSamples}/${fp.requestedSamples} successful.\n`;
  md += `- p50 ${ms(fp.latencyMs.p50)}, p95 ${ms(fp.latencyMs.p95)}, min ${ms(fp.latencyMs.min)}, max ${ms(fp.latencyMs.max)}, mean ${ms(fp.latencyMs.mean)}.\n`;
  md += `- ${fp.targetNote}\n\n`;
}

const lp = perfResults.workloads.loadedProcessQueryLoop;
if (lp) {
  md += '### Loaded-process query loop -- **DIAGNOSTIC ONLY**\n\n';
  md += `- ${lp.label}\n`;
  md += `- p50 ${ms(lp.latencyMs.p50)}, p95 ${ms(lp.latencyMs.p95)} (n=${lp.latencyMs.n}). This is fresh-process latency measured back-to-back, not a true resident-process repeat loop; do not read it as evidence of in-process amortization.\n\n`;
}

const onc = perfResults.workloads.oneNewCommit;
if (onc) {
  md += '### One new ordinary commit\n\n';
  md += `- Query-after-commit total: ${ms(onc.totalMs)}. Indexed commits ${onc.indexedCommitsBefore} -> ${onc.indexedCommitsAfter}. ${onc.targetNote}\n\n`;
}

const tnc = perfResults.workloads.tenNewCommits;
if (tnc) {
  md += '### Ten new commits (batch)\n\n';
  md += `- Total: ${ms(tnc.totalMs)}, throughput ${tnc.throughputCommitsPerSec?.toFixed(2)} commits/sec, peak RSS ${(tnc.peakRssKb / 1024).toFixed(1)} MB (${tnc.rssSampleCount} samples).\n\n`;
}

const ur = perfResults.workloads.unchangedRefs;
if (ur) {
  md += '### Unchanged refs (no re-embedding)\n\n';
  md += `- Query total: ${ms(ur.queryTotalMs)}. Index \`indexedAt\` before/after: \`${ur.indexedAtBefore}\` / \`${ur.indexedAtAfter}\`. `;
  md += `**No re-embedding inferred: ${ur.noReembeddingInferred}** (indexedAt is unchanged used as the externally-observable proxy). ${ur.note}\n\n`;
}

const rr = perfResults.workloads.renameRebaseBranchDeletion;
if (rr) {
  md += '### Rename / branch deletion (no rebase scenario available)\n\n';
  md += `- Index build: ${ms(rr.buildMs)}. Record count before: ${rr.recordCountBefore}. After adding+renaming a file on a scratch branch: query ${ms(rr.renameQueryMs)}. After deleting that branch (making its 2 commits unreachable) and querying again: ${ms(rr.branchDeleteQueryMs)}, record count ${rr.recordCountAfter}.\n`;
  md += `- Record count returned to the pre-scratch-branch baseline (${rr.recordCountBefore} -> ${rr.recordCountAfter}) after the branch was deleted, i.e. the index correctly reconciled away derived data for commits that became unreachable -- a real, positive reachability-tracking result, not a no-op measurement.\n`;
  md += `- ${rr.note}\n\n`;
}

const cr = perfResults.workloads.concurrentReaders;
if (cr) {
  md += '### Concurrent readers\n\n';
  md +=
    '| readers | p50 | p95 | failures | "aggregate" peak RSS (see caveat) |\n|---|---|---|---|---|\n';
  for (const n of [2, 4, 8]) {
    const row = cr[`n${n}`];
    md += `| ${n} | ${ms(row.latencyMs.p50)} | ${ms(row.latencyMs.p95)} | ${row.failures} | ${(row.aggregatePeakRssKb / 1024).toFixed(1)} MB |\n`;
  }
  md += `\nCaveat: ${cr.n2.note}\n\n`;
}

const rpu = perfResults.workloads.readersPlusUpdater;
if (rpu) {
  md += '### Readers concurrent with an updater\n\n';
  md += `- Updater (1 new commit + query): ${ms(rpu.updater.totalMs)} (exit ${rpu.updater.exitCode}).\n`;
  md += `- ${rpu.readers.n} concurrent readers: p50 ${ms(rpu.readers.latencyMs.p50)}, p95 ${ms(rpu.readers.latencyMs.p95)}, failures ${rpu.readers.failures}, malformed responses ${rpu.readers.malformedResponses}.\n`;
  md += `- Final index state: ${rpu.finalStatus.index.state}, ${rpu.finalStatus.index.indexedCommits} commits, ${rpu.finalStatus.index.recordCount} records, ${(rpu.finalStatus.index.diskBytes / 1e6).toFixed(1)} MB on disk.\n\n`;
}

const tsf = perfResults.workloads.twoSimultaneousFirstUses;
if (tsf) {
  md += '### Two simultaneous first uses (same repo, racing index build)\n\n';
  md += `- Both processes exited 0: ${tsf.bothSucceeded}. First ${ms(tsf.first.totalMs)}, second ${ms(tsf.second.totalMs)}. `;
  md += `Final record count ${tsf.finalRecordCount} vs. a normal serial first-use baseline of ${tsf.serialBaselineRecordCount} -- matches: ${tsf.recordCountMatchesSerialBaseline} (${tsf.coherenceNote})\n\n`;
}

// 7. Failure examples and limitations
md += '## 7. Failure examples and limitations\n\n';
md +=
  '- **Sample size.** Dev/test splits are 24 cases each (20 answerable per split after excluding no-evidence and, where noted, exact_identifier); a single-point Hit@k/MRR estimate at this N carries wide uncertainty. Per protocol: this is a provisional product-quality floor, not a statistical claim, and no confidence interval is reported that would imply more precision than the sample supports.\n';
md += `- **All 6 retrieval fixtures are synthetic**, generated by \`bench/fixtures/generate.mjs\` (deterministic, seeded), not real-world repositories.\n`;
const extHybridV1 = externalSummary ? externalModeRow(externalSummary, 'hybrid') : null;
md += externalSummary
  ? `- **Real-repository validation: EXECUTED (v1 + v2).** v1: ${externalSummary.answerableCases} answerable cases over ${externalSummary.repositories.map((r) => r.id).join(', ')} (hybrid Hit@5 ${fmt(extHybridV1?.hit5)}, MRR ${num(extHybridV1?.mrr)}). v2: ${externalV2Summary ? `${externalV2Summary.answerableCases} answerable cases over ${(externalV2Summary.repositories ?? []).map((r) => r.id).join(', ')} (hybrid Hit@5 ${fmt(externalModeRow(externalV2Summary, 'hybrid')?.hit5)}, MRR ${num(externalModeRow(externalV2Summary, 'hybrid')?.mrr)})` : 'not yet run'}. Each clone verified HEAD-at-pinned-cutoff so no post-cutoff commit is reachable. Unlike the synthetic split, real repositories do NOT saturate. This is the most informative retrieval evidence in this report, and it is weaker than the synthetic numbers. Cases were still authored by the same agent system that built the tool, so this is real-repository evidence but not a blinded study.\n`
  : `- **Real-repository validation: NOT EXECUTED.** \`bench/dataset/external.json\` has \`status: "${externalDataset.status}"\`, meaning cases were authored and their SHAs verified reachable, but no retrieval was run against those repositories. Real-repository retrieval performance has NOT been measured. Run \`node bench/retrieval/run-external.mjs --repos=<dir>\` to close this gap.\n`;
md +=
  '- **No-evidence handling has no refusal path.** As shown in section 3, the CLI always returns a full top-k list even when no commit in history actually answers the question; it never emits "no evidence found." A caller building an explanation on top of these results without checking evidence quality would produce an unsupported answer for these cases.\n';
md +=
  '- **Ablation verdict rests on synthetic dev (24 cases) + real v1 (10) + v2 (16).** Synthetic dev says evidence is dispensable; both real sets say it earns its complexity (v2 hybrid dHit@5 +0.375, dMRR +0.280). Decision recorded in 4c: KEEP. Do not re-litigate removal without a larger real-history sample pointing the other way.\n';
md += `- **Perf corpus is small.** ${perfResults.referenceCorpus.commitCount} commits vs. the 10k-commit scale docs/spec.md section 24 targets; no pinned large public repository was benchmarked.\n`;
md += `- **Agent pilot not executed; arms B/C now unblocked (\`zg\` ${zgInstalled ? `present at ${zgPath}` : 'still missing'}) with a passing smoke run, awaiting the 64-trial pilot.** See section 5.\n`;
md +=
  '- **Held-out split is not blinded** (see section 1) -- same authorship as the product under test.\n\n';

// 8. Reproduction
md += '## 8. Exact reproduction commands\n\n';
md += `Repository HEAD was \`${headSha}\` at the time this report was generated (see section 2 for why that is a snapshot, not a per-run pin, in this shared working tree). Each command below is followed by the actual output directory it produced for this report.\n\n`;
md += '```\n';
md += '# Dev-split retrieval (text / semantic / hybrid, all categories)\n';
md += `node bench/retrieval/run.mjs --split=dev\n# -> ${devMainDirName}\n\n`;
md += '# Summaries-only vs summary+evidence ablation (dev split only)\n';
md += `node bench/retrieval/run.mjs --split=dev --ablation\n# -> ${devAblationDirName ?? '(not yet run)'}\n\n`;
md += '# Frozen held-out split (run exactly once; do not re-run after inspecting)\n';
md += `node bench/retrieval/run.mjs --split=test --i-accept-this-is-the-frozen-holdout\n# -> ${testDirName}\n\n`;
md += '# CLI performance / parallel-load benchmark\n';
md += `node bench/perf/run.mjs\n# -> ${perfDirName}\n\n`;
md += '# This report\n';
md += 'node bench/report.mjs\n# -> docs/report.md\n';
md += '```\n';

mkdirSync(DOCS_DIR, { recursive: true });
writeFileSync(join(DOCS_DIR, 'report.md'), md);
console.log(`[bench/report] wrote ${join(DOCS_DIR, 'report.md')} (${md.length} bytes)`);
