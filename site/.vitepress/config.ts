import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Git Why',
  description:
    '`git blame` tells you who changed the code; `git why` finds the history that explains it.',
  base: '/git-why/',
  lang: 'en-US',
  appearance: 'dark',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', href: '/git-why/favicon.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#f97316' }],
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
      { text: 'CLI Reference', link: '/guide/cli-reference' },
      { text: 'Daemon', link: '/guide/daemon' },
      { text: 'Benchmarks', link: '/guide/benchmarks' },
      { text: 'FAQ', link: '/guide/faq' },
      {
        text: 'v0.1.0',
        items: [
          { text: 'Changelog', link: 'https://github.com/alliecatowo/git-why/releases' },
          { text: 'Spec & operations', link: '/guide/operations' },
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
