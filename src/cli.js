/**
 * Command-line interface for vite-hmr-doctor.
 *
 * Responsibilities: parse arguments, run the resolved config through the pure
 * checks, render human or JSON output, and choose the exit code.
 *
 * Exit codes: 0 clean, 1 problems found, 2 usage or config error.
 */

import { ConfigError, findConfigFile, resolveServerConfig } from './resolve.js';
import { runChecks } from './checks.js';

const EXIT_CLEAN = 0;
const EXIT_FOUND_PROBLEMS = 1;
const EXIT_USAGE_ERROR = 2;

const USAGE = `vite-hmr-doctor - find Vite server.hmr / server.ws config that is silently ignored

Usage:
  vite-hmr-doctor [path] [options]

Arguments:
  path                 A vite.config.{js,mjs,ts,cts,mts} file, or a project
                       directory to search. Defaults to the current directory.

Options:
  --json               Print machine-readable JSON instead of human output.
  --strict             Treat deprecation notices (check 3) as failures.
  --no-vite            Skip Vite; use static/import analysis only.
  -h, --help           Show this help.
  -v, --version        Show the version.

Exit codes:
  0  clean
  1  problems found
  2  usage or config error`;

/**
 * @typedef {object} CliOptions
 * @property {string} path
 * @property {boolean} json
 * @property {boolean} strict
 * @property {boolean} preferVite
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * Parse argv (without the leading node/script entries).
 *
 * @param {string[]} argv
 * @returns {CliOptions}
 * @throws {ConfigError} On unknown flags or extra positionals.
 */
export function parseArgs(argv) {
  /** @type {CliOptions} */
  const options = {
    path: '.',
    json: false,
    strict: false,
    preferVite: true,
    help: false,
    version: false,
  };
  let pathSeen = false;

  for (const arg of argv) {
    if (arg === '--') {
      throw new ConfigError('The "--" separator is not supported; pass a single path.');
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--no-vite') {
      options.preferVite = false;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if (arg.startsWith('-')) {
      throw new ConfigError(`Unknown option: ${arg}`);
    } else if (pathSeen) {
      throw new ConfigError(`Unexpected extra argument: ${arg} (only one path is supported).`);
    } else {
      options.path = arg;
      pathSeen = true;
    }
  }

  return options;
}

/** Colour support: no colour off a TTY, or when NO_COLOR is set. */
function makeColour(enabled) {
  const wrap = (code) => (text) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    yellow: wrap('33'),
    blue: wrap('34'),
    green: wrap('32'),
  };
}

/**
 * Decide whether colour should be used.
 *
 * @param {{ isTTY?: boolean }|undefined} stream
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
export function shouldUseColour(stream, env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return Boolean(stream && stream.isTTY);
}

const MODE_LABELS = Object.freeze({
  vite: 'resolved with Vite resolveConfig',
  import: 'loaded by import (the config evaluated)',
  static: 'read statically from source (no import, no vite)',
});

/**
 * Render findings as human-readable text.
 *
 * @param {object} result
 * @param {string} result.file
 * @param {string} result.mode
 * @param {import('./checks.js').Finding[]} result.findings
 * @param {boolean} result.strict
 * @param {boolean} colour
 * @returns {string}
 */
export function formatHuman(result, colour) {
  const c = makeColour(colour);
  const { findings, file, mode, strict } = result;

  const failing = findings.filter(
    (finding) => finding.severity === 'warning' || (strict && finding.severity === 'info'),
  );

  const icon = { warning: c.yellow('!'), info: c.blue('i'), error: c.red('x') };
  const header = [
    `${c.bold('vite-hmr-doctor')}  ${c.dim(file)}`,
    c.dim(`  ${MODE_LABELS[mode] ?? mode}`),
    '',
  ];

  const summaryLine =
    `${c.bold('Summary:')} ${findings.length} finding${findings.length === 1 ? '' : 's'}, ` +
    `${failing.length} failure${failing.length === 1 ? '' : 's'}${strict ? ' (--strict)' : ''}.`;

  if (findings.length === 0) {
    return [
      ...header,
      `${c.green('OK')}  no ignored server.hmr / server.ws configuration found.`,
      '',
      `${c.bold('Summary:')} 0 findings, 0 failures.`,
    ].join('\n');
  }

  const rendered = findings.map((finding) => {
    const counts = strict && finding.severity === 'info';
    return [
      `${icon[finding.severity] ?? '-'} ${c.bold(finding.message)}`,
      `  ${c.dim('option:')} ${finding.option}`,
      `  ${c.dim('check:')}  ${finding.id}${counts ? c.dim(' (fails under --strict)') : ''}`,
      `  ${finding.detail}`,
      '',
    ].join('\n');
  });

  return [...header, rendered.join('\n').trimEnd(), '', summaryLine].join('\n');
}

/**
 * Render findings as JSON.
 *
 * @param {object} result
 * @param {string} result.file
 * @param {string} result.mode
 * @param {boolean} result.viteAvailable
 * @param {import('./checks.js').Finding[]} result.findings
 * @param {boolean} result.strict
 * @param {number} result.exitCode
 * @returns {string}
 */
export function formatJson(result) {
  const { findings, file, mode, viteAvailable, strict, exitCode } = result;

  const failing = findings.filter(
    (finding) => finding.severity === 'warning' || (strict && finding.severity === 'info'),
  );

  return JSON.stringify(
    {
      tool: 'vite-hmr-doctor',
      configFile: file,
      resolution: { mode, viteAvailable },
      strict,
      ok: failing.length === 0,
      findings: findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        option: finding.option,
        message: finding.message,
        detail: finding.detail,
        fails: finding.severity === 'warning' || (strict && finding.severity === 'info'),
      })),
      summary: {
        findings: findings.length,
        failures: failing.length,
        exitCode,
      },
    },
    null,
    2,
  );
}

/** Compute the exit code for a set of findings. */
export function exitCodeFor(findings, strict) {
  const failing = findings.filter(
    (finding) => finding.severity === 'warning' || (strict && finding.severity === 'info'),
  );
  return failing.length > 0 ? EXIT_FOUND_PROBLEMS : EXIT_CLEAN;
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv Arguments after the script name.
 * @param {{ stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, env: NodeJS.ProcessEnv,
 *   version: string }} io
 * @returns {Promise<number>} The exit code.
 */
export async function main(argv, io) {
  const { stdout, stderr, env, version } = io;

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`error: ${error.message}\n\n${USAGE}\n`);
    return EXIT_USAGE_ERROR;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT_CLEAN;
  }

  if (options.version) {
    stdout.write(`${version}\n`);
    return EXIT_CLEAN;
  }

  let resolved;
  try {
    const file = findConfigFile(options.path);
    resolved = await resolveServerConfig(file, { preferVite: options.preferVite });
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`error: ${error.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error: could not read config: ${message}\n`);
    return EXIT_USAGE_ERROR;
  }

  let findings;
  try {
    findings = runChecks(resolved.server, resolved.source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error: internal check failure: ${message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const exitCode = exitCodeFor(findings, options.strict);
  const result = {
    file: resolved.file,
    mode: resolved.mode,
    viteAvailable: resolved.viteAvailable,
    findings,
    strict: options.strict,
    exitCode,
  };

  const colour = shouldUseColour(options.json ? null : stdout, env);
  stdout.write(`${options.json ? formatJson(result) : formatHuman(result, colour)}\n`);

  return exitCode;
}
