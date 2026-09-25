/**
 * Tests for config discovery, caching-free loading, and the two resolution
 * paths (Vite's `resolveConfig`, and the static/importer fallback).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  CONFIG_FILENAMES,
  ConfigError,
  extractServerFromSource,
  findConfigFile,
  resolveServerConfig,
  resolveViteEsmEntry,
} from '../src/resolve.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');
const fixture = (name) => join(FIXTURES, name);

let scratch = [];

/** Create a temp directory that is cleaned up after the run. */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vhd-'));
  scratch = [...scratch, dir];
  return dir;
}

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('findConfigFile', () => {
  it('accepts a config file path directly', () => {
    assert.equal(findConfigFile(fixture('clean.config.js')), fixture('clean.config.js'));
  });

  it('finds a config inside a directory', () => {
    const dir = makeTempDir();
    const config = join(dir, 'vite.config.mjs');
    writeFileSync(config, 'export default {};\n');
    assert.equal(findConfigFile(dir), config);
  });

  it('prefers the first recognised filename when several exist', () => {
    const dir = makeTempDir();
    for (const name of CONFIG_FILENAMES) writeFileSync(join(dir, name), 'export default {};\n');
    assert.equal(findConfigFile(dir), join(dir, 'vite.config.js'));
  });

  it('resolves a relative path against the working directory', () => {
    assert.equal(findConfigFile('fixtures/clean.config.js'), fixture('clean.config.js'));
  });

  it('finds a config in a relative directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'vite.config.js'), 'export default {};\n');
    const relative = dir.replace(`${process.cwd()}/`, '');
    assert.equal(findConfigFile(relative), join(dir, 'vite.config.js'));
  });

  it('resolves an absolute path unchanged', () => {
    assert.equal(findConfigFile(fixture('clean.config.js')), fixture('clean.config.js'));
  });

  it('throws a ConfigError for a missing path', () => {
    assert.throws(() => findConfigFile(fixture('nope.config.js')), ConfigError);
    assert.throws(() => findConfigFile(fixture('nope.config.js')), /does not exist/);
  });

  it('throws a ConfigError for a directory with no config', () => {
    const dir = makeTempDir();
    assert.throws(() => findConfigFile(dir), /No Vite config found/);
    assert.throws(() => findConfigFile(dir), new RegExp(CONFIG_FILENAMES[0]));
  });

  it('rejects empty or non-string input at the boundary', () => {
    assert.throws(() => findConfigFile(''), /No path given/);
    assert.throws(() => findConfigFile('   '), /No path given/);
    assert.throws(() => findConfigFile(undefined), /No path given/);
  });
});

describe('resolveServerConfig', () => {
  it('loads a valid config and reports how it was loaded', async () => {
    const result = await resolveServerConfig(fixture('ws-false-hmr-port.config.js'));
    assert.equal(result.file, fixture('ws-false-hmr-port.config.js'));
    assert.ok(['vite', 'import', 'static'].includes(result.mode));
    assert.equal(typeof result.viteAvailable, 'boolean');
    // The server block must survive either way.
    assert.equal(result.server.ws, false);
    assert.equal(result.server.hmr.port, 5173);
  });

  it('uses the importer when --no-vite is requested', async () => {
    const result = await resolveServerConfig(fixture('clean.config.js'), { preferVite: false });
    assert.equal(result.mode, 'import');
    assert.equal(result.viteAvailable, false);
    assert.deepEqual(result.server.ws, { port: 5174 });
  });

  it('reads the config through Vite when vite is installed', async () => {
    const result = await resolveServerConfig(fixture('ws-false-hmr-port.config.js'));
    if (result.mode !== 'vite') return; // documented fallback when vite is absent
    assert.equal(result.viteAvailable, true);
    assert.equal(result.server.hmr.port, 5173);
  });

  it('returns source text for source-level checks', async () => {
    const result = await resolveServerConfig(fixture('hmr-false-with-options.config.js'));
    assert.match(result.source, /hmr: false/);
  });

  it('does not mutate the module it imported', async () => {
    const first = await resolveServerConfig(fixture('clean.config.js'));
    const snapshot = JSON.stringify(first.server);
    await resolveServerConfig(fixture('clean.config.js'));
    assert.equal(JSON.stringify(first.server), snapshot);
  });

  it('throws a ConfigError for an unloadable config with no server block', async () => {
    await assert.rejects(
      resolveServerConfig(fixture('unreadable.config.js')),
      ConfigError,
    );
  });

  it('surfaces a helpful message for an unloadable config', async () => {
    await assert.rejects(
      resolveServerConfig(fixture('unreadable.config.js')),
      /Could not load/,
    );
  });

  it('reports mode "static" when the config cannot be imported', async () => {
    // Regression: with `preferVite: false`, the mode used to be hardcoded to
    // 'import' even when the static scanner was the thing that actually ran.
    // A config that throws on import forces the static path.
    const dir = makeTempDir();
    const config = join(dir, 'vite.config.js');
    writeFileSync(
      config,
      "throw new Error('nope');\nexport default { server: { ws: false, hmr: { port: 5173 } } };\n",
    );

    const result = await resolveServerConfig(config, { preferVite: false });
    assert.equal(result.mode, 'static');
    assert.equal(result.viteAvailable, false);
    // The static path cannot know values, so they arrive as null sentinels.
    assert.equal(result.server.hmr.port, null);
  });

  it('reports mode "import" when the config imports cleanly', async () => {
    const result = await resolveServerConfig(fixture('clean.config.js'), { preferVite: false });
    assert.equal(result.mode, 'import');
  });
});

