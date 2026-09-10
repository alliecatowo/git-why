<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

type Metric = number | null | undefined;
type Trial = {
  id?: string;
  taskId?: string;
  task_id?: string;
  arm?: string;
  repetition?: number;
  status?: string;
  pass?: boolean | null;
  invalidation_reason?: string | null;
  wallMs?: Metric;
  wall_ms?: Metric;
  totalTokens?: Metric;
  total_tokens?: Metric;
  gitWhyCalls?: Metric;
  git_why_calls?: Metric;
  evidenceUsed?: boolean | null;
  evidence_used?: boolean | null;
  transcript?: string;
  finalAnswer?: string;
  final_answer?: string;
  stderr?: string;
};
type ArmAggregate = {
  arm: string;
  planned?: number;
  attempted?: number;
  valid?: number;
  invalidated?: number;
  successful?: number;
  passRate?: Metric;
  pass_rate?: Metric;
  medianWallMs?: Metric;
  median_wall_ms?: Metric;
  medianTokens?: Metric;
  median_tokens?: Metric;
  toolAdoption?: Metric;
  tool_adoption?: Metric;
  evidenceUsed?: Metric;
  evidence_used?: Metric;
};
type Status = {
  updatedAt: string;
  retrieval?: {
    state?: string;
    runId?: string;
    totalQueries?: number;
    hybrid?: { hit5?: number; mrr?: number };
  };
  agent?: {
    state?: string;
    stage?: string;
    runId?: string;
    planned?: number;
    completed?: number;
    note?: string;
    resumeCommand?: string;
    controls?: { available?: boolean; reason?: string };
    aggregates?: ArmAggregate[];
    trials?: Trial[];
    invalidations?: Array<{ id?: string; reason?: string }>;
  };
};

const status = ref<Status | null>(null);
const error = ref<string | null>(null);
const controlMessage = ref<string | null>(null);
const controlling = ref(false);
const devControls = ref(false);
const selectedTrial = ref<Trial | null>(null);
const query = ref('');
const armFilter = ref('all');
let timer: ReturnType<typeof setInterval> | undefined;

const num = (v: Metric, fallback = '—') =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : fallback;
const percent = (v: Metric) =>
  typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
const duration = (v: Metric) =>
  typeof v !== 'number' || !Number.isFinite(v)
    ? '—'
    : v >= 60_000
      ? `${(v / 60_000).toFixed(1)}m`
      : `${(v / 1000).toFixed(1)}s`;
