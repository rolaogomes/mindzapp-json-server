#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
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

const testDirUrl = new URL('../tests', import.meta.url);
const loaderUrl = new URL('./ts-loader.mjs', import.meta.url);

const testDirPath = fileURLToPath(testDirUrl);
const relativeTestDir = path.relative(process.cwd(), testDirPath);
const testArg = relativeTestDir === '' ? testDirUrl.href : relativeTestDir;

const nodeArgs = ['--loader', loaderUrl.href, ...translatedArgs, '--test', testArg];

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);