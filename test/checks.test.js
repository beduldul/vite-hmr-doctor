/**
 * Unit tests for the pure check functions.
 *
 * These pass plain config objects, mirroring what Vite hands to the checks,
 * and assert both firing (positive) and silence (no false positives).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkDeprecatedHmrAliases,
  checkHmrAndWsBothSet,
  checkHmrFalseLeavesOptionsUnreachable,
  checkWsFalseDropsHmrOptions,
  runChecks,
  setHmrOptions,
} from '../src/checks.js';

const ids = (findings) => findings.map((finding) => finding.id);

describe('checkWsFalseDropsHmrOptions (Check 1)', () => {
  it('fires for ws:false with hmr.port', () => {
    const findings = checkWsFalseDropsHmrOptions({ ws: false, hmr: { port: 5173 } });
    assert.deepEqual(ids(findings), ['ws-false-drops-hmr-options']);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].message, /server\.hmr\.port/);
  });

  it('fires for ws:false with hmr.server, the transport case', () => {
    const findings = checkWsFalseDropsHmrOptions({ ws: false, hmr: { server: {} } });
    assert.deepEqual(ids(findings), ['ws-false-ignores-hmr-server']);
    assert.match(findings[0].detail, /transport|never receives/i);
  });

  it('fires once per category when both socket options and a transport are set', () => {
    const findings = checkWsFalseDropsHmrOptions({
      ws: false,
      hmr: { port: 24678, host: 'localhost', server: {} },
    });
    assert.deepEqual(ids(findings), [
      'ws-false-ignores-hmr-server',
      'ws-false-drops-hmr-options',
    ]);
  });

  it('stays quiet when ws is not exactly false', () => {
    assert.deepEqual(checkWsFalseDropsHmrOptions({ hmr: { port: 5173 } }), []);
    assert.deepEqual(checkWsFalseDropsHmrOptions({ ws: {}, hmr: { port: 5173 } }), []);
    assert.deepEqual(checkWsFalseDropsHmrOptions({ ws: true, hmr: { port: 5173 } }), []);
  });

  it('stays quiet when ws:false has no hmr options', () => {
    assert.deepEqual(checkWsFalseDropsHmrOptions({ ws: false }), []);
    assert.deepEqual(checkWsFalseDropsHmrOptions({ ws: false, hmr: {} }), []);
  });

  it('stays quiet on hmr:false, which is Check 2 territory', () => {
    assert.deepEqual(checkWsFalseDropsHmrOptions({ hmr: false, ws: false }), []);
  });

  it('counts options set to falsy values such as 0', () => {
    const findings = checkWsFalseDropsHmrOptions({ ws: false, hmr: { timeout: 0 } });
    assert.equal(findings.length, 1);
    assert.match(findings[0].option, /server\.hmr\.timeout/);
  });

  it('does not mutate the config it inspects', () => {
    const server = { ws: false, hmr: { port: 5173 } };
    const snapshot = JSON.stringify(server);
    checkWsFalseDropsHmrOptions(server);
    assert.equal(JSON.stringify(server), snapshot);
  });
});

describe('checkHmrFalseLeavesOptionsUnreachable (Check 2)', () => {
  const SOURCE = `export default {
  server: {
    hmr: { port: 1234, overlay: true },
    hmr: false,
  },
};`;

  it('fires when hmr is written twice and the later value wins', () => {
    const findings = checkHmrFalseLeavesOptionsUnreachable({ hmr: false }, SOURCE);
    assert.deepEqual(ids(findings), ['hmr-false-makes-hmr-options-unreachable']);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].option, /server\.hmr\.port/);
  });

  it('stays quiet for a bare hmr:false', () => {
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({ hmr: false }), []);
  });

  it('stays quiet when the surviving value is the options object', () => {
    const reversed = `export default { server: { hmr: false, hmr: { port: 1 } } };`;
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({ hmr: { port: 1 } }, reversed), []);
  });

  it('stays quiet when hmr is an object or unset', () => {
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({ hmr: { port: 1 } }, SOURCE), []);
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({}, SOURCE), []);
  });

  it('stays quiet without source text, since duplicates are invisible after evaluation', () => {
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({ hmr: false }), []);
  });

  it('ignores source with a single hmr key, comments, and strings containing braces', () => {
    const noisy = `// server: { hmr: { port: 1 }, hmr: false }
const s = "hmr: { port: 2 }";
export default { server: { hmr: false, /* hmr: { port: 3 } */ } };`;
    assert.deepEqual(checkHmrFalseLeavesOptionsUnreachable({ hmr: false }, noisy), []);
  });
});

describe('checkDeprecatedHmrAliases (Check 3)', () => {
  it('fires as info when a deprecated hmr option is used normally', () => {
    const findings = checkDeprecatedHmrAliases({ hmr: { protocol: 'wss', port: 443 } });
    assert.deepEqual(ids(findings), ['deprecated-hmr-option-alias']);
    assert.equal(findings[0].severity, 'info');
    assert.match(findings[0].detail, /server\.ws\.port/);
  });

  it('stays quiet when nothing deprecated is set', () => {
    assert.deepEqual(checkDeprecatedHmrAliases({ hmr: {} }), []);
    assert.deepEqual(checkDeprecatedHmrAliases({}), []);
    assert.deepEqual(checkDeprecatedHmrAliases({ ws: { port: 5173 } }), []);
  });

  it('defers to Check 1 when ws is false, and Check 2 when hmr is false', () => {
    assert.deepEqual(checkDeprecatedHmrAliases({ ws: false, hmr: { port: 1 } }), []);
    assert.deepEqual(checkDeprecatedHmrAliases({ hmr: false }), []);
  });
});

describe('checkHmrAndWsBothSet (Check 4)', () => {
  it('fires when a key is in both server.ws and server.hmr', () => {
    const findings = checkHmrAndWsBothSet({ ws: { port: 5000 }, hmr: { port: 6000 } });
    assert.deepEqual(ids(findings), ['hmr-and-ws-both-set']);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].message, /server\.ws\.port/);
  });

  it('reports every overlapping key', () => {
    const findings = checkHmrAndWsBothSet({
      ws: { port: 5000, host: 'a', path: '/x' },
      hmr: { port: 6000, host: 'b', timeout: 1 },
    });
    assert.match(findings[0].option, /server\.ws\.port/);
    assert.match(findings[0].option, /server\.ws\.host/);
    assert.doesNotMatch(findings[0].option, /server\.ws\.timeout/);
  });

  it('stays quiet when the two blocks do not overlap', () => {
    assert.deepEqual(checkHmrAndWsBothSet({ ws: { port: 5000 }, hmr: { host: 'b' } }), []);
  });

  it('stays quiet when ws is not an object or hmr is not an object', () => {
    assert.deepEqual(checkHmrAndWsBothSet({ ws: false, hmr: { port: 1 } }), []);
    assert.deepEqual(checkHmrAndWsBothSet({ ws: { port: 1 } }), []);
    assert.deepEqual(checkHmrAndWsBothSet({ hmr: { port: 1 } }), []);
  });
});

describe('Check 5 removed: hmr.overlay is not a socket option', () => {
  // Regression guard: overlay is NOT in Vite's wsOptionKeys and is read with no
  // guard on ws/hmr, so it still takes effect with ws:false. It must be silent.
  it('never reports hmr.overlay, even alongside ws:false', () => {
    assert.deepEqual(runChecks({ ws: false, hmr: { overlay: false } }), []);
    assert.deepEqual(runChecks({ ws: false, hmr: { overlay: true } }), []);
    assert.deepEqual(runChecks({ hmr: { overlay: false } }), []);
  });
});

describe('setHmrOptions', () => {
  it('lists only own, known hmr option keys', () => {
    assert.deepEqual(setHmrOptions({ hmr: { port: 1, nope: 2 } }), ['port']);
  });

  it('returns an empty list for non-objects', () => {
    assert.deepEqual(setHmrOptions(undefined), []);
    assert.deepEqual(setHmrOptions({ hmr: false }), []);
  });
});

describe('runChecks', () => {
  it('is clean for a modern config', () => {
    assert.deepEqual(runChecks({ port: 5173, ws: { port: 5174 } }), []);
  });

  it('is clean for representative fixtures', () => {
    assert.deepEqual(runChecks(undefined), []);
    assert.deepEqual(runChecks({}), []);
    assert.deepEqual(runChecks({ hmr: true }), []);
  });

  it('runs every check against a config that trips several', () => {
    const findings = runChecks({
      ws: false,
      hmr: { port: 1, server: {} },
    });
    assert.deepEqual(ids(findings), [
      'ws-false-ignores-hmr-server',
      'ws-false-drops-hmr-options',
    ]);
  });

  it('keeps independent checks quiet on a config that only trips one', () => {
    assert.deepEqual(ids(runChecks({ hmr: { port: 1 } })), ['deprecated-hmr-option-alias']);
  });

  it('reports both the overlap and the deprecation when ws and hmr share a key', () => {
    // Verified against Vite: {ws:{port:5000}, hmr:{port:6000}} leaves
    // ws.port === 5000 with hmr.port === 6000 still set but dead.
    assert.deepEqual(ids(runChecks({ ws: { port: 5000 }, hmr: { port: 6000 } })), [
      'hmr-and-ws-both-set',
      'deprecated-hmr-option-alias',
    ]);
  });
});
