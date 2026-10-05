<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Content, useData, withBase } from 'vitepress';

const { isDark } = useData();
const menuOpen = ref(false);
const copied = ref('');

const nav = [
  { text: 'Guide', href: '/guide/getting-started' },
  { text: 'CLI', href: '/guide/cli-reference' },
  { text: 'How it works', href: '/guide/how-it-works' },
  { text: 'Agents & MCP', href: '/guide/mcp' },
  { text: 'Daemon', href: '/guide/daemon' },
  { text: 'Benchmarks', href: '/guide/benchmarks' },
];

const REPO = 'https://github.com/alliecatowo/git-why';
// Each section of the page is pinned to a real commit in this repository that
// belongs to the thing the section describes.
const commits = {
  head: { hash: 'bccbabf', date: '2026-10-04', author: 'Allison Coleman' },
  hybrid: { hash: '496c970', date: '2026-09-09', author: 'alliecatowo' },
  time: { hash: '05a2b3f', date: '2026-09-09', author: 'alliecatowo' },
  agents: { hash: '76b84ff', date: '2026-10-03', author: 'Allison Coleman' },
  daemon: { hash: 'c86a6f0', date: '2026-09-10', author: 'alliecatowo' },
  measured: { hash: 'b204ace', date: '2026-09-11', author: 'alliecatowo' },
  install: { hash: '855b373', date: '2026-10-04', author: 'Allison Coleman' },
};

const question = 'why did the first release fail to publish to npm';
const typed = ref(question);
const answered = ref(true);

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  typed.value = '';
  answered.value = false;
  let i = 0;
  const tick = () => {
    i += 1;
    typed.value = question.slice(0, i);
    if (i < question.length) setTimeout(tick, 28 + Math.random() * 40);
    else setTimeout(() => (answered.value = true), 380);
  };
  setTimeout(tick, 500);
});

async function copy(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = id;
    setTimeout(() => (copied.value = ''), 1600);
  } catch {
    /* clipboard unavailable: the text is selectable anyway */
  }
}

const curl = 'curl -fsSL https://alliecatowo.github.io/git-why/install.sh | sh';
const npm = 'npm install -g @alliecatowo/git-why';
</script>

