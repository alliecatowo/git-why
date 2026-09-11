#!/usr/bin/env node
/**
 * Scores an embedding model on the fixed pool, in isolation.
 *
 * This is pure vector retrieval: no full-text branch, no RRF, no reranking.
 * That is deliberate. The product's number mixes several mechanisms, and the
 * question here is only what the EMBEDDING can do, because the diagnostic says
 * 42% of gold commits are never retrieved at all and that is the embedding's
 * job.
 *
 * Two kinds of model:
 *
 *   static       Model2Vec (potion). Token lookup, mean pool, optional L2.
 *                Run through the product's own StaticEmbedder, so a static
 *                result here is what the product would actually do.
 *   transformer  A real forward pass (BGE, Jina), via transformers.js.
 *                NOT a product dependency — it lives in a scratch directory
 *                and exists to answer "would the dependency be worth it"
 *                before anyone takes it on.
 *
 * Embeddings are cached per model, so adding a model later does not re-run the
 * ones already measured.
 *
 *   node bench/embedders/score.mjs --model potion-code-16M-v2
 *   node bench/embedders/score.mjs --model bge-small-en-v1.5
 *   node bench/embedders/score.mjs --report
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_DIR = join(ROOT, 'bench', 'results', 'embedders');
const POOL = join(OUT_DIR, 'pool.json');
/** transformers.js lives here on purpose: it is a lab tool, not a dependency. */
const LAB_MODULES = '/tmp/node_modules';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

/**
 * Every model under test. `kind` decides how it is loaded, not how it is
 * scored — scoring is identical, which is what makes the comparison fair.
 */
export const MODELS = [
  // The shipped default and its family. "Config" differences within Model2Vec
  // are the model itself: dimension, vocabulary and training objective are
  // baked into the weights.
  {
    name: 'potion-code-16M-v2',
    kind: 'static',
    hf: 'minishlab/potion-code-16M-v2',
    note: 'shipped default, code-tuned, 256d',
  },
  {
    name: 'potion-retrieval-32M',
    kind: 'static',
    hf: 'minishlab/potion-retrieval-32M',
    note: 'retrieval-tuned prose, 512d',
  },
  {
    name: 'potion-base-8M',
    kind: 'static',
    hf: 'minishlab/potion-base-8M',
    note: 'smaller general-purpose, 256d',
  },
  {
    name: 'potion-base-32M',
    kind: 'static',
    hf: 'minishlab/potion-base-32M',
    note: 'larger general-purpose, 512d',
  },
  // Transformers: a real forward pass, orders of magnitude more compute.
  {
    name: 'bge-small-en-v1.5',
    kind: 'transformer',
    hf: 'Xenova/bge-small-en-v1.5',
    note: '33M params, 384d',
  },
  {
    name: 'bge-base-en-v1.5',
    kind: 'transformer',
    hf: 'Xenova/bge-base-en-v1.5',
    note: '109M params, 768d',
  },
  {
    name: 'jina-embeddings-v2-small-en',
    kind: 'transformer',
    hf: 'Xenova/jina-embeddings-v2-small-en',
    note: '33M params, 512d, long context',
  },
  {
    name: 'all-MiniLM-L6-v2',
    kind: 'transformer',
    hf: 'Xenova/all-MiniLM-L6-v2',
    note: '22M params, 384d, the common baseline',
  },
  {
    name: 'jina-v2-base-en',
    kind: 'transformer',
    hf: 'Xenova/jina-embeddings-v2-base-en',
    note: '137M params, 768d — does the larger Jina keep gaining?',
  },
  {
    // Quantisation is the config question that decides shippability: a model
    // that wins on quality but makes indexing unbearable may not be worth it,
    // and int8 is where that trade is usually made.
    name: 'jina-v2-small-q8',
    kind: 'transformer',
    hf: 'Xenova/jina-embeddings-v2-small-en',
    dtype: 'q8',
    note: 'the leader, int8 quantised',
  },
];

const cosine = (a, b) => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
};

