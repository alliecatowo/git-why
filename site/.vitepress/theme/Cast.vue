<script setup lang="ts">
/**
 * Plays a recorded asciinema session.
 *
 * These are real recordings, not styled text blocks: the timings are actual
 * command latency and the output is whatever the tool printed.
 *
 * Why the old embed was blank: `src` was a root-relative path ("/casts/x.cast")
 * and the site is served from "/git-why/", so the fetch went to
 * github.io/casts/x.cast (a 404) and the player sat on its play-button overlay
 * forever. `withBase` fixes the path; the poster, the lazy mount and the
 * visible fallback below mean a failure is never silent again.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { withBase } from 'vitepress';

const props = withDefaults(
  defineProps<{
    src: string;
    title?: string;
    /** Seconds into the recording to show as the still frame before play. */
    poster?: number;
    idleTimeLimit?: number;
    speed?: number;
    rows?: number;
  }>(),
  { poster: 3, idleTimeLimit: 1.2, speed: 1.2, rows: undefined },
);

const root = ref<HTMLElement | null>(null);
const host = ref<HTMLElement | null>(null);
const failed = ref(false);
const ready = ref(false);
let player: { dispose?: () => void } | null = null;
let observer: IntersectionObserver | null = null;
const url = withBase(props.src);

async function mount() {
  try {
    const mod = await import('asciinema-player');
    await import('asciinema-player/dist/bundle/asciinema-player.css');
    if (!host.value) return;
    player = mod.create(url, host.value, {
      autoPlay: false,
      preload: true,
      poster: `npt:${props.poster}`,
      idleTimeLimit: props.idleTimeLimit,
      speed: props.speed,
      // Fixed font size, horizontally scrollable on a phone, rather than
      // shrinking 88 columns to an unreadable 4px.
      fit: false,
      terminalFontSize: '13px',
      theme: 'tokyo',
      controls: true,
    });
    ready.value = true;
  } catch {
    failed.value = true;
  }
}

onMounted(() => {
  if (!('IntersectionObserver' in window)) return void mount();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer?.disconnect();
        void mount();
      }
    },
    { rootMargin: '400px' },
  );
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  player?.dispose?.();
});
</script>

<template>
  <figure ref="root" class="cast">
    <figcaption v-if="title"><span class="prompt">$</span> {{ title }}</figcaption>
    <div class="cast-scroll">
      <div ref="host" class="cast-host" />
      <p v-if="!ready && !failed" class="cast-wait">loading recording…</p>
      <p v-if="failed" class="cast-wait">
        The player could not start. <a :href="url" download>Download the .cast file</a> and play it
        with <code>asciinema play</code>.
      </p>
    </div>
    <p class="cast-note">A real recorded session. Timings are actual latency.</p>
  </figure>
</template>

<style scoped>
.cast {
  margin: 1.25rem 0;
  min-width: 0;
}
.cast figcaption {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--dig-fg);
  margin-bottom: 0.5rem;
  overflow-wrap: anywhere;
}
.cast figcaption .prompt {
  color: var(--dig-cyan);
}
.cast-scroll {
  overflow-x: auto;
  border: 1px solid var(--dig-line);
  border-radius: 6px;
  background: #16161e;
  min-height: 8rem;
}
.cast-host :deep(.ap-wrapper),
.cast-host :deep(.ap-player) {
  max-width: none;
}
.cast-wait {
  margin: 0;
  padding: 1rem;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  color: #a9b1d6;
}
.cast-wait a {
  color: #7dcfff;
}
.cast-note {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--dig-muted);
  margin: 0.4rem 0 0;
}
</style>