<template>
  <div class="dig">
    <header class="bar">
      <a class="brand" :href="withBase('/')" aria-label="Git Why home">
        <img :src="withBase('/logo.svg')" alt="" width="22" height="22" />
        <span>git why</span>
      </a>
      <nav class="links" aria-label="Primary">
        <a v-for="n in nav" :key="n.href" :href="withBase(n.href)">{{ n.text }}</a>
        <a :href="REPO" rel="noopener">GitHub</a>
      </nav>
      <button
        class="tool"
        type="button"
        aria-label="Toggle light and dark theme"
        @click="isDark = !isDark"
      >
        <span class="to-light">light</span><span class="to-dark">dark</span>
      </button>
      <button
        class="tool menu"
        type="button"
        :aria-expanded="menuOpen"
        aria-controls="dig-menu"
        @click="menuOpen = !menuOpen"
      >
        {{ menuOpen ? 'close' : 'menu' }}
      </button>
      <nav v-show="menuOpen" id="dig-menu" class="drawer" aria-label="Primary (menu)">
        <a v-for="n in nav" :key="n.href" :href="withBase(n.href)">{{ n.text }}</a>
        <a :href="REPO" rel="noopener">GitHub</a>
      </nav>
    </header>

    <main class="rail">
      <!-- HEAD: the question and the answer -->
      <section class="commit head">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.head.hash}`" class="hash"
            >HEAD · {{ commits.head.hash }}</a
          >
          <span>{{ commits.head.date }}</span>
          <span>{{ commits.head.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <p class="kicker">Semantic archaeology for Git</p>
          <h1>The commit already <em>tells you why.</em></h1>
          <p class="lede">
            <code>git blame</code> says who touched the line. Git Why finds the commit, in its
            author's own words, that explains it, even when you cannot name a single word in it.
          </p>

          <div class="prompt" aria-label="A question typed at a prompt">
            <span class="ps">$</span>
            <span class="q"
              >git why <span class="str">"{{ typed }}"</span
              ><i v-if="!answered" class="caret" aria-hidden="true"
            /></span>
          </div>

          <article class="card" :class="{ shown: answered }" aria-live="polite">
            <header>
              <a :href="`${REPO}/commit/ceb0741`" class="hash">ceb0741</a>
              <span>2026-10-03</span>
              <span>Allison Coleman</span>
            </header>
            <h2>ci(release): fix tarball step and make post-publish jobs re-runnable (#17)</h2>
            <blockquote>
              The v0.1.1 run published to npm, then failed packing the tarball because the pack
              destination did not exist, which skipped the GitHub release, MCP registry and Homebrew
              jobs.
            </blockquote>
            <p class="path">.github/workflows/release.yml</p>
            <pre class="diff"><code><span class="ctx">     on:</span>
<span class="ctx">       push:</span>
<span class="ctx">         tags: ['v*']</span>
<span class="add">+  # Re-run the post-publish jobs (GitHub release, MCP registry, Homebrew) for a</span>
<span class="add">+  # tag whose npm publish already succeeded.</span>
<span class="add">+  workflow_dispatch:</span>
<span class="add">+    inputs:</span>
<span class="add">+      tag:</span>
<span class="add">+        description: 'Existing tag, e.g. v0.1.2'</span></code></pre>
            <footer>
              Real output from <code>git why</code> 0.2.0 run on this repository. The question
              shares no vocabulary with the commit that answers it.
            </footer>
          </article>

          <div class="install">
            <button type="button" class="cmd" @click="copy('curl', curl)">
              <span class="ps">$</span><code>{{ curl }}</code>
              <small>{{ copied === 'curl' ? 'copied' : 'copy' }}</small>
            </button>
            <button type="button" class="cmd" @click="copy('npm', npm)">
              <span class="ps">$</span><code>{{ npm }}</code>
              <small>{{ copied === 'npm' ? 'copied' : 'copy' }}</small>
            </button>
          </div>
          <p class="next">
            <a :href="withBase('/guide/getting-started')">Getting started</a>
            <span aria-hidden="true">/</span>
            <a :href="withBase('/guide/how-it-works')">How it works</a>
            <span aria-hidden="true">/</span>
            <a :href="REPO">Source</a>
          </p>
        </div>
      </section>

      <!-- Hybrid retrieval -->
      <section class="commit" id="search">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.hybrid.hash}`" class="hash">{{
            commits.hybrid.hash
          }}</a>
          <span>{{ commits.hybrid.date }}</span>
          <span>{{ commits.hybrid.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Search by meaning, not by name</h2>
          <p>
            Full-text and vector search run independently over every reachable commit and are fused
            with Reciprocal Rank Fusion, so an exact identifier and a half-remembered paraphrase
            both land. What comes back is a real commit with its author's actual words and the
            relevant diff. Nothing is generated; the reason is retrieved or it is not there.
          </p>
          <Cast
            src="/casts/dig-ask.cast"
            title='git why "why did the first release fail to publish to npm" -n 1 | head -13'
            :poster="3"
          />
          <p class="aside">
            Embedding runs in-process with a small static model, so repository text never leaves
            your machine. After one checksummed download it works fully offline.
          </p>
        </div>
      </section>

      <!-- Time -->
      <section class="commit" id="time">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.time.hash}`" class="hash">{{ commits.time.hash }}</a>
          <span>{{ commits.time.date }}</span>
          <span>{{ commits.time.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Dig through time, not just text</h2>
          <p>
            <code>--first</code>, <code>--last</code> and <code>--removed</code> resolve an endpoint
            from the lineage table. <code>--timeline</code> lays a subject out as it changed.
            <code>--owners</code> ranks who established an area by how relevant their commits are,
            not by surviving lines.
          </p>
          <Cast
            src="/casts/dig-timeline.cast"
            title='git why "the MCP bridge" --timeline -n 1 | cut -c1-88 | head -16'
            :poster="3"
          />
          <Cast
            src="/casts/dig-owners.cast"
            title='git why "daemon" --owners -n 20 | cut -c1-88 | head -10'
            :poster="3"
          />
        </div>
      </section>

      <!-- Agents -->
      <section class="commit" id="agents">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.agents.hash}`" class="hash">{{
            commits.agents.hash
          }}</a>
          <span>{{ commits.agents.date }}</span>
          <span>{{ commits.agents.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Hand the shovel to an agent</h2>
          <p>
            <code>git why mcp</code> serves two tools over stdio, <code>git_why_search</code> and
            <code>git_why_status</code>. It is a thin bridge onto the CLI's JSON contract, so an
            agent and a human cannot disagree about what a search returns.
          </p>
          <pre
            class="snippet"
          ><code>claude mcp add git-why -- npx -y @alliecatowo/git-why mcp</code></pre>
          <p class="aside">
            Config for OpenCode, the Claude Code plugins and any other MCP client is in
            <a :href="withBase('/guide/mcp')">Agents &amp; MCP</a>.
          </p>
        </div>
      </section>

      <!-- Daemon -->
      <section class="commit" id="daemon">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.daemon.hash}`" class="hash">{{
            commits.daemon.hash
          }}</a>
          <span>{{ commits.daemon.date }}</span>
          <span>{{ commits.daemon.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Optional, and never the reason a search fails</h2>
          <p>
            A daemon keeps the index and model warm for roughly twice the speed. If it is missing,
            stale or dead, the query simply runs directly. Loopback only, bearer token, read-only.
          </p>
          <Cast src="/casts/dig-daemon.cast" title="git why server on / status / off" :poster="4" />
        </div>
      </section>

      <!-- Measured (markdown: generated by bench/report.mjs) -->
      <section class="commit merge" id="measured">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.measured.hash}`" class="hash">{{
            commits.measured.hash
          }}</a>
          <span>{{ commits.measured.date }}</span>
          <span>{{ commits.measured.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Measured, and wrong most of the time</h2>
          <div class="vp-doc measured">
            <Content />
          </div>
        </div>
      </section>

      <!-- Install -->
      <section class="commit tip" id="install">
        <div class="meta">
          <a :href="`${REPO}/commit/${commits.install.hash}`" class="hash"
            >v0.2.0 · {{ commits.install.hash }}</a
          >
          <span>{{ commits.install.date }}</span>
          <span>{{ commits.install.author }}</span>
        </div>
        <span class="node" aria-hidden="true" />
        <div class="body">
          <h2 class="sect">Start digging</h2>
          <p>
            Node 22.12 or newer, macOS or Linux, any Git repository. The first query builds the
            index.
          </p>
          <pre class="snippet"><code>{{ curl }}
cd your-repo
git why "why do we retry on a 429 here?"</code></pre>
          <p class="next">
            <a :href="withBase('/guide/getting-started')">Getting started</a>
            <span aria-hidden="true">/</span>
            <a :href="withBase('/guide/cli-reference')">CLI reference</a>
            <span aria-hidden="true">/</span>
            <a :href="withBase('/guide/faq')">FAQ and limits</a>
          </p>
        </div>
      </section>
    </main>

    <footer class="foot">
      <span>Apache-2.0. Local-first: your repository text never leaves your machine.</span>
      <a :href="REPO">alliecatowo/git-why</a>
    </footer>
  </div>
</template>

<style scoped>
.dig {
  --rail-x: 15px;
  --rail-pad: 44px;
  min-height: 100vh;
  background: var(--dig-bg);
  color: var(--dig-fg);
  font-family: var(--font-serif);
  overflow-x: clip;
}
a {
  color: var(--dig-link);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
code {
  font-family: var(--font-mono);
  font-size: 0.86em;
}

/* ---- top bar ---- */
.bar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  background: color-mix(in srgb, var(--dig-bg) 92%, transparent);
  border-bottom: 1px solid var(--dig-line);
  backdrop-filter: blur(6px);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--dig-fg);
  font-weight: 700;
  margin-right: auto;
}
.links {
  display: none;
}
.links a,
.drawer a {
  color: var(--dig-muted);
}
.links a:hover,
.drawer a:hover {
  color: var(--dig-fg);
  text-decoration: none;
}
.tool {
  font: inherit;
  color: var(--dig-fg);
  background: transparent;
  border: 1px solid var(--dig-line);
  border-radius: 4px;
  padding: 0.3rem 0.6rem;
  cursor: pointer;
}
.tool:hover {
  border-color: var(--dig-violet);
}
.to-light {
  display: none;
}
:global(.dark) .to-light {
  display: inline;
}
:global(.dark) .to-dark {
  display: none;
}
.drawer {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  background: var(--dig-bg);
  border-bottom: 1px solid var(--dig-line);
  padding: 0.5rem 1rem 1rem;
}
.drawer a {
  padding: 0.7rem 0;
  border-bottom: 1px dashed var(--dig-line);
  font-size: 0.95rem;
}

/* ---- the rail ---- */
.rail {
  position: relative;
  max-width: 1080px;
  margin: 0 auto;
  padding: 2rem 1rem 3rem;
}
.rail::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(1rem + var(--rail-x));
  width: 2px;
  background: linear-gradient(
    to bottom,
    var(--dig-violet),
    var(--dig-line) 12%,
    var(--dig-line) 92%,
    transparent
  );
}
.commit {
  position: relative;
  padding: 0 0 4rem var(--rail-pad);
  min-width: 0;
}
.node {
  position: absolute;
  left: calc(var(--rail-x) - 7px + 1px);
  top: 0.15rem;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dig-bg);
  border: 2px solid var(--dig-cyan);
}
.head .node {
  background: var(--dig-violet);
  border-color: var(--dig-violet);
  box-shadow: 0 0 0 4px var(--dig-bg);
}
.merge .node {
  box-shadow:
    0 0 0 3px var(--dig-bg),
    0 0 0 5px var(--dig-violet);
}
.tip .node {
  border-color: var(--dig-green);
}
.tip {
  padding-bottom: 1rem;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.9rem;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--dig-muted);
  margin-bottom: 0.7rem;
}
.hash {
  color: var(--dig-hash);
  font-weight: 600;
}
.body {
  min-width: 0;
}
.kicker {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--dig-cyan);
  margin: 0 0 0.4rem;
}
h1 {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: clamp(2.2rem, 8.4vw, 4.4rem);
  line-height: 1.04;
  letter-spacing: -0.02em;
  margin: 0 0 1rem;
  font-variation-settings:
    'opsz' 144,
    'SOFT' 50;
}
h1 em {
  color: var(--dig-violet);
  font-style: italic;
}
.lede {
  font-size: 1.15rem;
  line-height: 1.55;
  max-width: 36rem;
  margin: 0 0 1.75rem;
  color: var(--dig-fg);
}
h2.sect {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: clamp(1.6rem, 5.4vw, 2.3rem);
  line-height: 1.12;
  letter-spacing: -0.015em;
  margin: 0 0 0.8rem;
  font-variation-settings: 'opsz' 100;
}
.body > p code {
  white-space: nowrap;
}
.body > p {
  font-size: 1.08rem;
  line-height: 1.62;
  max-width: 40rem;
}
.aside {
  color: var(--dig-muted);
}
.next {
  font-family: var(--font-mono);
  font-size: 0.82rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.7rem;
  color: var(--dig-muted);
}

