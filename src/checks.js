/**
 * Pure check functions for vite-hmr-doctor.
 *
 * Every function here takes a resolved Vite `server` config object and returns
 * a *new* array of findings. Nothing is mutated, nothing is read from disk, no
 * I/O happens. That makes each check independently testable.
 *
 * Background: Vite's `setupHmrWsOptionCompat()` aliases the deprecated
 * `server.hmr.*` options onto `server.ws.*`. It returns early when
 * `server.ws === false` (and when `server.hmr === false`), which means a set
 * `server.hmr.*` option is accepted, type-checked, and then silently dropped.
 *
 * @typedef {'error'|'warning'|'info'} Severity
 *
 * @typedef {object} Finding
 * @property {string} id      Stable check id, e.g. 'ws-false-drops-hmr-options'.
 * @property {Severity} severity
 * @property {string} option  The dotted option path the finding is about.
 * @property {string} message One-line summary.
 * @property {string} detail  Longer explanation of why it matters / what to do.
 */

import {
  commentEndAt,
  maskCommentsAndStrings,
  skipString,
  stringDelimiterAt,
} from './mask.js';

/** Deprecated `server.hmr.*` options that configure a *socket*. */
export const HMR_SOCKET_OPTIONS = Object.freeze([
  'protocol',
  'host',
  'port',
  'clientPort',
  'path',
  'timeout',
]);

/**
 * `server.hmr.server` is not a socket parameter: it is the *HMR transport*.
 * With `server.ws: false` the WebSocket server is a noop stub, so a custom
 * transport handed in here is never attached. Host/port/path losses are
 * inferable from writing `ws: false`; losing the transport is not.
 */
export const HMR_TRANSPORT_OPTION = 'server';

/** All `server.hmr.*` options this tool knows about. */
export const HMR_ALL_OPTIONS = Object.freeze([
  ...HMR_SOCKET_OPTIONS,
  HMR_TRANSPORT_OPTION,
]);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True when `option` is present on the object, even if its value is falsy. */
const has = (object, key) =>
  isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key);

/**
 * Return the `server.hmr.*` keys that are explicitly set on the config.
 * Own-property check, so `hmr.port = 0` and `hmr.timeout = 0` count as set.
 *
 * @param {unknown} server
 * @returns {string[]}
 */
export function setHmrOptions(server) {
  if (!isPlainObject(server) || !isPlainObject(server.hmr)) return [];
  return HMR_ALL_OPTIONS.filter((key) => has(server.hmr, key));
}

