/**
 * Config loading and resolution for vite-hmr-doctor.
 *
 * Preferred path: load the config through Vite's own `resolveConfig`, which is
 * authoritative. We deliberately use `configFile: false` so Vite loads only the
 * user's file and does not merge our own (empty) inline config on top of it.
 *
 * Fallback path: static analysis. The user's config file is imported (or, when
 * that fails, parsed as text) so the tool still works with zero dependencies
 * and no `vite` install.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { maskCommentsAndStrings } from './mask.js';

/** Filenames Vite recognises, in Vite's own priority order. */
export const CONFIG_FILENAMES = Object.freeze([
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cts',
  'vite.config.mts',
]);

/** Error raised for anything the user can fix: bad path, no config, bad config. */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ConfigError';
  }
}

/** True when `value` is a non-null, non-array object. */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a CLI-supplied path to a Vite config file.
 *
 * Accepts either a config file or a project directory. A directory is searched
 * for the recognised config filenames.
 *
 * @param {string} input Raw path from the command line.
 * @returns {string} Absolute path to an existing config file.
 * @throws {ConfigError} When the path is missing, unreadable, or has no config.
 */
export function findConfigFile(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ConfigError('No path given. Pass a Vite config file or a project directory.');
  }

  const target = resolvePath(process.cwd(), input);

  if (!existsSync(target)) {
    throw new ConfigError(`Path does not exist: ${target}`);
  }

  const stats = statSync(target);

  if (stats.isFile()) return target;

  if (stats.isDirectory()) {
    const found = CONFIG_FILENAMES.map((name) => join(target, name)).find((candidate) =>
      existsSync(candidate),
    );
    if (found) return found;
    throw new ConfigError(
      `No Vite config found in ${target}. Looked for: ${CONFIG_FILENAMES.join(', ')}.`,
    );
  }

  throw new ConfigError(`Path is neither a file nor a directory: ${target}`);
}

/**
 * Import a config file with a cache-busting query so repeated runs in one
 * process see the current file contents.
 *
 * @param {string} filePath
 * @returns {Promise<unknown>} The config export, unwrapped from `default`.
 */
async function importConfigFile(filePath) {
  const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const module = await import(url);
  return 'default' in module ? module.default : module;
}

/**
 * Extract the `server` block from a config export, resolving a function or a
 * promise the way Vite would.
 *
 * @param {unknown} exported
 * @returns {Promise<unknown>} The raw `server` config (may be undefined).
 */
async function resolveServerBlock(exported) {
  const awaited = await exported;
  const picked = typeof awaited === 'function' ? await awaited({ command: 'serve', mode: 'development' }) : awaited;
  if (!isPlainObject(picked)) return undefined;
  return picked.server;
}

/**
 * Best-effort static extraction of the `server` object from config source text.
 *
 * Used only when importing the config fails outright (for example a `.ts`
 * config with no TypeScript loader available). This never evaluates the config:
 * it locates the `server: { ... }` block by brace matching and reports the
 * option names it can see. The values cannot be known without running the file,
 * so options are reported as present-but-unknown, which is enough for the
 * "was this option set at all?" checks this tool performs.
 *
 * @param {string} source
 * @returns {object|null} A `{ server: {...} }` shape, or `null` when no server
 *   block can be located.
 */