/* ---- hero prompt + answer card ---- */
.prompt {
  display: flex;
  gap: 0.6rem;
  font-family: var(--font-mono);
  font-size: clamp(0.85rem, 3.4vw, 1.05rem);
  background: var(--dig-term);
  color: #c0caf5;
  border: 1px solid var(--dig-line);
  border-radius: 6px 6px 0 0;
  padding: 0.85rem 1rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.ps {
  color: var(--dig-cyan);
  flex: none;
}
.str {
  color: #9ece6a;
}
.caret {
  display: inline-block;
  width: 0.55em;
  height: 1.05em;
  background: #c0caf5;
  vertical-align: text-bottom;
  margin-left: 2px;
  animation: blink 1s steps(2) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.card {
  border: 1px solid var(--dig-line);
  border-top: 2px solid var(--dig-violet);
  background: var(--dig-card);
  border-radius: 0 0 6px 6px;
  padding: 1rem 1rem 0.9rem;
  margin-bottom: 1.5rem;
  opacity: 0;
  transform: translateY(6px);
  transition:
    opacity 0.5s,
    transform 0.5s;
  min-width: 0;
}
.card.shown {
  opacity: 1;
  transform: none;
}
.card header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.9rem;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--dig-muted);
}
.card h2 {
  font-family: var(--font-mono);
  font-size: 0.88rem;
  font-weight: 700;
  margin: 0.5rem 0 0.8rem;
  line-height: 1.4;
  border: 0;
  padding: 0;
  overflow-wrap: anywhere;
}
blockquote {
  margin: 0 0 1rem;
  padding: 0;
  border: 0;
  font-family: var(--font-serif);
  font-style: italic;
  font-size: clamp(1.15rem, 4.4vw, 1.5rem);
  line-height: 1.4;
  font-variation-settings: 'opsz' 72;
}
.path {
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--dig-muted);
  margin: 0 0 0.3rem;
  overflow-wrap: anywhere;
}
.diff {
  margin: 0;
  background: var(--dig-term);
  border-radius: 4px;
  padding: 0.7rem 0.8rem;
  overflow-x: auto;
  font-size: 0.74rem;
  line-height: 1.55;
}
.diff code {
  font-size: inherit;
  white-space: pre;
  color: #a9b1d6;
}
.diff .add {
  color: #9ece6a;
}
.card footer {
  margin-top: 0.8rem;
  font-size: 0.85rem;
  color: var(--dig-muted);
  line-height: 1.5;
}