describe('resolveViteEsmEntry', () => {
  it('prefers the import condition of the root export', () => {
    assert.equal(
      resolveViteEsmEntry({ exports: { '.': { import: './dist/node/index.js', require: './index.cjs' } } }),
      './dist/node/index.js',
    );
  });

  it('accepts a bare string root export', () => {
    assert.equal(resolveViteEsmEntry({ exports: { '.': './dist/index.js' } }), './dist/index.js');
  });

  it('falls back through default and node conditions', () => {
    assert.equal(
      resolveViteEsmEntry({ exports: { '.': { import: { default: './a.js', node: './b.js' } } } }),
      './a.js',
    );
    assert.equal(resolveViteEsmEntry({ exports: { '.': { import: { node: './b.js' } } } }), './b.js');
  });

  it('falls back to the module field, then gives up', () => {
    assert.equal(resolveViteEsmEntry({ module: './esm.js' }), './esm.js');
    assert.equal(resolveViteEsmEntry({}), null);
    assert.equal(resolveViteEsmEntry(undefined), null);
  });

  it('never selects the CJS entry when an import condition exists', () => {
    const chosen = resolveViteEsmEntry({
      main: './index.cjs',
      exports: { '.': { import: './dist/node/index.js', require: './index.cjs' } },
    });
    assert.equal(chosen, './dist/node/index.js');
    assert.notEqual(chosen, './index.cjs');
  });
});

