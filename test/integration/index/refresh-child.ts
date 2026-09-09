// Child process harness for refresh.test.ts: runs `ensureCurrentGeneration`
// (or `rebuild`) against a real on-disk generation, with a fake extractor
// and fake embedder, optionally injecting a mid-batch crash. Reads its
// job as JSON from argv[2].
import { ensureCurrentGeneration, rebuild } from '../../../src/index/refresh.js';
import { fakeRepository, fakeSnapshot, makeExtraction, makeFakeExtractor, makeFakeEmbedder, FAKE_EMBEDDER_DIMENSION } from './helpers.js';
import type { CommitExtraction } from '../../../src/types.js';

interface Job {
  readonly commonDir: string;
  readonly mode: 'ensure' | 'rebuild';
  readonly shas: readonly string[];
  readonly fingerprint: string;
  readonly complete: boolean;
  readonly crashOnSha?: string;
  readonly batchSize?: number;
}

async function main() {
  const job = JSON.parse(process.argv[2]!) as Job;
  const repository = fakeRepository(job.commonDir);
  const snapshot = fakeSnapshot(repository, job.shas, job.fingerprint, job.complete);

  const bySha = new Map<string, CommitExtraction>();
  for (const sha of job.shas) {
    bySha.set(sha, makeExtraction({ sha, subject: `Change ${sha.slice(0, 8)}`, paths: [`src/${sha.slice(0, 6)}.ts`] }));
  }
  const extractor = makeFakeExtractor(bySha, job.crashOnSha);
  const embedder = makeFakeEmbedder(FAKE_EMBEDDER_DIMENSION);

  const reachable = { shas: job.shas, complete: job.complete };
  const options = { batchSize: job.batchSize ?? 1 };

  const result =
    job.mode === 'rebuild'
      ? await rebuild(repository, snapshot, reachable, { extractor, embedder }, options)
      : await ensureCurrentGeneration(repository, snapshot, reachable, { extractor, embedder }, options);

  process.stdout.write(JSON.stringify({ event: 'done', generationId: result.generationId, counts: result.manifest.counts }) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ event: 'error', message: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code }) + '\n');
  process.exitCode = 1;
});
