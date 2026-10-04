[![CI](https://github.com/beduldul/vite-hmr-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/beduldul/vite-hmr-doctor/actions/workflows/ci.yml)
# vite-hmr-doctor

Find Vite `server.hmr` / `server.ws` configuration that Vite silently ignores.

Zero runtime dependencies. ESM, no build step. Runs on plain `node`.

## What it does

Vite accepts the deprecated `server.hmr.*` WebSocket options, type-checks them,
and — in some combinations — never applies them and never says so. You write
`server.hmr.port`, the dev server starts fine, and your setting quietly stops
meaning anything. `vite-hmr-doctor` reads your Vite config and tells you which
of those options are dead, before you spend an afternoon debugging it.

## Where this came from

This tool grew out of [`vitejs/vite#23578`](https://github.com/vitejs/vite/pull/23578),
a pull request that adds a warning when `server.hmr.server` is ignored because
`server.ws` is `false`. That PR is still open, and it was deliberately narrowed
to `server.hmr.server` alone: its six sibling socket keys (`protocol`, `host`,
`port`, `clientPort`, `path`, `timeout`) were dropped from it after review, on
the reasoning that writing `server.ws: false` already means there is no socket
to configure. A `server.ws: false` config that also sets `server.hmr.port`
therefore still says nothing even once that PR lands. This tool checks the whole
set, which is why it exists separately from the PR.

## The problem it detects

Vite's compatibility step aliases the deprecated `server.hmr.*` options onto
`server.ws.*`. It returns early when `server.ws === false` (the same guard also
covers `server.hmr === false`), because the aliasing cannot work when
`server.ws` is not an object. The options are then dropped with no message.

Vite's own docs point in two directions at once:

- `docs/config/server-options.md:198` promises the `server.hmr.*` options "are
  automatically synced, so existing configurations will continue to work".
- `docs/config/server-options.md:206` says `ws: false` disables the WebSocket
  connection entirely — without mentioning that the sync above is skipped.

So a config that sets `server.ws: false` and leaves `server.hmr.port` behind
type-checks, starts, and ignores the port silently. Measured on a local Vite:

```js
{ ws: false, hmr: { port: 9999 } }  ->  ws === false, hmr === { port: 9999 }, no warning
```

## The checks

| # | Condition | Severity |
|---|---|---|
| 1 | `server.ws === false` **and** any `server.hmr.{protocol,host,port,clientPort,path,timeout}` set | warning |
| 1b | `server.ws === false` **and** `server.hmr.server` set — the HMR *transport* | warning |
| 2 | `server.hmr === false` where the `hmr` key is also written with options | warning |
| 3 | a deprecated `server.hmr.*` option set **without** `server.ws: false` | info |
| 4 | `server.ws` is an object **and** the same key is also in `server.hmr` | warning |

Check 1b is separated from Check 1 on purpose. Losing a `port`, `host`, or
`path` is inferable from writing `server.ws: false` — there is no socket left to
configure. Losing `server.hmr.server` is not: it is not a socket parameter, it
is the HMR transport, and a custom server handed in there never receives its
`upgrade` listener.

Check 4 notes that `server.ws` wins. Verified against a live Vite:
`{ ws: { port: 5000 }, hmr: { port: 6000 } }` leaves `ws.port === 5000` with
`hmr.port === 6000` still set but never applied.

### Check 3 wording, and Vite's own deprecation warning

Vite's deprecation warning for `server.hmr.*` comes from a **proxy setter**, so
it fires on *programmatic assignment* — for example a plugin doing
`config.server.hmr.port = 5555` — not when the option is merely declared in a
config object. A purely declarative `server.hmr.port` produces **zero**
warnings, and the setter logs at most once per process. Measured locally: 0
warnings after `resolveConfig` on a declarative config, 1 warning only after an
explicit assignment.

This tool reports the deprecation for declarative configs, which Vite does not.
That is the point of Check 3.

## Current Vite behaviour

The silent drop described above is **today's released behaviour**, not a
regression and not a hypothetical.

[`vitejs/vite#23578`](https://github.com/vitejs/vite/pull/23578) — **still
open**, not merged — adds a warning, but deliberately for **`server.hmr.server`
only**. Its six sibling socket keys (`protocol`, `host`, `port`, `clientPort`,
`path`, `timeout`) were dropped from that PR after review, on the reasoning
that writing `server.ws: false` already means there is no socket to configure.
The PR also gates on `command === 'serve'` and not-preview, since preview has no
HMR.

So even with #23578 merged, a `server.ws: false` + `server.hmr.port` config
still says nothing. This tool covers the whole set.

## What it deliberately does NOT report

`server.hmr.overlay` is **not** a socket option. It is not in Vite's
`wsOptionKeys`, and the client-injection code reads it with no guard on
`hmr === false` or `ws === false` (`hmrConfig?.overlay !== false`). It therefore
still takes effect with the WebSocket server disabled. Verified: with
`ws: false`, `hmr.overlay: false` yields `__HMR_ENABLE_OVERLAY__ = false` and
`hmr.overlay: true` yields `true`.

An earlier revision of this tool flagged `overlay` as dead config. That was a
false positive and the check was removed. `test/checks.test.js` keeps a
regression test asserting that `overlay` is never reported.

A second false positive came from the static scanner matching `, hmr:` in raw
text, and a third from it matching one at **depth greater than zero**. A config
with no `server.hmr` at all, but carrying a comment or string containing a
`, hmr: { ... }` example, was reported as having ignored HMR options. So was a
config whose `server` block held a *nested* object with its own `hmr:` key, such
as a plugin entry — `plugins: [{ name: 'p', hmr: { port: 1 } }]`. Both scanners
now mask comments and strings first, and the static scanner accepts an `hmr:`
(or `ws:`) match only at **brace and bracket depth 0** within the `server` body,
so a nested key is never read as a top-level property. `test/resolve.test.js`
and `test/cli.test.js` cover the decoy shapes, including the nested ones.

## Install and usage

No install is required to run it from a checkout:

```sh
node bin/vite-hmr-doctor.js                      # current directory
node bin/vite-hmr-doctor.js path/to/vite.config.ts
node bin/vite-hmr-doctor.js path/to/project       # finds vite.config.*
```

As an installed binary:

```sh
npm install --global vite-hmr-doctor
vite-hmr-doctor ./my-app
```

`vite` itself is an **optional** peer dependency. When it is installed in the
project being checked, the config is loaded through Vite's own `resolveConfig`,
which is the accurate path. When it is not, the tool imports the config file
directly, and falls back to reading the `server` block statically if the file
cannot be imported (a `.ts` config with no loader, for instance).

### Options

| Flag | Effect |
|---|---|
| `--json` | Machine-readable output |
| `--strict` | Treat deprecation notices (Check 3) as failures |
| `--no-vite` | Skip Vite; use import/static analysis only |
| `-h`, `--help` | Usage |
| `-v`, `--version` | Version |

Colour is used only on a TTY, and is disabled when `NO_COLOR` is set.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean |
| `1` | Problems found (warnings, or notices under `--strict`) |
| `2` | Usage or config error — bad flag, missing path, no config found, unreadable config |

## Example

```
$ vite-hmr-doctor ./my-app
vite-hmr-doctor  /home/me/my-app/vite.config.js
  resolved with Vite resolveConfig

! server.hmr.server is ignored because server.ws is false; the custom HMR transport is never attached.
  option: server.hmr.server
  check:  ws-false-ignores-hmr-server
  server.ws: false makes createWebSocketServer() return a noop stub, so the provided server ([object Object]) never receives an "upgrade" listener. Unlike host/port/path, a lost transport is not inferable from writing server.ws: false. Drop server.hmr.server, or remove server.ws: false and use server.ws.server instead.

Summary: 1 finding, 1 failure.
```

## Scope and limitations

- **Both resolution paths were exercised.** The `vite` `resolveConfig` path was
  run against a real Vite install (v5.4.21) by linking it into a temporary
  project, and it is covered by tests in `test/resolve.test.js` that skip
  themselves when no `vite` is reachable. The static/importer fallback is
  exercised on every run without `vite`.
- **When `vite` is absent, the static/importer fallback is what runs by
  default** — no flag is needed. `--no-vite` forces that path even when `vite`
  is installed. Because the importer path actually evaluates the config when the
  file loads, it is authoritative for any config it can import; the static
  scanner is the narrower last resort for configs that cannot be imported.
- The static fallback cannot know *values*, only which option *names* are
  present, since knowing values would require running the file. That is enough
  for every check here, which all ask "was this option set?".
- Check 2 needs the config **source text**, because duplicate object keys are
  invisible after evaluation — `{ hmr: {...}, hmr: false }` simply *is*
  `{ hmr: false }`. When the source is unavailable, Check 2 stays silent rather
  than guessing.
- Both source scanners mask comments, quoted strings, and template literals
  before matching option names. A `, hmr:` that appears only inside a comment or
  a string is therefore never read as configuration. This was a real defect
  until it was fixed: the static scanner used to match raw text, so a config
  carrying a commented-out `, hmr: { ... }` example was reported as ignored
  config. Both scanners now share one masking implementation in `src/mask.js`,
  with regression tests in `test/resolve.test.js` and `test/cli.test.js`.
- **The static scanner cannot invent a problem from text that only looks like
  configuration.** Two classes of decoy are covered by regression tests and
  produce no finding: text inside a comment, string, or template literal, and an
  `hmr:`/`ws:` key nested at depth greater than zero inside the `server` body
  (for example `plugins: [{ hmr: { ... } }]`). This guarantee is limited to
  those shapes and to what has been tested; it is **not** a claim that the
  scanner understands arbitrary JavaScript. It is a hand-written matcher, and
  the honest statement of what it can reason about is the next bullet.
- The scanners remain narrow, hand-written matchers rather than JavaScript
  parsers. They deliberately recognise only a top-level `server: { ... }`
  literal, and within it only `hmr` and `ws` **at brace/bracket depth 0**. A
  nested `hmr:` is not read as configuration. Anything more complex — a config
  spread across variables, a `server` block built conditionally, or `hmr`
  produced by a computed key — makes the static scanner report nothing rather
  than guess. In that situation, install `vite` so the authoritative
  `resolveConfig` path runs instead.
- `resolveConfig` is invoked for `command: 'serve'`. A config whose `server`
  block depends on other commands will be resolved as it would be for
  `vite dev`, which is the case HMR options matter for.
- The tool only *reports*. It never modifies your config, and never starts a
  server.

## Tests

No test framework and no install: `node --test` is all you need.

```sh
node --test
```

## License

MIT
