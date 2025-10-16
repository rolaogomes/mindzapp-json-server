#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rawArgs = process.argv.slice(2);
const withoutRunInBand = rawArgs.filter(arg => arg !== '--runInBand');
if (rawArgs.length !== withoutRunInBand.length) {
  console.warn('The `--runInBand` flag is not supported by the test runner and will be ignored.');
}

const translatedArgs = withoutRunInBand.flatMap(arg => {
  if (arg === 'run') {
    return [];
  }
  if (arg === '--coverage') {
    return ['--experimental-test-coverage'];
  }
  return [arg];
});

const testDir = fileURLToPath(new URL('../tests', import.meta.url));
const loaderPath = fileURLToPath(new URL('./ts-loader.mjs', import.meta.url));
const nodeArgs = ['--loader', loaderPath, ...translatedArgs, '--test', testDir];

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);