export function extractServerFromSource(source) {
  if (typeof source !== 'string') return null;

  // Mask comments and strings *once*, up front, and do everything downstream
  // against the masked text. Masking preserves length and newlines, so offsets
  // computed here still line up with `source`.
  //
  // Two bugs are closed by masking before body extraction rather than after:
  //   1. A `, hmr:` (or `, ws:`) inside a comment or string would otherwise be
  //      read as real configuration and the tool would invent a finding.
  //   2. `readBraceBody` counts *raw* braces, so a `}` inside a string or
  //      comment within the server block would mis-terminate the body. Blanking
  //      those characters first means only structural braces remain.
  const masked = maskCommentsAndStrings(source);

  const match = /\bserver\s*:\s*\{/.exec(masked);
  if (match === null) return null;

  const openBrace = masked.indexOf('{', match.index);
  const body = readBraceBody(masked, openBrace);
  if (body === null) return null;

  const hmrMatch = matchTopLevelEntry(body, 'hmr');
  /** @type {Record<string, unknown>} */
  const server = {};

  const wsMatch = matchTopLevelValue(body, 'ws', /^(false|true)\b/);
  if (wsMatch !== null) server.ws = wsMatch.value === 'true';

  if (hmrMatch !== null) {
    server.hmr = readHmrValue(hmrMatch.rest);
  }

  return { server };
}

/**
 * Find the first `name:` entry that is a *direct* property of a brace body.
 *
 * The static scanner is not a JavaScript parser, so it must not read a nested
 * `hmr:` (for example one belonging to an object inside a `plugins` array) as
 * if it were `server.hmr`. A flat regex cannot tell the two apart: masking
 * blanks strings and comments but *preserves* the structural `{ } [ ]`
 * characters, so `plugins: [{ name: 'p', hmr: { port: 1 } }]` still contains a
 * literal `, hmr:` at what looks like a comma-preceded position.
 *
 * Depth is therefore tracked explicitly while scanning the masked body, and a
 * match is accepted only when both the brace and bracket depth are zero. Each
 * character is measured against the *masked* text, which is safe: masking
 * blanks the contents of strings, comments, and template literals, so any
 * brace or bracket inside them is already gone (verified in `test/`).
 *
 * @param {string} body A masked brace body (the text between `server: {` and
 *   its matching `}`).
 * @param {string} name The property name to find, e.g. `hmr`.
 * @returns {{ rest: string }|null} The text after `name:`, or null when the
 *   name is not a top-level property.
 */
function matchTopLevelEntry(body, name) {
  let depth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];

    if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
    } else if (depth === 0 && char === ':') {
      // Walk back over the `name` and any whitespace before this colon.
      let start = index - 1;
      while (start >= 0 && /\s/.test(body[start])) start -= 1;
      const end = start;
      while (start >= 0 && /[\w$]/.test(body[start])) start -= 1;
      const key = body.slice(start + 1, end + 1);

      if (key === name) {
        // Accept only when the key sits at a property boundary — `{ hmr:` or
        // `, hmr:` — never when it is the tail of a longer identifier such as
        // `vite-hmr:` or `my_hmr:`. Whitespace between the boundary and the
        // key is allowed (and is the common case).
        const before = body.slice(0, start + 1).trimEnd();
        const boundary = before[before.length - 1];
        const atBoundary = before === '' || boundary === '{' || boundary === ',';
        if (atBoundary) {
          return { rest: body.slice(index + 1).trim() };
        }
      }
    }
  }

  return null;
}

/**
 * Find a top-level `name:` entry whose value matches `valuePattern`.
 *
 * @param {string} body Masked brace body.
 * @param {string} name Property name, e.g. `ws`.
 * @param {RegExp} valuePattern Anchored pattern for the literal value.
 * @returns {{ value: string }|null}
 */
function matchTopLevelValue(body, name, valuePattern) {
  const entry = matchTopLevelEntry(body, name);
  if (entry === null) return null;
  const match = valuePattern.exec(entry.rest);
  return match === null ? null : { value: match[1] };
}

/**
 * Return the text between `openBrace` and its matching close, or null.
 *
 * @param {string} source
 * @param {number} openBrace
 * @returns {string|null}
 */
function readBraceBody(source, openBrace) {
  if (openBrace === -1) return null;

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }

  return null;
}

/**
 * Read the `hmr:` value: either the literal `false`, or an object whose keys we
 * report with a sentinel value.
 *
 * @param {string} text Source starting at the hmr value.
 * @returns {unknown}
 */
function readHmrValue(text) {
  if (/^false\b/.test(text)) return false;
  if (/^true\b/.test(text)) return true;

  const openBrace = text.indexOf('{');
  if (openBrace === -1 || openBrace > text.search(/[,}]/)) return undefined;

  const body = readBraceBody(text, openBrace);
  if (body === null) return undefined;

  const keys = (body.match(/[A-Za-z_$][\w$]*\s*:/g) ?? []).map((entry) =>
    entry.slice(0, entry.indexOf(':')).trim(),
  );

  return Object.fromEntries(keys.map((key) => [key, null]));
}

/**
 * Load Vite as the *user's project* would see it.
 *
 * A bare `import('vite')` resolves relative to this file, which is inside
 * vite-hmr-doctor's own tree: a `vite` installed in the project being checked
 * would never be found. Resolution is therefore anchored at the config file.
 *
 * `createRequire(...).resolve` is deliberately NOT used: it selects the
 * `require` export condition, which for Vite maps to the deprecated CJS build
 * whose `resolveConfig` is unavailable. Resolving from a file URL honours the
 * `import` condition, matching a real ESM config load.
 *
 * @param {string} filePath The config file being checked.
 * @returns {Promise<object>} The vite module namespace.
 * @throws {ConfigError} When `vite` cannot be resolved or imported.
 */
