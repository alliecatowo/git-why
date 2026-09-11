import { defineConfig } from 'vitepress';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const STATUS_FILE = resolve(REPO_ROOT, 'site/public/bench-status.json');

/**
 * A deliberately opt-in local control plane for the documentation server.
 * It is not included in a built site. Setting BENCH_DASHBOARD_CONTROL=1
 * permits a human at the dev server to start/resume the smoke harness; the
 * process remains visible in the server terminal and is never auto-started.
 */
function benchControlPlugin() {
  let child: ReturnType<typeof spawn> | null = null;
  const enabled = process.env.BENCH_DASHBOARD_CONTROL === '1';
  const writeJson = (
    res: { setHeader: (key: string, value: string) => void; end: (body: string) => void },
    code: number,
    body: unknown,
  ) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const publish = (patch: Record<string, unknown>) => {
    try {
      const previous = existsSync(STATUS_FILE) ? JSON.parse(readFileSync(STATUS_FILE, 'utf8')) : {};
      writeFileSync(
        STATUS_FILE,
        `${JSON.stringify({ ...previous, updatedAt: new Date().toISOString(), agent: { ...(previous.agent ?? {}), ...patch } }, null, 2)}\n`,
      );
    } catch (cause) {
      console.warn('[bench-dashboard] unable to publish control status', cause);
    }
  };
  return {
    name: 'git-why-bench-control',
    configureServer(server: {
      middlewares: {
        use: (
          path: string,
          handler: (
            req: {
              method?: string;
              on: (event: string, callback: (chunk: Buffer) => void) => void;
            },
            res: {
              statusCode: number;
              setHeader: (key: string, value: string) => void;
              end: (body: string) => void;
            },
          ) => void,
        ) => void;
      };
    }) {
      server.middlewares.use('/git-why/__bench/control', (req, res) => {
        if (req.method === 'GET')
          return writeJson(res, 200, {
            available: enabled,
            running: Boolean(child?.pid),
            reason: enabled
              ? null
              : 'Set BENCH_DASHBOARD_CONTROL=1 before starting the local Vite server.',
          });
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return writeJson(res, 405, { message: 'POST required' });
        }
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk.toString();
        });
        req.on('end', () => {
          if (!enabled) {
            res.statusCode = 403;
            return writeJson(res, 403, {
              message:
                'Controls are disabled. Restart the local docs server with BENCH_DASHBOARD_CONTROL=1.',
            });
          }
          let action: string;
          try {
            action = JSON.parse(raw).action;
          } catch {
            res.statusCode = 400;
            return writeJson(res, 400, { message: 'Invalid JSON request.' });
          }
          if (action === 'stop') {
            if (!child?.pid)
              return writeJson(res, 200, { message: 'No dashboard-started benchmark is running.' });
            child.kill('SIGTERM');
            publish({ state: 'stopping', note: 'Stop requested from the local dashboard.' });
            return writeJson(res, 200, { message: 'Stop signal sent.' });
          }
          if (action !== 'start' && action !== 'resume') {
            res.statusCode = 400;
            return writeJson(res, 400, { message: 'Unknown action.' });
          }
          if (child?.pid) {
            res.statusCode = 409;
            return writeJson(res, 409, {
              message: 'A dashboard-started benchmark is already running.',
            });
          }
          // Start is smoke-only by design. Full pilots remain an explicit terminal command
          // because they can incur provider use and require a human-approved protocol.
          const args = ['bench/agents/run.mjs', '--stage=smoke'];
          child = spawn(process.execPath, args, {
            cwd: REPO_ROOT,
            detached: false,
            stdio: 'inherit',
            // A locally built default makes the explicit dashboard controls
            // usable without asking the browser to supply any runtime or
            // credential detail. The runner still verifies the image and
            // refuses to run if it is unavailable.
            env: {
              ...process.env,
              BENCH_SANDBOX_IMAGE: process.env.BENCH_SANDBOX_IMAGE ?? 'git-why-bench:local',
            },
          });
          publish({
            state: 'running',
            stage: 'Smoke',
            note: `Started from local dashboard (${action}).`,
            resumeCommand: `node ${args.join(' ')}`,
          });
          child.on('close', (code, signal) => {
            publish({
              state: code === 0 ? 'completed' : 'stopped',
              note:
                code === 0
                  ? 'Dashboard-started smoke run completed.'
                  : `Dashboard-started smoke run ended (${signal ?? `exit ${code}`}).`,
            });
            child = null;
          });
          return writeJson(res, 202, {
            message: `Smoke run ${action}ed. Follow live logs in the Vite server terminal.`,
          });
        });
      });
    },
  };
}

export default defineConfig({
  title: 'Git Why',
  description:
    '`git blame` tells you who changed the code; `git why` finds the history that explains it.',
  base: '/git-why/',
  lang: 'en-US',
  appearance: 'dark',
  cleanUrls: true,
  lastUpdated: true,

  vite: {
    plugins: [benchControlPlugin()],
    server: {
      allowedHosts: ['allisons-mac-mini.tail4950ff.ts.net'],
    },
  },

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
            { text: 'How it works', link: '/guide/how-it-works' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI reference', link: '/guide/cli-reference' },
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
