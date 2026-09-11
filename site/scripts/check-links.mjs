#!/usr/bin/env node
/**
 * Verifies every internal link in the built site resolves — both the page and,
 * where one is given, the anchor.
 *
 * Anchors are the half that rots silently. Renaming a heading changes its
 * generated id, and every `#deep-link` to it becomes a link that loads the
 * right page and lands in the wrong place, which nothing about the build
 * complains at.
 *
 * Run after `npm run build` in site/.
 *
 *   node site/scripts/check-links.mjs
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '.vitepress', 'dist');

if (!existsSync(dist)) {
  console.error(`check-links: no built site at ${dist}. Run the site build first.`);
  process.exit(1);
}

const htmlFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.html')) htmlFiles.push(full);
  }
})(dist);

/** `/git-why/guide/faq.html` -> `/guide/faq`, and `.../index.html` -> its directory. */
const routeOf = (file) =>
  '/' +
  path
    .relative(dist, file)
    .replace(/\.html$/, '')
    .replace(/\/?index$/, '');

const routes = new Set(htmlFiles.map(routeOf));
const anchors = new Map(
  htmlFiles.map((file) => [
    routeOf(file),
    new Set([...readFileSync(file, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1])),
  ]),
);

let broken = 0;
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const from = path.relative(dist, file);
  for (const match of html.matchAll(/href="(\/git-why\/[^"#]*)(#[^"]*)?"/g)) {
    const href = match[1];
    const hash = match[2];
    const route = (
      href
        .replace(/^\/git-why/, '')
        .replace(/\.html$/, '')
        .replace(/\/$/, '') || '/'
    ).replace(/\/index$/, '');
    // A link may point at a static asset (an install script, a cast) rather
    // than a rendered page.
    const asset = path.join(dist, href.replace(/^\/git-why\//, ''));
    const isAsset = existsSync(asset) && statSync(asset).isFile();
    if (!routes.has(route) && !isAsset) {
      console.error(`check-links: ${from} -> ${href} (no such page)`);
      broken += 1;
      continue;
    }
    if (hash && routes.has(route)) {
      const ids = anchors.get(route);
      if (ids && !ids.has(hash.slice(1))) {
        console.error(`check-links: ${from} -> ${route}${hash} (no such anchor)`);
        broken += 1;
      }
    }
  }
}

if (broken > 0) {
  console.error(`check-links: ${broken} broken internal link(s).`);
  process.exit(1);
}
console.log(`check-links: ${htmlFiles.length} pages, all internal links and anchors resolve.`);
