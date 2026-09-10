import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import BenchDashboard from './BenchDashboard.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('BenchDashboard', BenchDashboard);
  },
} satisfies Theme;
