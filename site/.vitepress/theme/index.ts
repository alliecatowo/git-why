import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Cast from './Cast.vue';
import Layout from './Layout.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('Cast', Cast);
  },
} satisfies Theme;
