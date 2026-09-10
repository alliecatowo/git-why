// Grades one trial's outcome. Two paths, matching docs/spec.md section 19:
//
//   - Coding tasks (T1-T4, T6, T7): hidden behavioral tests, run against a
//     SCRATCH COPY of the trial's resulting workspace (never the original,
//     so grading can never itself perturb a workspace another step might
//     still read). This is the PRIMARY objective metric.
//   - Rubric tasks (T5, T8): grade.mjs does NOT judge quality itself and
//     never uses the trial model to grade its own answer. It performs only
//     two mechanical, objective checks (keyword presence, SHA-in-allowed-
//     ancestry) and then emits a BLINDED review packet -- arm/model/task
//     identity stripped, a stable id assigned -- for a human to grade
//     against the rubric out-of-band. The human grade is merged back in
//     later via mergeManualGrade().

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Runs a task's hidden test file against a scratch copy of the trial workspace. */
export function gradeCodingTask({ trialWorkspaceDir, hiddenTestPath, scratchRoot, trialLabel }) {
  if (!hiddenTestPath || !existsSync(hiddenTestPath)) {
    return { kind: 'coding', applicable: false, reason: 'no hidden test file for this task' };
  }
  const scratchDir = join(scratchRoot, `${trialLabel}-grading`);
  rmSync(scratchDir, { recursive: true, force: true });
  cpSync(trialWorkspaceDir, scratchDir, { recursive: true });
  const testDir = join(scratchDir, '__hidden_tests__');
  mkdirSync(testDir, { recursive: true });
  const testFilePath = join(testDir, 'task.test.cjs');
  cpSync(hiddenTestPath, testFilePath);

  const res = spawnSync('node', ['--test', testFilePath], {
    cwd: scratchDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const passMatch = /^ℹ pass (\d+)$/m.exec(res.stdout);
  const failMatch = /^ℹ fail (\d+)$/m.exec(res.stdout);
  const totalMatch = /^ℹ tests (\d+)$/m.exec(res.stdout);
  const passed = passMatch ? Number(passMatch[1]) : null;
  const failed = failMatch ? Number(failMatch[1]) : null;
  const total = totalMatch ? Number(totalMatch[1]) : null;

  rmSync(scratchDir, { recursive: true, force: true });

  return {
    kind: 'coding',
    applicable: true,
    exitCode: res.status,
    hiddenTestsPassed: passed,
    hiddenTestsTotal: total,
    hiddenTestsFailed: failed,
    pass: res.status === 0 && total !== null && total > 0,
    rawStdout: res.stdout,
    rawStderr: res.stderr,
  };
}

function stableId(taskId, arm, repetition, salt) {
  return createHash('sha256')
    .update(`${taskId}::${arm}::${repetition}::${salt}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Mechanical pre-checks only -- never the final grade. Checks (a) the
 * answer mentions at least one of the rubric's expected keywords/phrases,
 * and (b) every SHA-shaped token (7-40 hex chars) the answer cites actually
 * exists as a reachable object in the trial workspace, which (because the
 * workspace was built by bench/agents/isolation.mjs from baseSha's ancestry
 * only) is equivalent to "exists in the allowed ancestry".
 */
export function mechanicalRubricChecks({ trialWorkspaceDir, finalAnswer, rubric }) {
  const shaTokens = [...new Set(finalAnswer.match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
  const shaChecks = shaTokens.map((sha) => {
    const exists =
      spawnSync('git', ['cat-file', '-e', sha], { cwd: trialWorkspaceDir }).status === 0;
    return { sha, existsInAllowedAncestry: exists };
  });
  const anyInventedSha = shaChecks.some((c) => !c.existsInAllowedAncestry);

  const keywordPool = rubric.mustMentionAny ?? [];
  const mentionedKeywords = keywordPool.filter((kw) =>
    finalAnswer.toLowerCase().includes(kw.toLowerCase()),
  );

  return {
    citedShas: shaChecks,
    anyInventedShaCited: anyInventedSha,
    keywordPool,
    mentionedKeywords,
    anyExpectedKeywordMentioned: keywordPool.length === 0 ? null : mentionedKeywords.length > 0,
  };
}

/**
 * Builds and writes a blinded review packet for a rubric task. The packet
 * deliberately omits arm, model, and provider identity -- a human reviewer
 * grades the ANSWER against the rubric without knowing which arm produced
 * it. The mapping from stableId back to (task, arm, repetition) is kept in
 * a SEPARATE, non-blinded index file the reviewer does not need to see.
 */
export function writeBlindedReviewPacket({
  reviewDir,
  taskId,
  arm,
  repetition,
  salt,
  finalAnswer,
  rubric,
  mechanicalChecks,
  promptText,
}) {
  mkdirSync(reviewDir, { recursive: true });
  const id = stableId(taskId, arm, repetition, salt);
  const packet = {
    id,
    // Deliberately blinded: no taskId/arm/repetition/model here.
    prompt: promptText,
    answer: finalAnswer,
    rubric,
    mechanicalChecks,
    humanGrade: null, // 'pass' | 'partial' | 'fail', filled in later
    humanJustification: null,
  };
  writeFileSync(join(reviewDir, `${id}.json`), JSON.stringify(packet, null, 2) + '\n', 'utf8');

  // Non-blinded index: reviewer never opens this file.
  const indexPath = join(reviewDir, '_index-DO-NOT-SHOW-REVIEWER.json');
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : {};
  index[id] = { taskId, arm, repetition };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

  return { id, packetPath: join(reviewDir, `${id}.json`) };
}

/** Merges a human-filled grade back onto a packet (called out-of-band, after review). */
export function mergeManualGrade(reviewDir, id, { humanGrade, humanJustification }) {
  const path = join(reviewDir, `${id}.json`);
  const packet = JSON.parse(readFileSync(path, 'utf8'));
  packet.humanGrade = humanGrade;
  packet.humanJustification = humanJustification;
  writeFileSync(path, JSON.stringify(packet, null, 2) + '\n', 'utf8');
  return packet;
}

/**
 * Did the agent actually surface the commit that explains the fix?
 *
 * The hidden tests only ask "is the symptom gone", and on a revert-and-reapply
 * task every arm clears that bar -- an agent with no history tooling patches
 * the symptom as readily as one that read the rationale. Measured on the
 * partial pilot: 100% pass in all four arms, zero discriminative power. The
 * question the benchmark exists to answer is not whether the agent can fix the
 * code, it is whether history retrieval helped it recover WHY the code was
 * that way, and that is what citing the originating commit demonstrates.
 *
 * Matching accepts any abbreviation of at least 7 characters, since agents
 * quote short SHAs, and looks in the patch as well as the prose because a
 * citation in a code comment counts.
 */
export function gradeEvidenceCitation({ goldSha, finalAnswer, finalPatch }) {
  if (typeof goldSha !== 'string' || goldSha.length < 7) return null;
  const haystack = `${finalAnswer ?? ''}\n${finalPatch ?? ''}`;
  const cited = [...new Set(haystack.match(/\b[0-9a-f]{7,40}\b/g) ?? [])];
  const matched = cited.filter(
    (sha) => goldSha.startsWith(sha.toLowerCase()) || sha.toLowerCase().startsWith(goldSha),
  );
  return {
    goldSha,
    citedGoldSha: matched.length > 0,
    citedShaCount: cited.length,
    matchedTokens: matched,
  };
}

/**
 * Top-level entry: grades one trial given its task spec metadata and the
 * runner's trial result. Returns the fields grade.mjs is responsible for
 * within the section-23 record: pass, hidden-test counts, evidence grade.
 */
export function gradeTrial({
  taskMeta,
  trialResult,
  trialWorkspaceDir,
  hiddenTestPath,
  rubric,
  scratchRoot,
  reviewDir,
  promptText,
}) {
  if (rubric) {
    const mechanicalChecks = mechanicalRubricChecks({
      trialWorkspaceDir,
      finalAnswer: trialResult.finalAnswer ?? '',
      rubric,
    });
    const { id } = writeBlindedReviewPacket({
      reviewDir,
      taskId: taskMeta.taskId,
      arm: trialResult.arm,
      repetition: trialResult.repetition,
      salt: trialResult.sessionId ?? String(Date.now()),
      finalAnswer: trialResult.finalAnswer ?? '',
      rubric,
      mechanicalChecks,
      promptText,
    });
    return {
      pass: null, // pending human review
      hiddenTestsPassed: null,
      hiddenTestsTotal: null,
      evidenceGrade: 'pending_blinded_review',
      reviewPacketId: id,
      mechanicalChecks,
    };
  }

  const coding = gradeCodingTask({
    trialWorkspaceDir,
    hiddenTestPath,
    scratchRoot,
    trialLabel: `${taskMeta.taskId}-${trialResult.arm}-${trialResult.repetition}`,
  });
  // The citation check is the discriminating measure on coding tasks; the
  // hidden tests saturate. It is reported ALONGSIDE pass rather than folded
  // into it, so "fixed the bug" and "recovered the reason" stay separable --
  // an agent can legitimately do the first without the second.
  const citation = gradeEvidenceCitation({
    goldSha: taskMeta.goldSha,
    finalAnswer: trialResult.finalAnswer ?? '',
    finalPatch: trialResult.finalPatch ?? '',
  });
  return {
    pass: coding.applicable ? coding.pass : null,
    hiddenTestsPassed: coding.hiddenTestsPassed,
    hiddenTestsTotal: coding.hiddenTestsTotal,
    evidenceGrade: citation,
    reviewPacketId: null,
    coding,
  };
}