/** Render a value for a human message without throwing on odd input. */
function describe(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

/**
 * Check 1 (the flagship): `server.ws === false` makes the whole WebSocket
 * server a noop, so every set `server.hmr.*` option is ignored. Vite reports
 * none of them. `server.hmr.server` is called out separately because it is the
 * one loss that cannot be inferred from `ws: false`.
 *
 * @param {unknown} server
 * @returns {Finding[]}
 */
export function checkWsFalseDropsHmrOptions(server) {
  if (!isPlainObject(server) || server.ws !== false) return [];

  const transport = HMR_TRANSPORT_OPTION;
  const sockets = setHmrOptions(server).filter((key) => key !== transport);
  const hasTransport = has(server.hmr, transport);

  const transportFindings = hasTransport ? [wsFalseTransportFinding(server.hmr[transport])] : [];

  const socketFindings = sockets.length === 0 ? [] : [wsFalseSocketFinding(sockets)];

  return [...transportFindings, ...socketFindings];
}

/**
 * Build the finding for a dropped `server.hmr.server` transport.
 *
 * @param {unknown} value The provided server object.
 * @returns {Finding}
 */
function wsFalseTransportFinding(value) {
  return {
    id: 'ws-false-ignores-hmr-server',
    severity: 'warning',
    option: 'server.hmr.server',
    message:
      'server.hmr.server is ignored because server.ws is false; the custom HMR transport is never attached.',
    detail:
      `server.ws: false makes createWebSocketServer() return a noop stub, so the ` +
      `provided server (${describe(value)}) never receives an "upgrade" listener. ` +
      `Unlike host/port/path, a lost transport is not inferable from writing ` +
      `server.ws: false. Drop server.hmr.server, or remove server.ws: false and ` +
      `use server.ws.server instead.`,
  };
}

/**
 * Build the finding for dropped `server.hmr.*` socket options.
 *
 * @param {string[]} sockets The socket option names that were set.
 * @returns {Finding}
 */
function wsFalseSocketFinding(sockets) {
  const list = sockets.map((key) => `server.hmr.${key}`).join(', ');
  return {
    id: 'ws-false-drops-hmr-options',
    severity: 'warning',
    option: list,
    message:
      `${sockets.length} deprecated ${sockets.length === 1 ? 'option is' : 'options are'} ` +
      `ignored because server.ws is false: ${list}.`,
    detail:
      `server.ws: false disables the WebSocket server entirely, so there is no ` +
      `socket left for these to configure. Vite accepts and type-checks them, ` +
      `then drops them without a message. This contradicts Vite's own docs, which ` +
      `say server.hmr.* options are "automatically synced" to server.ws for ` +
      `backwards compatibility without noting that the sync is skipped when ` +
      `server.ws is false. Remove ${sockets.length === 1 ? 'it' : 'them'}, ` +
      `or drop server.ws: false if you meant to keep HMR over a WebSocket.`,
  };
}

/**
 * Check 2: `server.hmr === false` where the `hmr` key is *also* spelled with
 * options in the same object literal.
 *
 * Duplicate keys are legal JavaScript: the last one wins, so the config parses
 * and evaluates to `hmr === false` while the earlier options vanish. Vite's
 * compat step returns early when `server.hmr === false`, so those options are
 * unreachable and nothing is reported.
 *
 * @param {unknown} server The resolved `config.server` block.
 * @param {string} [source] The config file's source text, when available.
 * @returns {Finding[]}
 */
export function checkHmrFalseLeavesOptionsUnreachable(server, source = undefined) {
  if (!isPlainObject(server) || server.hmr !== false) return [];

  const keys = duplicateHmrObjectKeys(source);
  if (keys.length === 0) return [];

  const list = keys.map((key) => `server.hmr.${key}`).join(', ');
  return [
    {
      id: 'hmr-false-makes-hmr-options-unreachable',
      severity: 'warning',
      option: list,
      message: `server.hmr is false, so ${list} can never be reached.`,
      detail:
        `server.hmr is written twice: once with options and once as false. The last ` +
        `entry wins, so server.hmr ends up === false. Vite's compatibility step for ` +
        `the deprecated server.hmr.* aliases returns early when server.hmr === false, ` +
        `so ${list} is never read and no warning is printed. Remove ` +
        `${keys.length === 1 ? 'the option' : 'the options'}, or delete server.hmr: false.`,
    },
  ];
}

/**
 * Check 3: a deprecated `server.hmr.*` option *without* `server.ws: false` is
 * still supported — Vite aliases it onto `server.ws.*` — but it is deprecated.
 *
 * Note on Vite's own deprecation warning: it is emitted by a *proxy setter* on
 * `server.hmr.<key>`, so it fires on programmatic assignment (for example a
 * plugin doing `config.server.hmr.port = 5555`), not when the option is merely
 * declared in the config object. A purely declarative `server.hmr.port` produces
 * no warning at all, and the setter logs at most once per process. This check
 * therefore reports the deprecation for declarative configs, which Vite does
 * not.
 *
 * @param {unknown} server
 * @returns {Finding[]}
 */
export function checkDeprecatedHmrAliases(server) {
  if (!isPlainObject(server)) return [];
  // `ws: false` is Check 1's territory; `hmr: false` is Check 2's.
  if (server.ws === false || server.hmr === false) return [];

  const set = setHmrOptions(server);
  if (set.length === 0) return [];

  const list = set.map((key) => `server.hmr.${key}`).join(', ');
  return [
    {
      id: 'deprecated-hmr-option-alias',
      severity: 'info',
      option: list,
      message: `${list} ${set.length === 1 ? 'is' : 'are'} deprecated; prefer the server.ws equivalent.`,
      detail:
        `These options still take effect because Vite aliases server.hmr.* onto ` +
        `server.ws.*, but the server.hmr.* form is deprecated. Move ${list} to ` +
        `${set.map((key) => `server.ws.${key}`).join(', ')} to stay on the supported spelling. ` +
        `Note that Vite's own deprecation warning comes from a proxy setter and only ` +
        `fires on programmatic assignment, so a config that simply declares these ` +
        `options is never warned about at all.`,
    },
  ];
}

/**
 * Check 4: a key set in *both* `server.ws` (object form) and `server.hmr`.
 * Vite lets `server.ws` win, so the `server.hmr` value is dead config.
 *
 * @param {unknown} server
 * @returns {Finding[]}
 */
export function checkHmrAndWsBothSet(server) {
  if (!isPlainObject(server) || !isPlainObject(server.ws)) return [];
  if (!isPlainObject(server.hmr)) return [];

  const overlapping = HMR_ALL_OPTIONS.filter(
    (key) => has(server.ws, key) && has(server.hmr, key),
  );
  if (overlapping.length === 0) return [];

  const conflictList = overlapping.map((key) => `server.ws.${key}`).join(', ');

  return [
    {
      id: 'hmr-and-ws-both-set',
      severity: 'warning',
      option: conflictList,
      message: `${conflictList} ${overlapping.length === 1 ? 'is' : 'are'} also set in server.hmr; server.ws wins.`,
      detail:
        `With server.ws in object form, Vite copies server.hmr.* onto it only where ` +
        `server.ws does not already define the key. The server.hmr value is therefore ` +
        `ignored. Keep one spelling: the conflicting keys are ` +
        `${overlapping.map((key) => `server.ws.${key} (ws=${describe(server.ws[key])}, hmr=${describe(server.hmr[key])})`).join('; ')}.`,
    },
  ];
}

/**
 * Scan config source text for a `server` block whose `hmr` key is written more
 * than once, and collect the option keys of the entry that lost.
 *
 * This is a hand-written scanner over a deliberately narrow pattern. It does
 * not evaluate the config and does not attempt to parse arbitrary JavaScript;
 * anything it does not understand makes it return no keys, so it cannot invent
 * a finding. Comments and strings are masked first, so text that only looks
 * like a server block (a commented-out example, say) is not matched.
 *
 * @param {string|undefined} source
 * @returns {string[]} Option keys hidden behind a later `hmr: false`.
 */
function duplicateHmrObjectKeys(source) {
  if (typeof source !== 'string') return [];

  const masked = maskCommentsAndStrings(source);
  const serverBody = braceBodyAfter(masked, /\bserver\s*:\s*\{/);
  if (serverBody === null) return [];

  // Slice the original text for entry values so real strings stay intact.
  const realBody = source.slice(serverBody.start, serverBody.end);
  const entries = objectEntries(maskCommentsAndStrings(realBody));
  const hmrEntries = entries.filter((entry) => entry.key === 'hmr');
  if (hmrEntries.length < 2) return [];

  const last = hmrEntries[hmrEntries.length - 1];
  if (!/^\s*false\s*$/.test(last.value)) return [];

  const optionKeys = hmrEntries
    .slice(0, -1)
    .flatMap((entry) => {
      const body = objectBody(entry.value);
      return body === null ? [] : objectEntries(body).map((nested) => nested.key);
    })
    .filter((key) => HMR_ALL_OPTIONS.includes(key));

  return [...new Set(optionKeys)];
}

/**
 * Locate the first `{ ... }` group that follows a pattern match, ignoring
 * braces inside strings, templates, and comments.
 *
 * @param {string} source
 * @param {RegExp} pattern
 * @returns {{ body: string, start: number, end: number }|null} `start`/`end`
 *   are offsets of the body inside `source` (exclusive of the braces).
 */
function braceBodyAfter(source, pattern) {
  const match = pattern.exec(source);
  if (match === null) return null;

  const open = source.indexOf('{', match.index);
  if (open === -1) return null;

  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    const commentEnd = commentEndAt(source, index);
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }

    const delimiter = stringDelimiterAt(source, index);
    if (delimiter !== null) {
      index = skipString(source, index, delimiter) - 1;
      continue;
    }

    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(open + 1, index), start: open + 1, end: index };
      }
    }
  }

  return null;
}

