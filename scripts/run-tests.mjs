#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rawArgs = process.argv.slice(2);
const filteredArgs = rawArgs.filter((arg) => arg !== '--runInBand');

if (rawArgs.length !== filteredArgs.length) {
  console.warn('The `--runInBand` flag is not supported by Vitest and will be ignored.');
}

const vitestPath = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const result = spawnSync(process.execPath, [vitestPath, ...filteredArgs], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);