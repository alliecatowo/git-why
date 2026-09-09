/**
 * Human rendering: a restrained Git command. SHA, subject, date, author,
 * message excerpt, path, diff. No logo, chat prompt, marketing animation,
 * or decorative AI language, and no confidence percentages.
 *
 * Every repository-sourced string is sanitized here before it reaches the
 * terminal (see `output/sanitize.ts`). `--json` output does not go through
 * this module.
 */

import type { CommitHit, IndexStatus } from '../types.js';
import { sanitizeForTerminal } from './sanitize.js';

const INDENT = '   ';

function s(value: string): string {
  return sanitizeForTerminal(value);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '' : indent + line))
    .join('\n');
}

function stripLeadingSubject(excerpt: string, subject: string): string {
  const trimmed = excerpt.trimStart();
  if (!trimmed.startsWith(subject)) return excerpt;
  return trimmed.slice(subject.length).replace(/^\r?\n\r?\n?/, '');
}

function renderResult(hit: CommitHit, index: number): string {
  const lines: string[] = [];
  lines.push(`${index}. ${shortSha(hit.sha)}  ${s(hit.subject)}`);
  lines.push(`${INDENT}${formatDate(hit.committerTime)} · ${s(hit.author.name)}`);

  // The excerpt is subject + body so that JSON consumers get a self-contained
  // message, but the subject is already on the first line here.
  const excerpt = stripLeadingSubject(hit.messageExcerpt, hit.subject).trim();
  if (excerpt.length > 0) {
    lines.push('');
    lines.push(indentBlock(s(excerpt), INDENT));
  }

  if (hit.evidence.length === 0) {
    lines.push('');
    lines.push(`${INDENT}(summary only; no evidence retained for this result)`);
  } else {
    for (const ev of hit.evidence) {
      lines.push('');
      const path = s(ev.path.display);
      const oldPath = ev.oldPath ? s(ev.oldPath.display) : null;
      lines.push(
        oldPath && oldPath !== path ? `${INDENT}${oldPath} -> ${path}` : `${INDENT}${path}`,
      );
      if (ev.excerpt.trim().length > 0) {
        lines.push(indentBlock(s(ev.excerpt), INDENT));
      }
      if (ev.truncated || ev.omissionReasons.length > 0) {
        const reasons = ev.omissionReasons.length > 0 ? ` (${ev.omissionReasons.join(', ')})` : '';
        lines.push(`${INDENT}[evidence truncated${reasons}]`);
      }
    }
  }

  return lines.join('\n');
}

export function renderSearchHuman(response: {
  readonly query: string;
  readonly results: readonly CommitHit[];
  readonly warnings: readonly string[];
}): string {
  const lines: string[] = [];

  if (response.results.length === 0) {
    lines.push(`No match found in the indexed history for "${s(response.query)}".`);
    lines.push(
      'This does not prove the repository has no explanation, only that none was found in the available indexed material.',
    );
  } else {
    response.results.forEach((hit, i) => {
      if (i > 0) lines.push('');
      lines.push(renderResult(hit, i + 1));
    });
  }

  if (response.warnings.length > 0) {
    lines.push('');
    for (const w of response.warnings) lines.push(`warning: ${s(w)}`);
  }

  return lines.join('\n') + '\n';
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function field(label: string, value: string): string {
  return `${label.padEnd(18)}${value}`;
}

export function renderStatusHuman(status: IndexStatus): string {
  const lines: string[] = [];
  lines.push(field('state:', status.state));
  lines.push(field('index:', status.indexPath));
  lines.push(field('generation:', status.generation ?? 'none'));
  lines.push(
    field(
      'indexed commits:',
      status.indexedCommits === null ? 'unknown' : String(status.indexedCommits),
    ),
  );
  lines.push(
    field(
      'reachable commits:',
      status.reachableCommits === null ? 'unknown' : String(status.reachableCommits),
    ),
  );
  lines.push(field('refs changed:', status.refsChanged ? 'yes' : 'no'));
  lines.push(
    field('records:', status.recordCount === null ? 'unknown' : String(status.recordCount)),
  );
  lines.push(
    field(
      'model:',
      status.model
        ? `${s(status.model.id)} @ ${s(status.model.revision)} (${status.model.fingerprint})`
        : 'none',
    ),
  );
  lines.push(field('disk:', formatBytes(status.diskBytes)));
  lines.push(field('indexed at:', status.indexedAt ?? 'never'));
  lines.push(field('object format:', status.objectFormat));
  lines.push(field('shallow:', status.shallow ? 'yes' : 'no'));
  const cov = status.coverage;
  lines.push(
    field(
      'coverage:',
      `${cov.excludedFiles} excluded, ${cov.unavailableFiles} unavailable, ${cov.failedFiles} failed` +
        (cov.reasons.length > 0 ? ` (${cov.reasons.join(', ')})` : ''),
    ),
  );
  if (status.warnings.length > 0) {
    lines.push('');
    for (const w of status.warnings) lines.push(`warning: ${s(w)}`);
  }
  return lines.join('\n') + '\n';
}