const trialId = (t: Trial) => t.id ?? `${t.taskId ?? t.task_id ?? 'trial'}-${t.arm ?? '?'}`;
const trialTask = (t: Trial) => t.taskId ?? t.task_id ?? '—';
const trialWall = (t: Trial) => t.wallMs ?? t.wall_ms;
const trialTokens = (t: Trial) => t.totalTokens ?? t.total_tokens;
const trialCalls = (t: Trial) => t.gitWhyCalls ?? t.git_why_calls;
const aggregates = computed(() => status.value?.agent?.aggregates ?? []);
const trials = computed(() => status.value?.agent?.trials ?? []);
const controlsAvailable = computed(
  () => devControls.value || status.value?.agent?.controls?.available === true,
);
const completion = computed(() => {
  const a = status.value?.agent;
  return a?.planned ? Math.min(100, ((a.completed ?? 0) / a.planned) * 100) : 0;
});
const visibleTrials = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return trials.value.filter(
    (t) =>
      (armFilter.value === 'all' || t.arm === armFilter.value) &&
      (!needle ||
        `${trialId(t)} ${trialTask(t)} ${t.status ?? ''} ${t.invalidation_reason ?? ''}`
          .toLowerCase()
          .includes(needle)),
  );
});
const selectedText = computed(() => {
  const t = selectedTrial.value;
  return (
    t?.transcript ??
    t?.finalAnswer ??
    t?.final_answer ??
    t?.stderr ??
    'No redacted transcript was published for this trial.'
  );
});
async function refresh() {
  try {
    const response = await fetch(withBase('/bench-status.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
    status.value = (await response.json()) as Status;
    error.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function control(action: 'start' | 'stop' | 'resume') {
  controlling.value = true;
  controlMessage.value = null;
  try {
    const response = await fetch(withBase('/__bench/control'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const body = (await response.json()) as { message?: string };
    if (!response.ok)
      throw new Error(body.message ?? `control endpoint returned ${response.status}`);
    controlMessage.value = body.message ?? `${action} requested`;
    await refresh();
  } catch (cause) {
    controlMessage.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    controlling.value = false;
  }
}
async function discoverControls() {
  try {
    const response = await fetch(withBase('/__bench/control'), { cache: 'no-store' });
    if (response.ok)
      devControls.value = Boolean(((await response.json()) as { available?: boolean }).available);
  } catch {
    /* static deployment: intentionally read-only */
  }
}
onMounted(() => {
  void refresh();
  void discoverControls();
  timer = setInterval(() => void refresh(), 5_000);
});
onBeforeUnmount(() => timer && clearInterval(timer));
</script>

<template>
  <section class="bench-dashboard" aria-live="polite">
    <div v-if="error" class="bench-error">Could not load run status: {{ error }}</div>
    <template v-else-if="status">
      <header class="bench-head">
        <div>
          <p class="bench-kicker">Benchmark control room</p>
          <h2>{{ status.agent?.stage ?? 'No agent run published' }}</h2>
          <p class="bench-subtitle">
            {{ status.agent?.note ?? 'Waiting for a benchmark runner to publish status.' }}
          </p>
        </div>
        <div class="bench-actions">
          <button type="button" @click="refresh">Refresh</button
          ><button
            type="button"
            :disabled="!controlsAvailable || controlling"
            @click="control('start')"
          >
            Start</button
          ><button
            type="button"
            :disabled="!controlsAvailable || controlling"
            @click="control('stop')"
          >
            Stop</button
          ><button
            type="button"
            :disabled="!controlsAvailable || controlling"
            @click="control('resume')"
          >
            Resume
          </button>
        </div>
      </header>
      <p class="bench-meta">
        Updated {{ new Date(status.updatedAt).toLocaleString() }} · run
        {{ status.agent?.runId ?? '—'
        }}<span v-if="!controlsAvailable">
          · {{ status.agent?.controls?.reason ?? 'Read-only static deployment' }}</span
        >
      </p>
      <p v-if="controlMessage" class="bench-control-message">{{ controlMessage }}</p>
      <div class="bench-overview">
        <article class="bench-card bench-progress-card">
          <p class="bench-kicker">Run state · {{ status.agent?.state ?? 'unknown' }}</p>
          <strong>{{ status.agent?.completed ?? 0 }} / {{ status.agent?.planned ?? 0 }}</strong
          ><span>trials complete</span>
          <div class="bench-progress"><i :style="{ width: `${completion}%` }" /></div>
          <code v-if="status.agent?.resumeCommand">{{ status.agent.resumeCommand }}</code>
        </article>
        <article class="bench-card">
          <p class="bench-kicker">Retrieval · {{ status.retrieval?.state ?? 'not published' }}</p>
          <strong>{{ percent(status.retrieval?.hybrid?.hit5) }}</strong
          ><span>hybrid Hit@5</span>
          <dl>
            <div>
              <dt>MRR</dt>
              <dd>{{ status.retrieval?.hybrid?.mrr?.toFixed(3) ?? '—' }}</dd>
            </div>
            <div>
              <dt>Queries</dt>
              <dd>{{ status.retrieval?.totalQueries ?? '—' }}</dd>
            </div>
          </dl>
        </article>
        <article class="bench-card">
          <p class="bench-kicker">Integrity</p>
          <strong>{{ status.agent?.invalidations?.length ?? '—' }}</strong
          ><span>published invalidations</span>
          <p>Invalidated attempts stay visible and never enter valid-arm aggregates.</p>
        </article>
      </div>
      <section class="bench-section">
        <div class="bench-section-heading">
          <div>
            <p class="bench-kicker">Treatment comparison</p>
            <h3>Aggregate outcomes by arm</h3>
          </div>
          <small>Only runner-published metrics are shown.</small>
        </div>
        <div v-if="aggregates.length" class="bench-table-wrap">
          <table class="bench-table">
            <thead>
              <tr>
                <th>Arm</th>
                <th>Valid / attempted</th>
                <th>Successful</th>
                <th>Pass rate</th>
                <th>Tool adoption</th>
                <th>Evidence used</th>
                <th>Median time</th>
                <th>Median tokens</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in aggregates" :key="row.arm">
                <th>{{ row.arm }}</th>
                <td>{{ num(row.valid) }} / {{ num(row.attempted) }}</td>
                <td>{{ num(row.successful) }}</td>
                <td>
                  <span class="bench-bar"
                    ><i :style="{ width: percent(row.passRate ?? row.pass_rate) }" /></span
                  >{{ percent(row.passRate ?? row.pass_rate) }}
                </td>
                <td>{{ percent(row.toolAdoption ?? row.tool_adoption) }}</td>
                <td>{{ percent(row.evidenceUsed ?? row.evidence_used) }}</td>
                <td>{{ duration(row.medianWallMs ?? row.median_wall_ms) }}</td>
                <td>{{ num(row.medianTokens ?? row.median_tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="bench-empty">
          No aggregate is published yet. This avoids turning incomplete trial data into a result.
        </p>
      </section>
      <section class="bench-section">
        <div class="bench-section-heading">
          <div>
            <p class="bench-kicker">Attempts</p>
            <h3>Trial explorer</h3>
          </div>
          <div class="bench-filters">
            <input
              v-model="query"
              aria-label="Search trials"
              placeholder="Search task, status, reason"
            /><select v-model="armFilter" aria-label="Filter by arm">
              <option value="all">All arms</option>
              <option v-for="arm in ['A', 'B', 'C', 'D']" :key="arm" :value="arm">
                Arm {{ arm }}
              </option>
            </select>
          </div>
        </div>
        <div v-if="visibleTrials.length" class="bench-table-wrap">
          <table class="bench-table bench-trials">
            <thead>
              <tr>
                <th>Trial</th>
                <th>Arm</th>
                <th>Status</th>
                <th>Outcome</th>
                <th>Time</th>
                <th>Tokens</th>
                <th>Git Why</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="trial in visibleTrials"
                :key="trialId(trial)"
                :class="{ 'is-invalid': trial.invalidation_reason }"
              >
                <th>
                  {{ trialTask(trial) }}<small>{{ trialId(trial) }}</small>
                </th>
                <td>{{ trial.arm ?? '—' }}</td>
                <td>
                  {{ trial.status ?? (trial.invalidation_reason ? 'invalidated' : 'completed')
                  }}<small v-if="trial.invalidation_reason">{{ trial.invalidation_reason }}</small>
                </td>
                <td>{{ trial.pass == null ? '—' : trial.pass ? 'pass' : 'fail' }}</td>
                <td>{{ duration(trialWall(trial)) }}</td>
                <td>{{ num(trialTokens(trial)) }}</td>
                <td>{{ num(trialCalls(trial)) }}</td>
                <td><button type="button" @click="selectedTrial = trial">Inspect</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="bench-empty">No trial-level data has been published for this run.</p>
      </section>
      <aside v-if="selectedTrial" class="bench-inspector" aria-label="Trial inspector">
        <div>
          <p class="bench-kicker">Trial inspector</p>
          <h3>{{ trialId(selectedTrial) }}</h3>
          <p>{{ selectedTrial.invalidation_reason ?? 'No invalidation reason recorded.' }}</p>
        </div>
        <button type="button" @click="selectedTrial = null">Close</button>
        <dl>
          <div>
            <dt>Arm</dt>
            <dd>{{ selectedTrial.arm ?? '—' }}</dd>
          </div>
          <div>
            <dt>Wall time</dt>
            <dd>{{ duration(trialWall(selectedTrial)) }}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{{ num(trialTokens(selectedTrial)) }}</dd>
          </div>
          <div>
            <dt>Evidence used</dt>
            <dd>{{ selectedTrial.evidenceUsed ?? selectedTrial.evidence_used ?? '—' }}</dd>
          </div>
        </dl>
        <pre>{{ selectedText }}</pre>
      </aside>
    </template>
    <p v-else class="bench-loading">Loading benchmark status…</p>
  </section>
</template>
