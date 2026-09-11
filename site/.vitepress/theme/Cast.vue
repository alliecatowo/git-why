<script setup lang="ts">
/**
 * Plays a recorded asciinema session.
 *
 * These are real recordings, not styled text blocks: the timings are actual
 * command latency and the output is whatever the tool printed. A fabricated
 * terminal is a claim dressed as a demonstration, and this project documents
 * what it measured.
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string;
    title?: string;
    /** Autoplay is off by default: a page of self-starting terminals is hostile. */
    autoplay?: boolean;
    idleTimeLimit?: number;
    speed?: number;
  }>(),
  { autoplay: false, idleTimeLimit: 1.5, speed: 1.3 },
);

const host = ref<HTMLElement | null>(null);
let player: { dispose?: () => void } | null = null;

onMounted(async () => {
  // Imported dynamically so the player never enters the server-side render
  // path, where `document` does not exist.
  const mod = await import('asciinema-player');
  await import('asciinema-player/dist/bundle/asciinema-player.css');
  if (!host.value) return;
  player = mod.create(props.src, host.value, {
    autoPlay: props.autoplay,
    // Long pauses in a real session are dead air on a page; capping idle time
    // keeps the pacing watchable without altering what was recorded.
    idleTimeLimit: props.idleTimeLimit,
    speed: props.speed,
    fit: 'width',
    terminalFontSize: '13px',
    theme: 'asciinema',
  });
});

onBeforeUnmount(() => player?.dispose?.());
</script>

<template>
  <figure class="cast">
    <figcaption v-if="title">{{ title }}</figcaption>
    <div ref="host" />
    <p class="cast-note">
      A real recorded session. Timings are actual latency.
    </p>
  </figure>
</template>

<style scoped>
.cast {
  margin: 1.5rem 0;
}
.cast figcaption {
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.cast-note {
  font-size: 0.8rem;
  opacity: 0.6;
  margin-top: 0.4rem;
}
</style>
