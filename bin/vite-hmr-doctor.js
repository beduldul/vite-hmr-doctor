#!/usr/bin/env node
/**
 * Executable entry point for vite-hmr-doctor.
 *
 * Keeps process-level concerns (argv, exit code) out of `src/cli.js` so the
 * CLI logic stays testable in-process.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));

let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  if (typeof pkg.version === 'string') version = pkg.version;
} catch (error) {
  // A missing or malformed package.json must not stop the tool from running;
  // report the real cause on stderr and continue with a placeholder version.
  process.stderr.write(
    `warning: could not read package.json for the version: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
}

const exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  version,
});

process.exitCode = exitCode;