/**
 * Split a brace body into its top-level `key: value` entries.
 *
 * Keys are plain identifiers or quoted strings; entry values are returned as
 * raw source text. Nested structures are kept intact.
 *
 * @param {string} body
 * @returns {{ key: string, value: string }[]}
 */
function objectEntries(body) {
  const parts = splitTopLevel(body);
  return parts.flatMap((part) => {
    const colon = firstTopLevelColon(part);
    if (colon === -1) return [];
    const rawKey = part.slice(0, colon).trim().replace(/^["']|["']$/g, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(rawKey)) return [];
    return [{ key: rawKey, value: part.slice(colon + 1).trim() }];
  });
}

/** Split on top-level commas, ignoring commas inside nested groups or strings. */
function splitTopLevel(body) {
  /** @type {string[]} */
  let parts = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < body.length; index += 1) {
    const commentEnd = commentEndAt(body, index);
    if (commentEnd !== -1) {
      index = commentEnd;
      continue;
    }

    const delimiter = stringDelimiterAt(body, index);
    if (delimiter !== null) {
      index = skipString(body, index, delimiter) - 1;
      continue;
    }

    const char = body[index];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts = [...parts, body.slice(start, index)];
      start = index + 1;
    }
  }

  const tail = body.slice(start).trim();
  return tail === '' ? parts : [...parts, tail];
}

/** Index of the first top-level `:` in an entry, or -1. */
function firstTopLevelColon(entry) {
  let depth = 0;

  for (let index = 0; index < entry.length; index += 1) {
    const delimiter = stringDelimiterAt(entry, index);
    if (delimiter !== null) {
      index = skipString(entry, index, delimiter) - 1;
      continue;
    }

    const char = entry[index];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    else if (char === '}' || char === ')' || char === ']') depth -= 1;
    else if (char === ':' && depth === 0) return index;
  }

  return -1;
}

/** Extract the inner body of a `{ ... }` value, or null when not an object. */
function objectBody(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  return trimmed.slice(1, -1);
}

/**
 * Run every check against a resolved `server` config.
 *
 * @param {unknown} server Resolved Vite `config.server`.
 * @param {string} [source] Config file source text, used for duplicate-key
 *   detection in Check 2.
 * @returns {Finding[]} All findings, in check order.
 */
export function runChecks(server, source = undefined) {
  return [
    ...checkWsFalseDropsHmrOptions(server),
    ...checkHmrFalseLeavesOptionsUnreachable(server, source),
    ...checkHmrAndWsBothSet(server),
    ...checkDeprecatedHmrAliases(server),
  ];
}