function l2(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

async function loadStatic(spec) {
  const { StaticEmbedder, parseStaticModelConfig } = await import(
    join(ROOT, 'dist', 'embedding', 'static-embedder.js')
  );
  const base = `https://huggingface.co/${spec.hf}/resolve/main`;
  const get = async (file) => {
    const res = await fetch(`${base}/${file}`);
    if (!res.ok) throw new Error(`${spec.hf}/${file}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [configBuf, tokenizerBuf, weightsBuf] = await Promise.all([
    get('config.json'),
    get('tokenizer.json'),
    get('model.safetensors'),
  ]);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const embedder = new StaticEmbedder({
    modelId: spec.hf,
    revision: 'lab',
    config: parseStaticModelConfig(JSON.parse(configBuf.toString('utf8'))),
    tokenizerJson: JSON.parse(tokenizerBuf.toString('utf8')),
    weightsBuffer: weightsBuf,
    tokenizerSha256: sha(tokenizerBuf),
    weightsSha256: sha(weightsBuf),
  });
  return {
    dimension: embedder.dimension,
    embed: async (texts) => embedder.embedDocuments(texts),
  };
}

async function loadTransformer(spec) {
  const { pipeline, env } = await import(
    join(LAB_MODULES, '@huggingface/transformers/dist/transformers.node.mjs')
  );
  env.allowLocalModels = false;
  const extractor = await pipeline('feature-extraction', spec.hf, { dtype: spec.dtype ?? 'fp32' });
  return {
    dimension: null,
    embed: async (texts) => {
      // Mean pooling + L2, the configuration these models are trained for and
      // the same shape the static path produces, so the comparison is of the
      // representation rather than of two different pooling choices.
      const output = await extractor(texts, { pooling: 'mean', normalize: true });
      const dims = output.dims;
      const data = output.data;
      const width = dims[dims.length - 1];
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        out.push(Float32Array.from(data.slice(i * width, (i + 1) * width)));
      }
      return out;
    },
  };
}

function scorePool(pool, vectorsBySha, questionVectors) {
  let hit1 = 0;
  let hit5 = 0;
  let hit10 = 0;
  let rr = 0;
  let recall50 = 0;
  let n = 0;
  for (const repo of pool) {
    const docs = repo.docs.filter((d) => vectorsBySha.has(d.sha));
    for (const q of repo.questions) {
      const qv = questionVectors.get(q.id);
      if (qv === undefined || !vectorsBySha.has(q.gold)) continue;
      const scored = docs.map((d) => ({ sha: d.sha, s: cosine(qv, vectorsBySha.get(d.sha)) }));
      scored.sort((a, b) => b.s - a.s);
      const idx = scored.findIndex((d) => d.sha === q.gold);
      n += 1;
      if (idx === 0) hit1 += 1;
      if (idx >= 0 && idx < 5) hit5 += 1;
      if (idx >= 0 && idx < 10) hit10 += 1;
      if (idx >= 0 && idx < 50) recall50 += 1;
      if (idx >= 0) rr += 1 / (idx + 1);
    }
  }
  return {
    n,
    hit1: hit1 / n,
    hit5: hit5 / n,
    hit10: hit10 / n,
    recall50: recall50 / n,
    mrr: rr / n,
  };
}

if (process.argv.includes('--report')) {
  const rows = [];
  for (const spec of MODELS) {
    const f = join(OUT_DIR, `score-${spec.name}.json`);
    if (existsSync(f)) rows.push(JSON.parse(readFileSync(f, 'utf8')));
  }
  if (rows.length === 0) {
    console.error('no scores yet; run --model <name> first');
    process.exit(1);
  }
  rows.sort((a, b) => b.mrr - a.mrr);
  console.log(
    `\nPure vector retrieval over a fixed ${rows[0].documents}-document pool, ${rows[0].n} questions.`,
  );
  console.log('No full-text branch, no RRF, no reranking: this is the embedding alone.\n');
  console.log(
    `${'model'.padEnd(30)}${'kind'.padEnd(13)}${'Hit@1'.padEnd(8)}${'Hit@5'.padEnd(8)}${'Hit@10'.padEnd(8)}${'R@50'.padEnd(8)}${'MRR'.padEnd(8)}sec`,
  );
  for (const r of rows) {
    console.log(
      `${r.model.padEnd(30)}${r.kind.padEnd(13)}${r.hit1.toFixed(3).padEnd(8)}${r.hit5.toFixed(3).padEnd(8)}${r.hit10.toFixed(3).padEnd(8)}${r.recall50.toFixed(3).padEnd(8)}${r.mrr.toFixed(3).padEnd(8)}${Math.round(r.elapsedMs / 1000)}`,
    );
  }
  const best = rows[0];
  const shipped = rows.find((r) => r.model === 'potion-code-16M-v2');
  if (shipped && best.model !== shipped.model) {
    console.log(
      `\n${best.model} leads the shipped default by ${(best.mrr - shipped.mrr).toFixed(3)} MRR ` +
        `(${(((best.mrr - shipped.mrr) / shipped.mrr) * 100).toFixed(0)}% relative).`,
    );
  }
  console.log(
    '\nAbsolute scores are EASIER than the product on full history: the pool is smaller.',
  );
  console.log('Only the comparison between rows is meaningful.\n');

  // Write the table into docs/embedding.md rather than leaving it to be
  // transcribed. Every other measured table in this project is generated, for
  // the reason this one would need it too: a hand-copied number is true once.
  const doc = join(ROOT, 'docs', 'embedding.md');
  if (existsSync(doc)) {
    const perDoc = (r) => {
      const ms = r.elapsedMs / r.documents;
      return ms < 1 ? `${ms.toFixed(2)} ms` : `${Math.round(ms)} ms`;
    };
    const label = (r) => (r.model === 'potion-code-16M-v2' ? `**${r.model}** (shipped)` : r.model);
    const emph = (v, on) => (on ? `**${v}**` : v);
    const bestMrr = Math.max(...rows.map((r) => r.mrr));
    const bestRecall = Math.max(...rows.map((r) => r.recall50));
    const fastest = Math.min(...rows.map((r) => r.elapsedMs / r.documents));
    let table = '| model | kind | Hit@1 | Hit@5 | R@50 | MRR | per doc |\n';
    table += '| --- | --- | ---: | ---: | ---: | ---: | ---: |\n';
    for (const r of rows) {
      const isFastest = Math.abs(r.elapsedMs / r.documents - fastest) < 1e-9;
      table +=
        `| ${label(r)} | ${r.kind} | ${r.hit1.toFixed(3)} | ${r.hit5.toFixed(3)} | ` +
        `${emph(r.recall50.toFixed(3), r.recall50 === bestRecall)} | ` +
        `${emph(r.mrr.toFixed(3), r.mrr === bestMrr)} | ${emph(perDoc(r), isFastest)} |\n`;
    }
    const open = '<!-- generated:embedder-table -->';
    const close = '<!-- /generated:embedder-table -->';
    const text = readFileSync(doc, 'utf8');
    const a = text.indexOf(open);
    const b = text.indexOf(close);
    if (a >= 0 && b >= 0) {
      const next = await format(`${text.slice(0, a + open.length)}\n\n${table}\n${text.slice(b)}`, {
        parser: 'markdown',
        ...(await resolveConfig(doc)),
      });
      writeFileSync(doc, next);
      console.log(`wrote the table into ${doc}`);
    }
  }

  process.exit(0);
}

const name = arg('model', null);
const spec = MODELS.find((m) => m.name === name);
if (spec === undefined) {
  console.error(`unknown model "${name}". Known: ${MODELS.map((m) => m.name).join(', ')}`);
  process.exit(1);
}

const poolFile = JSON.parse(readFileSync(POOL, 'utf8'));
const pool = poolFile.pool;
const started = Date.now();
const model = spec.kind === 'static' ? await loadStatic(spec) : await loadTransformer(spec);

const vectorsBySha = new Map();
const questionVectors = new Map();
const BATCH = spec.kind === 'static' ? 512 : 32;

let done = 0;
for (const repo of pool) {
  for (let i = 0; i < repo.docs.length; i += BATCH) {
    const slice = repo.docs.slice(i, i + BATCH);
    // Commit messages are long; the cap keeps a transformer inside its context
    // and matches the truncation the product applies.
    const vecs = await model.embed(slice.map((d) => d.text.slice(0, 2000)));
    slice.forEach((d, k) => vectorsBySha.set(d.sha, l2(vecs[k])));
    done += slice.length;
    if (done % 2000 < BATCH) process.stderr.write(`  ${done} docs\n`);
  }
  const qs = repo.questions;
  for (let i = 0; i < qs.length; i += BATCH) {
    const slice = qs.slice(i, i + BATCH);
    const vecs = await model.embed(slice.map((q) => q.question));
    slice.forEach((q, k) => questionVectors.set(q.id, l2(vecs[k])));
  }
}

const result = {
  model: spec.name,
  kind: spec.kind,
  hf: spec.hf,
  note: spec.note,
  documents: vectorsBySha.size,
  elapsedMs: Date.now() - started,
  ...scorePool(pool, vectorsBySha, questionVectors),
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, `score-${spec.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `${spec.name}: Hit@1 ${result.hit1.toFixed(3)}  Hit@5 ${result.hit5.toFixed(3)}  MRR ${result.mrr.toFixed(3)}  (${Math.round(result.elapsedMs / 1000)}s)`,
);
