import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Cast from './Cast.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Cast', Cast);
  },
} satisfies Theme;
