#!/usr/bin/env node
/**
 * Bundles the in-page pieces with esbuild.
 *
 *   dist/quip-bot.js     -> injected into the page (hooks the runner, HUD)
 *   dist/quip-worker.js  -> the planner, loaded as a Blob worker
 *
 * Both are IIFEs targeting the browser so they can be injected as plain
 * scripts with no module plumbing.
 */
import { build } from 'esbuild';
import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  format: 'iife',
  target: ['chrome110'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/browser/worker-entry.js'],
  outfile: 'dist/quip-worker.js',
});

await build({
  ...common,
  entryPoints: ['src/browser/agent-entry.js'],
  outfile: 'dist/quip-bot.js',
});

const w = fs.statSync('dist/quip-worker.js').size;
const a = fs.statSync('dist/quip-bot.js').size;
console.log(`built dist/quip-worker.js (${(w / 1024).toFixed(1)} kB), dist/quip-bot.js (${(a / 1024).toFixed(1)} kB)`);
