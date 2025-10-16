#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';

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
const testFiles = await fg('**/*.test.{js,cjs,mjs,ts,tsx}', {
  cwd: testDirPath,
  absolute: true,
  suppressErrors: true,
});

const testArgs = testFiles.map(file => {
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(file);
});
if (testArgs.length === 0) {
  console.warn('No test files found in the tests directory. Running default discovery.');
}

const nodeArgs = ['--loader', loaderUrl.href, ...translatedArgs, '--test', ...testArgs];

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);