describe('Vite resolveConfig integration (skipped without vite)', () => {
  /**
   * Locate a vite install to link into a temp project.
   *
   * Resolution order, so a fresh clone on a machine with vite installed in the
   * usual place runs these tests without editing any file:
   *   1. `VHD_TEST_VITE` — explicit override, for CI pointing at a specific install.
   *   2. `require.resolve('vite')` from this test file, then from cwd.
   *   3. `node_modules/vite` under cwd, then under this package's root.
   * Every candidate is accepted only if it has a package.json, so a bogus
   * override cannot make the suite link nonsense.
   *
   * @returns {string|null} Absolute path to a vite package dir, or null.
   */
  function findVite() {
    const isViteDir = (candidate) =>
      typeof candidate === 'string' &&
      candidate !== '' &&
      existsSync(join(candidate, 'package.json'));

    const fromResolve = (base) => {
      try {
        // Resolve the package dir, not the entry: we symlink the whole package.
        return dirname(createRequire(base).resolve('vite/package.json'));
      } catch {
        return null;
      }
    };

    const candidates = [
      process.env.VHD_TEST_VITE,
      fromResolve(import.meta.url),
      fromResolve(join(process.cwd(), 'noop.js')),
      join(process.cwd(), 'node_modules', 'vite'),
      join(here, '..', 'node_modules', 'vite'),
    ];

    return candidates.find(isViteDir) ?? null;
  }

  /**
   * Skip a test loudly enough to notice but not noisily: one clear line naming
   * what was not exercised and how to enable it.
   */
  function skipNoVite(t) {
    t.diagnostic(
      'vite-hmr-doctor: Vite resolveConfig integration tests NOT RUN — no vite install ' +
        'reachable, so only the static fallback is covered. Install vite (or set ' +
        'VHD_TEST_VITE=/path/to/node_modules/vite) to exercise the Vite resolution path.',
    );
    t.skip('no vite install reachable; static fallback only');
  }

  it('reports the ws:false + hmr.port drop through Vite resolution', async (t) => {
    const vitePath = findVite();
    if (vitePath === null) {
      skipNoVite(t);
      return;
    }

    const project = makeTempDir();
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    symlinkSync(vitePath, join(project, 'node_modules', 'vite'), 'dir');
    const config = join(project, 'vite.config.js');
    writeFileSync(
      config,
      'export default { server: { ws: false, hmr: { port: 5173 } } };\n',
    );

    const result = await resolveServerConfig(config);
    assert.equal(result.mode, 'vite', 'vite must be used when it is installed');
    assert.equal(result.viteAvailable, true);
    assert.equal(result.server.ws, false);
    // Vite keeps hmr.port in memory even though it never applies it.
    assert.equal(result.server.hmr.port, 5173);

    const { runChecks } = await import('../src/checks.js');
    assert.deepEqual(
      runChecks(result.server, result.source).map((finding) => finding.id),
      ['ws-false-drops-hmr-options'],
    );
  });

  it('stays clean for a correct config through Vite resolution', async (t) => {
    const vitePath = findVite();
    if (vitePath === null) {
      skipNoVite(t);
      return;
    }

    const project = makeTempDir();
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    symlinkSync(vitePath, join(project, 'node_modules', 'vite'), 'dir');
    const config = join(project, 'vite.config.js');
    writeFileSync(config, 'export default { server: { port: 5173, ws: { port: 5174 } } };\n');

    const result = await resolveServerConfig(config);
    assert.equal(result.mode, 'vite');
    const { runChecks } = await import('../src/checks.js');
    assert.deepEqual(runChecks(result.server, result.source), []);
  });
});

describe('extractServerFromSource', () => {
  it('reads a literal server block without evaluating it', () => {
    const extracted = extractServerFromSource('export default { server: { ws: false } };');
    assert.equal(extracted.server.ws, false);
  });

  it('reports hmr option names as present with unknown values', () => {
    const extracted = extractServerFromSource(
      'export default { server: { ws: false, hmr: { port: 5173, host: "x" } } };',
    );
    assert.deepEqual(Object.keys(extracted.server.hmr).sort(), ['host', 'port']);
  });

  it('reads hmr: false', () => {
    const extracted = extractServerFromSource('export default { server: { hmr: false } };');
    assert.equal(extracted.server.hmr, false);
  });

  it('returns null when there is no server block', () => {
    assert.equal(extractServerFromSource('export default { build: {} };'), null);
    assert.equal(extractServerFromSource(''), null);
    assert.equal(extractServerFromSource(undefined), null);
  });

  it('never executes the source it inspects', () => {
    // A side effect would throw or set a global if the text were evaluated.
    const source = 'export default { server: { ws: false }, side: (() => { throw new Error("executed"); })() };';
    const extracted = extractServerFromSource(source);
    assert.equal(extracted.server.ws, false);
  });
});

describe('extractServerFromSource masks decoys', () => {
  // Regression: a `, hmr:` that only appears inside a comment, a quoted string,
  // or a template literal is not configuration. Before masking was applied, the
  // scanner read it as a real `server.hmr` block and the tool invented a
  // finding — falsifying its documented "cannot invent a problem" guarantee.
  const decoys = {
    'a single-quoted string': `export default { server: { ws: false, note: ', hmr: { clientPort: 443 }' } };`,
    'a double-quoted string': `export default { server: { ws: false, note: ", hmr: { clientPort: 443 }" } };`,
    'a line comment': `export default { server: { ws: false, // , hmr: { port: 24678 }\n port: 5173 } };`,
    'a block comment': `export default { server: { ws: false, /* , hmr: { port: 24678 } */ port: 5173 } };`,
    'a template literal': 'export default { server: { ws: false, note: `, hmr: { port: 24678 }` } };',
  };

  for (const [label, source] of Object.entries(decoys)) {
    it(`ignores a \`hmr:\` written inside ${label}`, async () => {
      const { runChecks } = await import('../src/checks.js');
      const extracted = extractServerFromSource(source);

      assert.equal(extracted.server.hmr, undefined, 'must not report a hmr block');
      assert.deepEqual(runChecks(extracted.server), [], 'must not invent a finding');
    });
  }

  it('still reads a real `server.hmr` block next to a decoy', () => {
    const source =
      `export default { server: { ws: false, note: ', hmr: { clientPort: 443 }', hmr: { port: 24678 } } };`;
    const extracted = extractServerFromSource(source);
    assert.deepEqual(Object.keys(extracted.server.hmr), ['port']);
  });

  it('still reads a real `server.hmr: false`', () => {
    assert.equal(extractServerFromSource('export default { server: { hmr: false } };').server.hmr, false);
  });
});

