/**
 * Tests for argument parsing, output shapes, and exit codes.
 *
 * Runs the real CLI in-process against the real fixtures on disk with captured
 * streams, so exit codes and output are asserted as a user would see them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCodeFor, formatJson, main, parseArgs, shouldUseColour } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');
const fixture = (name) => join(FIXTURES, name);

/** Capture stdout/stderr from a `main` run. */
async function run(args, env = {}) {
  let out = '';
  let err = '';
  const stdout = { write: (chunk) => { out += chunk; return true; }, isTTY: false };
  const stderr = { write: (chunk) => { err += chunk; return true; }, isTTY: false };
  const code = await main(args, { stdout, stderr, env, version: '9.9.9' });
  return { code, out, err };
}

describe('parseArgs', () => {
  it('defaults to the current directory and no flags', () => {
    assert.deepEqual(parseArgs([]), {
      path: '.', json: false, strict: false, preferVite: true, help: false, version: false,
    });
  });

  it('accepts a path and flags in any order', () => {
    const parsed = parseArgs(['--json', 'some/dir', '--strict']);
    assert.equal(parsed.path, 'some/dir');
    assert.equal(parsed.json, true);
    assert.equal(parsed.strict, true);
  });

  it('supports --no-vite, --help, and --version', () => {
    assert.equal(parseArgs(['--no-vite']).preferVite, false);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  it('rejects unknown flags', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  });

  it('rejects extra positionals', () => {
    assert.throws(() => parseArgs(['a', 'b']), /extra argument/);
  });
});

describe('exit codes via main()', () => {
  it('exits 0 on a clean config', async () => {
    const { code, out } = await run([fixture('clean.config.js')]);
    assert.equal(code, 0);
    assert.match(out, /Summary: 0 findings, 0 failures/);
  });

  it('exits 1 on ws:false + hmr.port', async () => {
    const { code, out } = await run([fixture('ws-false-hmr-port.config.js')]);
    assert.equal(code, 1);
    assert.match(out, /server\.hmr\.port/);
  });

  it('exits 1 on ws:false + hmr.server, the transport case', async () => {
    const { code, out } = await run([fixture('ws-false-hmr-server.config.js')]);
    assert.equal(code, 1);
    assert.match(out, /hmr\.server|transport/i);
  });

  it('exits 1 on the duplicate hmr key fixture', async () => {
    const { code, out } = await run([fixture('hmr-false-with-options.config.js')]);
    assert.equal(code, 1);
    assert.match(out, /can never be reached/);
  });

  it('exits 0 on the deprecated hmr alias fixture, since it is only a notice', async () => {
    const { code, out } = await run([fixture('deprecated-hmr.config.js')]);
    assert.equal(code, 0, 'a deprecation notice does not fail without --strict');
    assert.match(out, /Summary: 1 finding, 0 failures/);
  });

  it('exits 2 when the path does not exist', async () => {
    const { code, err } = await run([join(FIXTURES, 'definitely-missing.config.js')]);
    assert.equal(code, 2);
    assert.match(err, /does not exist/);
  });

  it('exits 2 for a directory with no config file', async () => {
    const { code, err } = await run([here]);
    assert.equal(code, 2);
    assert.match(err, /No Vite config found/);
  });

  it('exits 2 for an unknown flag', async () => {
    const { code, err } = await run(['--frobnicate']);
    assert.equal(code, 2);
    assert.match(err, /Unknown option/);
  });

  it('exits 2 for a config with no readable server block', async () => {
    const { code, err } = await run([fixture('unreadable.config.js')]);
    assert.equal(code, 2);
    assert.match(err, /Could not load/);
  });

  it('still analyses an unparseable config that has a readable server block', async () => {
    // syntax-error.config.js fails to import but its server block is legible,
    // so the static fallback reports the dropped option instead of erroring.
    const { code, out } = await run([fixture('syntax-error.config.js')]);
    assert.equal(code, 1);
    assert.match(out, /server\.hmr\.port/);
  });

  it('exits 0 for --help and --version', async () => {
    assert.equal((await run(['--help'])).code, 0);
    assert.equal((await run(['--version'])).code, 0);
    assert.match((await run(['--version'])).out, /9\.9\.9/);
  });
});

describe('--strict', () => {
  it('flips a deprecation-only config from exit 0 to exit 1', async () => {
    const loose = await run([fixture('deprecated-hmr.config.js')]);
    const strict = await run(['--strict', fixture('deprecated-hmr.config.js')]);
    assert.equal(loose.code, 0);
    assert.equal(strict.code, 1, '--strict must treat a deprecation as a failure');
  });

  it('does not change the code for a warning', async () => {
    const { code } = await run(['--strict', fixture('ws-false-hmr-port.config.js')]);
    assert.equal(code, 1);
  });

  it('is reported in the summary line', async () => {
    const { out } = await run(['--strict', fixture('deprecated-hmr.config.js')]);
    assert.match(out, /--strict/);
  });

  it('marks the notice as failing in JSON under --strict', async () => {
    const { out } = await run(['--json', '--strict', fixture('deprecated-hmr.config.js')]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.strict, true);
    assert.equal(parsed.findings[0].fails, true);
    assert.equal(parsed.summary.exitCode, 1);
  });
});

describe('--json', () => {
  it('emits a parseable object with the documented shape', async () => {
    const { code, out } = await run(['--json', fixture('ws-false-hmr-port.config.js')]);
    assert.equal(code, 1);

    const parsed = JSON.parse(out);
    assert.equal(parsed.tool, 'vite-hmr-doctor');
    assert.equal(parsed.configFile, fixture('ws-false-hmr-port.config.js'));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.strict, false);
    assert.equal(typeof parsed.resolution.mode, 'string');
    assert.equal(typeof parsed.resolution.viteAvailable, 'boolean');
    assert.equal(parsed.summary.failures, 1);
    assert.equal(parsed.summary.exitCode, 1);
    assert.equal(parsed.findings.length, 1);

    const [finding] = parsed.findings;
    assert.deepEqual(
      Object.keys(finding).sort(),
      ['detail', 'fails', 'id', 'message', 'option', 'severity'],
    );
    assert.equal(finding.id, 'ws-false-drops-hmr-options');
    assert.equal(finding.severity, 'warning');
    assert.equal(finding.fails, true);
  });

  it('reports ok:true and exitCode 0 for a clean config', async () => {
    const { out } = await run(['--json', fixture('clean.config.js')]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.findings, []);
    assert.equal(parsed.summary.exitCode, 0);
  });

  it('marks deprecations as non-failing without --strict', async () => {
    const { out } = await run(['--json', fixture('deprecated-hmr.config.js')]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.findings[0].severity, 'info');
    assert.equal(parsed.findings[0].fails, false);
    assert.equal(parsed.summary.failures, 0);
  });

  it('emits no ANSI colour codes', async () => {
    const { out } = await run(['--json', fixture('ws-false-hmr-port.config.js')]);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\u001b\[/);
  });
});

