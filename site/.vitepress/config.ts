import { defineConfig } from 'vitepress';
import tokyoNight from 'shiki/themes/tokyo-night.mjs';

// Tokyo Night, with its orange and amber tokens moved onto the site's pinks and
// soft yellow so no orange appears anywhere on the site.
const tokyo = JSON.parse(
  JSON.stringify({ ...tokyoNight, name: 'git-why-tokyo' })
    .replaceAll('#ff9e64', '#f7a8c4')
    .replaceAll('#e0af68', '#e3d18a'),
);

export default defineConfig({
  title: 'Git Why',
  description:
    '`git blame` tells you who changed the code; `git why` finds the history that explains it.',
  base: '/git-why/',
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',

  markdown: {
    // Tokyo Night code blocks in both site themes: a terminal stays dark.
    theme: { light: tokyo, dark: tokyo },
  },

  head: [
    ['link', { rel: 'icon', href: '/git-why/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#1a1b26' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,700;1,9..144,400;1,9..144,500&family=JetBrains+Mono:wght@400;500;700&display=swap',
      },
    ],
    ['meta', { property: 'og:title', content: 'Git Why' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Local-first semantic + full-text search over Git history. Retrieves the commit; never invents the reason.',
      },
    ],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'CLI', link: '/guide/cli-reference' },
      { text: 'How it works', link: '/guide/how-it-works' },
      { text: 'Agents & MCP', link: '/guide/mcp' },
      { text: 'Daemon', link: '/guide/daemon' },
      {
        text: 'v0.2.0',
        items: [
          { text: 'Changelog', link: 'https://github.com/alliecatowo/git-why/releases' },
          { text: 'Operations & guarantees', link: '/guide/operations' },
          { text: 'Benchmarks', link: '/guide/benchmarks' },
          { text: 'FAQ', link: '/guide/faq' },
        ],
      },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Start here',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Examples', link: '/guide/examples' },
            { text: 'How it works', link: '/guide/how-it-works' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI reference', link: '/guide/cli-reference' },
            { text: 'Agents & MCP', link: '/guide/mcp' },
            { text: 'Daemon', link: '/guide/daemon' },
            { text: 'Embedding model', link: '/guide/embedding' },
            { text: 'Operations & guarantees', link: '/guide/operations' },
            { text: 'Benchmarks', link: '/guide/benchmarks' },
          ],
        },
        {
          text: 'More',
          items: [
            { text: 'FAQ & limitations', link: '/guide/faq' },
            { text: 'Contributing', link: '/guide/contributing' },
          ],
        },
      ],
    },

    search: {
      provider: 'local',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/alliecatowo/git-why' }],

    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Git Why is local-first: your repository text never leaves your machine.',
    },

    editLink: {
      pattern: 'https://github.com/alliecatowo/git-why/edit/main/site/:path',
      text: 'Edit this page on GitHub',
    },

    outline: {
      level: [2, 3],
    },
  },
});