async function importViteFor(filePath) {
  const projectDir = dirname(filePath);

  let packageJson;
  try {
    packageJson = JSON.parse(
      readFileSync(createRequire(join(projectDir, 'noop.js')).resolve('vite/package.json'), 'utf8'),
    );
  } catch (error) {
    throw new ConfigError('vite is not installed', { cause: error });
  }

  const esmEntry = resolveViteEsmEntry(packageJson);
  if (esmEntry === null) {
    throw new ConfigError(
      'vite is installed but its ESM entry point could not be determined.',
    );
  }

  const requireFromProject = createRequire(join(projectDir, 'noop.js'));
  const viteRoot = dirname(requireFromProject.resolve('vite/package.json'));
  const specifier = pathToFileURL(join(viteRoot, esmEntry)).href;

  try {
    return await import(specifier);
  } catch (error) {
    throw new ConfigError(
      `Found vite but could not import it from ${projectDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * Pick the ESM entry from a Vite package.json, honouring the `import` export
 * condition. `require.resolve` alone would select the deprecated CJS build,
 * which does not expose `resolveConfig`.
 *
 * @param {unknown} packageJson Parsed vite package.json.
 * @returns {string|null} Path relative to the package, or null if undeterminable.
 */
export function resolveViteEsmEntry(packageJson) {
  if (!isPlainObject(packageJson)) return null;

  const root = packageJson.exports?.['.'];
  const imported = root?.import ?? root;
  const fromCondition =
    typeof imported === 'string' ? imported : imported?.default ?? imported?.node;

  if (typeof fromCondition === 'string') return fromCondition;
  if (typeof packageJson.module === 'string') return packageJson.module;
  return null;
}

/**
 * Load a config file through Vite's own `resolveConfig`.
 *
 * `configFile` must point at the user's file: `configFile: false` tells Vite
 * there is no config file at all, which silently skips it and yields only
 * defaults. The `root` is the config's directory so relative paths resolve the
 * way they would in the project.
 *
 * No inline `server` block is passed, so nothing is merged over what the user
 * wrote and the returned `server` reflects the file as-is.
 *
 * @param {string} filePath
 * @returns {Promise<{ server: unknown, mode: 'vite' }>}
 * @throws {ConfigError} When `vite` is unavailable or the config cannot load.
 */
export async function loadWithVite(filePath) {
  const vite = await importViteFor(filePath);

  try {
    const resolved = await vite.resolveConfig(
      { configFile: filePath, root: dirname(filePath) },
      'serve',
    );
    return { server: resolved.server, mode: 'vite' };
  } catch (error) {
    throw new ConfigError(
      `Vite could not load ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Load a config file without Vite: import it, then fall back to text analysis.
 *
 * @param {string} filePath
 * @returns {Promise<{ server: unknown, mode: 'import'|'static' }>}
 */
export async function loadWithoutVite(filePath) {
  try {
    const exported = await importConfigFile(filePath);
    return { server: await resolveServerBlock(exported), mode: 'import' };
  } catch (importError) {
    let source;
    try {
      source = readFileSync(filePath, 'utf8');
    } catch (readError) {
      throw new ConfigError(`Could not read ${filePath}: ${readError.message}`, {
        cause: readError,
      });
    }

    const extracted = extractServerFromSource(source);
    if (extracted === null) {
      throw new ConfigError(
        `Could not load ${filePath} (${importError.message}) and could not read a ` +
          `literal server block from it. Install "vite" for full resolution.`,
        { cause: importError },
      );
    }
    return { server: extracted.server, mode: 'static' };
  }
}

/**
 * Resolve a config file to its server options, preferring Vite.
 *
 * @param {string} filePath Absolute path to a config file.
 * @param {{ preferVite?: boolean }} [options]
 * @returns {Promise<{ server: unknown, mode: 'vite'|'import'|'static', file: string,
 *   viteAvailable: boolean }>}
 * @throws {ConfigError} On unreadable or unloadable config.
 */
export async function resolveServerConfig(filePath, options = {}) {
  const { preferVite = true } = options;

  if (preferVite) {
    try {
      const { server } = await loadWithVite(filePath);
      return { server, mode: 'vite', file: filePath, viteAvailable: true, source: readSource(filePath) };
    } catch (viteError) {
      // Vite being absent is the obvious case. But a Vite that *is* installed and
      // still cannot load the config (syntax error, TS with no loader) must also
      // degrade to the importer/static fallback rather than aborting: the static
      // path exists precisely for configs Vite cannot evaluate, and it can still
      // report a legible `server: { ... }` block. Only a genuine static failure
      // is fatal, and `loadWithoutVite` raises that itself.
      const viteAbsent =
        viteError instanceof ConfigError && viteError.message === 'vite is not installed';
      try {
        const { server, mode } = await loadWithoutVite(filePath);
        return {
          server,
          mode,
          file: filePath,
          viteAvailable: !viteAbsent,
          source: readSource(filePath),
        };
      } catch (fallbackError) {
        if (viteAbsent) throw fallbackError;
        throw new ConfigError(
          `${fallbackError.message} (vite also failed: ${viteError.message})`,
          { cause: fallbackError },
        );
      }
    }
  }

  const { server, mode } = await loadWithoutVite(filePath);
  return { server, mode, file: filePath, viteAvailable: false, source: readSource(filePath) };
}

/**
 * Read config source text for source-level analysis (duplicate keys).
 * A read failure is not fatal: source analysis is a bonus, and the checks that
 * do not need source text still run.
 *
 * @param {string} filePath
 * @returns {string|undefined}
 */
function readSource(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    process.stderr.write(
      `warning: could not read ${filePath} as text for source analysis: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return undefined;
  }
}