describe('extractServerFromSource is nesting-depth aware', () => {
  // Regression: masking blanks strings and comments but *preserves* the
  // structural `{ } [ ]` characters, so a flat `/(?:^|,)\s*hmr\s*:/` regex read
  // a nested `, hmr:` as if it were a top-level `server.hmr` property. A plugin
  // object inside an array — a shape the README explicitly names — produced a
  // spurious finding. The scanner now tracks brace AND bracket depth and only
  // accepts a match at depth 0.
  const nestedDecoys = {
    'a plugin object inside an array': [
      `export default { server: { ws: false, plugins: [{ name: 'p', hmr: { port: 1 } }] } };`,
      ['port'],
    ],
    'a helper object inside an array': [
      `export default { server: { ws: false, helpers: [{ name: 'x', hmr: { port: 1 } }] } };`,
      ['port'],
    ],
    'a nested object literal in a comma-preceded position': [
      `export default { server: { ws: false, plugin: { name: 'p', hmr: { port: 1 } } } };`,
      ['port'],
    ],
    'a `watch` object': [
      `export default { server: { ws: false, watch: { hmr: { port: 1 } } } };`,
      ['port'],
    ],
    'a list element': [
      `export default { server: { ws: false, list: [1, { hmr: { port: 1 } }] } };`,
      ['port'],
    ],
  };

  for (const [label, [source]] of Object.entries(nestedDecoys)) {
    it(`ignores an \`hmr:\` nested at depth > 0 in ${label}`, async () => {
      const { runChecks } = await import('../src/checks.js');
      const extracted = extractServerFromSource(source);

      assert.equal(extracted.server.hmr, undefined, 'must not report a hmr block');
      assert.deepEqual(runChecks(extracted.server), [], 'must not invent a finding');
    });
  }

  it('does not read a nested `ws: false` as the top-level `server.ws`', () => {
    const source = `export default { server: { ws: { port: 5173 }, plugins: [{ name: 'p', ws: false }] } };`;
    const extracted = extractServerFromSource(source);
    assert.notEqual(extracted.server.ws, false, 'nested ws:false must not win');
  });

  it('does not treat a hyphenated key like `vite-hmr:` as `hmr`', () => {
    const source = `export default { server: { ws: false, 'vite-hmr': 1 } };`;
    assert.equal(extractServerFromSource(source).server.hmr, undefined);
  });

  // Positive controls: the depth fix must not suppress real configuration.
  it('still reports a real top-level `server.hmr.port` with `ws: false`', async () => {
    const { runChecks } = await import('../src/checks.js');
    const source = `export default { server: { ws: false, hmr: { port: 1 } } };`;
    const extracted = extractServerFromSource(source);
    assert.deepEqual(Object.keys(extracted.server.hmr), ['port']);
    assert.deepEqual(
      runChecks(extracted.server, source).map((finding) => finding.id),
      ['ws-false-drops-hmr-options'],
    );
  });

  it('still reports a real top-level `server.hmr.server` with `ws: false`', async () => {
    const { runChecks } = await import('../src/checks.js');
    const source = `export default { server: { ws: false, hmr: { server: customServer } } };`;
    const extracted = extractServerFromSource(source);
    assert.deepEqual(Object.keys(extracted.server.hmr), ['server']);
    assert.deepEqual(
      runChecks(extracted.server, source).map((finding) => finding.id),
      ['ws-false-ignores-hmr-server'],
    );
  });

  it('still reads a real `hmr` that precedes `ws`', () => {
    const source = `export default { server: { hmr: { port: 1 }, ws: false } };`;
    const extracted = extractServerFromSource(source);
    assert.deepEqual(Object.keys(extracted.server.hmr), ['port']);
    assert.equal(extracted.server.ws, false);
  });
});