/* ---- install buttons ---- */
.install {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 0.9rem;
}
.cmd {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  width: 100%;
  text-align: left;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--dig-fg);
  background: var(--dig-card);
  border: 1px solid var(--dig-line);
  border-radius: 4px;
  padding: 0.65rem 0.8rem;
  cursor: pointer;
  min-width: 0;
}
.cmd:hover {
  border-color: var(--dig-violet);
}
.cmd code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: inherit;
}
.cmd small {
  color: var(--dig-muted);
  flex: none;
}
.snippet {
  margin: 1rem 0;
  max-width: 100%;
  background: var(--dig-term);
  color: #c0caf5;
  border: 1px solid var(--dig-line);
  border-radius: 6px;
  padding: 0.85rem 1rem;
  overflow-x: auto;
  font-size: 0.8rem;
  line-height: 1.6;
}

.measured :deep(table) {
  display: block;
  overflow-x: auto;
  max-width: 100%;
}
.measured :deep(h3) {
  margin-top: 2rem;
}

.foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.5rem;
  justify-content: space-between;
  max-width: 1080px;
  margin: 0 auto;
  padding: 1.2rem 1rem 2.5rem;
  border-top: 1px solid var(--dig-line);
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--dig-muted);
}

/* ---- wide: meta column left of the rail ---- */
@media (min-width: 900px) {
  .dig {
    --rail-x: 0px;
    --rail-pad: 0px;
  }
  .links {
    display: flex;
    gap: 1.1rem;
    margin-right: 0.5rem;
  }
  .menu,
  .drawer {
    display: none !important;
  }
  .bar {
    padding: 0.7rem 2rem;
  }
  .rail {
    padding: 3rem 2rem 4rem;
  }
  .rail::before {
    left: calc(2rem + 190px + 28px);
  }
  .commit {
    display: grid;
    grid-template-columns: 190px 56px minmax(0, 1fr);
    padding-left: 0;
  }
  .meta {
    grid-column: 1;
    flex-direction: column;
    align-items: flex-end;
    text-align: right;
    margin: 0.15rem 0 0;
    gap: 0.1rem;
  }
  .node {
    left: calc(190px + 28px - 7px + 1px);
  }
  .body {
    grid-column: 3;
  }
  .install {
    grid-template-columns: 1fr;
    max-width: 38rem;
  }
  .cmd {
    font-size: 0.85rem;
  }
}
</style>