describe('colour handling', () => {
  it('honours NO_COLOR', () => {
    assert.equal(shouldUseColour({ isTTY: true }, { NO_COLOR: '1' }), false);
    assert.equal(shouldUseColour({ isTTY: true }, {}), true);
  });

  it('degrades when not a TTY', () => {
    assert.equal(shouldUseColour({ isTTY: false }, {}), false);
    assert.equal(shouldUseColour(undefined, {}), false);
  });

  it('emits no escape codes in the captured non-TTY output', async () => {
    const { out } = await run([fixture('ws-false-hmr-port.config.js')]);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\u001b\[/);
  });
});

describe('exitCodeFor and formatJson', () => {
  it('fails only on warnings, plus info under strict', () => {
    const findings = [
      { id: 'a', severity: 'info', option: 'x', message: 'm', detail: 'd' },
      { id: 'b', severity: 'warning', option: 'y', message: 'm', detail: 'd' },
    ];
    assert.equal(exitCodeFor(findings, false), 1);
    assert.equal(exitCodeFor(findings, true), 1);
    assert.equal(exitCodeFor([findings[0]], false), 0);
    assert.equal(exitCodeFor([findings[0]], true), 1);
    assert.equal(exitCodeFor([], false), 0);
  });

  it('produces stable, re-parseable JSON', () => {
    const result = {
      file: '/tmp/vite.config.js',
      mode: 'import',
      viteAvailable: false,
      findings: [],
      strict: false,
      exitCode: 0,
    };
    assert.deepEqual(JSON.parse(formatJson(result)), {
      tool: 'vite-hmr-doctor',
      configFile: '/tmp/vite.config.js',
      resolution: { mode: 'import', viteAvailable: false },
      strict: false,
      ok: true,
      findings: [],
      summary: { findings: 0, failures: 0, exitCode: 0 },
    });
  });
});

describe('CLI entry file', () => {
  it('is executable through node directly', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const runFile = promisify(execFile);
    const bin = join(here, '..', 'bin', 'vite-hmr-doctor.js');

    await assert.rejects(
      runFile(process.execPath, [bin, fixture('ws-false-hmr-port.config.js')]),
      (error) => error.code === 1,
      'a finding must surface as exit code 1',
    );

    const { stdout } = await runFile(process.execPath, [bin, fixture('clean.config.js')]);
    assert.match(stdout, /Summary: 0 findings/);
  });

  it('declares a shebang so the bin works as an executable', () => {
    const bin = join(here, '..', 'bin', 'vite-hmr-doctor.js');
    assert.match(readFileSync(bin, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node$/);
  });
});

describe('decoy fixtures produce no findings', () => {
  // End-to-end guard for the source-text scanner: a `, hmr:` inside a comment or
  // a string must never surface as a finding.
  const decoys = [
    'decoy-hmr-string.config.js',
    'decoy-hmr-comment.config.js',
    'decoy-hmr-template.config.js',
  ];

  for (const name of decoys) {
    it(`reports nothing, exit 0, for ${name}`, async () => {
      const { code, out } = await run([fixture(name), '--no-vite']);
      assert.equal(code, 0, 'a decoy must not fail the run');
      assert.match(out, /Summary: 0 findings/);
    });
  }
});

describe('nested decoys at depth > 0 produce no findings', () => {
  // Regression: an `hmr:` (or `ws:`) nested inside a plugin/helper object or a
  // list element is not `server.hmr` / `server.ws`. These fixtures run through
  // Vite's importer path when it loads, so the static scanner is exercised
  // directly as well (see `resolve.test.js`).
  const nested = [
    'decoy-hmr-nested-plugin.config.js',
    'decoy-hmr-nested-array.config.js',
    'decoy-hmr-nested-object.config.js',
    'decoy-ws-nested.config.js',
  ];

  for (const name of nested) {
    it(`reports nothing, exit 0, for ${name}`, async () => {
      const { code, out } = await run([fixture(name), '--no-vite']);
      assert.equal(code, 0, 'a nested decoy must not fail the run');
      assert.match(out, /Summary: 0 findings/);
    });
  }
});

describe('positive controls still report real nested-adjacent config', () => {
  it('still finds a real top-level server.hmr.port with ws: false', async () => {
    const { code, out } = await run([fixture('ws-false-hmr-nested-ok.config.js'), '--no-vite']);
    assert.equal(code, 1, 'real dead config must still fail');
    assert.match(out, /server\.hmr\.port/);
  });
});
