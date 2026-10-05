<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import DigHome from './DigHome.vue';

const { frontmatter } = useData();
const DefaultLayout = DefaultTheme.Layout;
</script>

<template>
  <DigHome v-if="frontmatter.layout === 'dig'" />
  <DefaultLayout v-else />
</template>
