# Mixrouter

[![CI](https://github.com/yange0793-dot/mixrouter-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/yange0793-dot/mixrouter-oss/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yange0793-dot/mixrouter-oss)](https://github.com/yange0793-dot/mixrouter-oss/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)

A single-user model router for your own machine: one zero-dependency Node process serves both
the Anthropic and OpenAI protocols, routes requests to the providers you configure by model name
and session identity, and exposes a loopback-only browser console.

[中文](README.md)

> This is a **local single-user** tool. It binds to loopback only and has no accounts or remote
> authentication. Do not expose it to the internet or reach it through port forwarding from
> another machine. Provider keys are stored **in plaintext** in the data directory.

The detailed documentation under `docs/` is written in Chinese. This file keeps the same
substance so English readers can evaluate and start the project; follow the linked Chinese
pages for exact field and command reference.

## Who it is for

Good fit:

- You use Claude Code, Codex, or ZCode on your own machine and want them to talk to self-hosted
  or third-party providers.
- You have several providers or several keys and need routing by model, session, or subagent
  slot, with a console that shows where a request will land.
- You want models that only expose OpenAI-style endpoints to work in Claude Code without
  installing a second proxy.

Not a good fit:

- Team sharing, public access, or multi-tenant gateways. There is no account system or remote
  authentication.
- Hosted secret management, audit compliance, or centralized quotas. Keys live in plaintext
  in a local data directory.
- A ready-made Windows installer, Docker image, or a background auto-updater. None are provided;
  upgrades are manual and explicitly confirmed.
- Getting API accounts, free quota, or an upstream quality guarantee from this project.
  Providers, billing, and service quality are between you and your provider.

## What it does

- **Two protocols, one port.** Claude Code's `/v1/messages` and Codex's `/v1/responses` and
  `/v1/chat/completions` all go to `127.0.0.1:8787` and are dispatched by model name and
  session identity.
- **In-process protocol translation.** Models that only sit behind OpenAI-style endpoints can
  still serve Claude Code. Requests to a provider marked `wire_api: responses` are translated to
  Responses; `wire_api: chat` is translated to Chat Completions. No second proxy on the client
  side.
- **Session affinity, best effort.** Conversations from the same agent can use different keys
  on different providers, while a conversation is kept on one provider when possible. This is
  not a hard guarantee: cooldowns, rebinding after failure, failover, manual pinning, and
  session overrides can all change the target.
- **Slot routing and backup pools.** Bind a provider and model to a `mixr-<slot>` alias so the
  main chain and subagents can use separate accounts. The session console lets each conversation
  use its own provider and model per slot; slots without an override inherit the global
  configuration. Each Claude slot row can edit its backup pool in place: the primary provider
  always stays first, backup members are tried in order, and saving does not rewrite an existing
  pool strategy. Codex slots show an explanatory note instead, because the Codex client config
  they write is single-provider.
- **Harness main model and allowlist.** A separate page selects the main model and permitted
  subagent models, reusing the provider catalog and protocol translation without fixed task roles
  or changes to other client slots. Route saving is separate from previewing and confirming client writes.
- **First-run onboarding.** The providers page walks through checking the client, picking or
  importing a provider, choosing a model and protocol, optionally running a compatibility test,
  then previewing and confirming the write. Only managed fields are shown, the client file is
  untouched until you confirm, and the same entry can undo the write by restoring only fields
  that still hold the values it wrote. Import accepts mixrouter `providers.json` and cc-switch
  exports: preview first, additive only, keys masked.
- **Compatibility test.** Uses the real forwarding path to report an authentication verdict,
  non-streaming generation, stream termination, and tool-call shape separately. It sends no
  generation request without explicit confirmation, makes at most three upstream calls, and
  reports the time and scope of that single run.
- **Error guidance and attempt traces.** Proxy-generated error codes, 401/402/403/429/5xx,
  timeouts, and network failures are explained as conclusion, impact, next step, and the console
  page to open. The diagnostics page shows bounded retries and failover targets; the log field
  `request_id` links a request to its trace. A 403 is never reported as a dead key.
- **Optional multi-key fallback.** Enabled per provider. Normal requests stay on one account;
  401/402 (account-level) and 403/404/429 (model-level) are the only failures that may switch
  keys. Pinned session keys and compact-only keys never switch, and `active_key` is never
  rewritten.
- **Local console.** `127.0.0.1:8788` manages providers, routes, sessions, slots, logs, and
  backups. Open Claude Code, Codex, or ZCode providers directly from the sidebar, choose list or
  card views for providers, and expand model slots when needed. Fetch upstream models using a Base URL
  and API key while creating or editing a provider,
  then search and select models to add; manual entry remains available.
  System/light/dark themes,
  `⌘K` / `Ctrl+K` quick navigation, and page deep links are supported.
  The usage page shares one set of filters across request/token totals, cache and success rates,
  a calendar heatmap, and request/provider/model table tabs. It counts currently available logs
  and never converts usage into money.

![Local console, Claude Code providers page: client entries in the sidebar, provider rows, enablement and connection status, account switching, and layout switch](docs/images/console-providers.jpg)

![Local console, Usage page: four metric cards, a calendar heatmap, and request/provider/model tables sharing one filter set](docs/images/console-usage.jpg)

*Demo data; no real providers or credentials.*

## Quick start

You need Node.js **≥ 18**; **22 / 24** are recommended. Run these commands inside the **source
directory** (or an unpacked release directory). There are no third-party dependencies, so no
`npm install` is needed, and Docker is not required.

```bash
git clone https://github.com/yange0793-dot/mixrouter-oss.git
cd mixrouter-oss
node --version                  # 22 / 24 recommended, 18 minimum
npm run local                   # foreground
```

`npm run local` does not write into the source directory, rewrite client configuration, or install
a background service. By default it stores data in `.local/share/mixrouter/data` under your home
directory. The older `npm start` keeps its original behavior: the data directory is the code
directory, which suits existing deployments that already work that way.

In another terminal:

```bash
curl --fail http://127.0.0.1:8787/healthz
open http://127.0.0.1:8788/     # macOS; open the same address in a browser elsewhere
```

Select Claude Code, Codex, or ZCode in the console sidebar, add a provider and model,
then connect that client to the local router. For a fresh install, prefer the onboarding wizard
(「接入向导」) at the top of the **Providers** page: check the client, add or import a provider,
choose a model, optionally run one compatibility test, then preview and confirm the write.
Nothing in the client configuration changes before you confirm.
You can start the console and run the offline acceptance checks
without any provider key; only real forwarding needs one.

You can also connect a client from the command line (the existing config is backed up before it
is rewritten):

```bash
./mixctl route claude --slots   # Claude Code, also writes slot aliases
./mixctl route codex            # Codex
./mixctl route zcode            # ZCode, Anthropic protocol by default
```

### Check the local setup

```bash
npm run doctor                       # read-only: no upstream calls, no config changes, no keys or session content printed
npm run --silent doctor -- --json    # pure JSON (without npm's own command banner)
npm run doctor -- --offline          # do not connect to any local port
```

Exit code `0` means no blocking issue; `1` means a blocking issue was found; `2` means the
arguments were invalid. **A service that is not running is a warning, not a failure**: it is
reported separately and does not turn a healthy install into a failed check. The default data
directory is the same one used by `npm run local`; for an older `npm start` data directory, pass
`--data-dir <absolute path>`. The JSON output contains the data directory path, so check it for
your username and local paths before sharing.

If you do not want to start from an empty console, use `providers.example.json` and
`routes.example.json` in the repository root as templates. They contain placeholder values only;
do not use them as real configuration.

## Install and releases

- **Run from source.** Follow the `git clone` steps above and run `npm run local` or
  `node mixrouter.js` inside the source directory.
- **Release tarball.** Download `mixrouter-<version>.tar.gz` from
  [Releases](https://github.com/yange0793-dot/mixrouter-oss/releases), verify it with the
  `.sha256` file on the same page, and unpack it. **`npm run local` and `npm run doctor` ship
  starting with v3.7.0.** The published **v3.6.1** package does not contain them; follow the
  README inside that package and use `npm start` (data path: see
  [Install, run, and uninstall](docs/installation.md)). The runtime package contains the source
  needed to run, `public/`, and user documentation; it does not contain `test/`, `.github/`, or
  internal material.
- **npm.** This project does not provide an official npm package. Do not use an unrelated
  same-name package. `package.json` is `private: true`; run it from the source directory.
- **Background service (optional, macOS).** `npm run service -- install` writes a LaunchAgent that
  belongs to this tool only; it previews by default and writes with `--apply --yes` (npm needs
  the `--` before script flags). It never
  overwrites a hand-written plist with the same label, and `start` / `stop` / `restart` only act
  on this tool's own label through launchctl. When the upgrader stops an old instance, it only
  signals processes whose command line proves they run from the target release directory.
  Closing the console page does not stop the service.
- **Update check and upgrade.** `npm run update` is local and offline by default; `--check`
  queries the official Releases. `npm run upgrade` previews by default and executes only with
  `--apply --yes`. A package must pass `.sha256`, archive path checks, three-way version
  agreement, and the release manifest. The data directory is read-only to the upgrader, and a
  failed switch rolls back to the previous `current`. There is no silent background updater.
- **Upgrade and rollback.** Keep the data directory separate from the code directory and do not
  swap data together with code. See [Upgrade and rollback](docs/upgrade-and-rollback.md)
  (Chinese).

## Support matrix

| Item | Status |
| --- | --- |
| Node.js | `>= 18` (see `engines.node`); 22 / 24 recommended |
| CI | Linux (`ubuntu-latest`) with Node 18 / 22 / 24, running `npm test` and `npm run smoke` |
| Artifact check | `npm run smoke` inside the unpacked package; run by Linux CI, with a matching macOS Node 24 check in the workflow |
| Local verification | macOS with Node 24, full test suite and offline acceptance |
| Onboarding / compatibility test / undo / service and upgrade / multi-key fallback | Tested locally only on **macOS with Node 24, using offline fixtures**; **no real upstream generation requests were made**; other platforms untested |
| Windows | The core service uses Node built-ins only, but there is **no Windows CI coverage** and no installer |
| macOS shell | The LaunchAgent is generated by `npm run service` and is optional; the **desktop shell is experimental** and not a supported install path |
| Deployment | Local foreground process or local service; no Docker image, hosted VPS setup, or multi-user deployment |

CI results are authoritative on [Actions](https://github.com/yange0793-dot/mixrouter-oss/actions).
Local verification records live in
[Offline run and acceptance](docs/offline-run-and-acceptance.md) (Chinese). A combination that has
not actually been run on a platform is not described as supported. The new entries above have no
corresponding passing CI result yet; the existence of a workflow is not evidence that this
revision has passed it.

## Documentation

The linked pages are in Chinese; the table says what each one covers.

| Document | Contents |
| --- | --- |
| [Install, run, and uninstall](docs/installation.md) | Choosing a start entry, downloading and verifying a release, data directory and ports, uninstall boundaries |
| [Quick start](docs/quick-start.md) | Where to change what: start the service, add providers, configure routes, connect clients, run tests |
| [First-run and self-service recovery](docs/user-readiness.md) | Onboarding wizard, provider import, compatibility test, slot backup pools, error guidance and attempt traces, undo, diagnostic report, multi-key fallback, service and upgrade entries |
| [CLI and runtime boundaries](docs/cli.md) | Every `mixctl` subcommand, ports and data directory, slots and sessions, logs and archives, backup/restore, read-only diagnostics, local self-check |
| [Routing and sessions](docs/routing-and-sessions.md) | Match order, session identity, slots, pool strategies, session overrides, protocol translation |
| [Troubleshooting](docs/troubleshooting.md) | Symptom-oriented: 503 classes, cooldowns and retries, invalid keys, affinity anomalies, log locations, onboarding/compatibility/upgrade failures, multi-key fallback |
| [Reference](docs/reference.md) | Full mechanisms and fields, all environment variables, diagnostic limits |
| [Upgrade and rollback](docs/upgrade-and-rollback.md) | Source upgrades and rollbacks, data directory, client config recovery, install-script boundaries |
| [Offline run and acceptance](docs/offline-run-and-acceptance.md) | Keyless, network-free acceptance flow and what has actually been verified |
| [Contributing](CONTRIBUTING.md) | Development, testing, and submission process |
| [Support](SUPPORT.md) | Where to ask, what to include, support scope, and response expectations |
| [Changelog](CHANGELOG.md) | Version differences |
| [Security policy](SECURITY.md) | How to report vulnerabilities privately, and the threat model |

## Important boundaries

- **Lightweight Harness integration.** Only the main model and subagent allowlist pool are managed.
  Saving routes does not write client files: preview and confirm connection separately on the
  DeepSeek Harness page. Tools, permissions, and workspace settings stay native. Pool updates
  require reconnecting and starting new sessions. The native ordinary-subagent entry point enforces
  explicit selections; this is not a blanket workflow/fork/team policy. See [Harness integration](docs/harness.md) (Chinese).
- **Bounded resource-binding recovery.** The shared matcher recognizes known upstream errors;
  safe recovery strips resource-bound output-item IDs only from complete native Responses history,
  once per request, on the same provider/model/key and within existing budgets. Tool pairing and
  encrypted reasoning are retained. Arbitrary 400 errors, missing history, Anthropic/Chat tool IDs,
  and signatures are not rewritten.
- **Loopback only, literal Host.** The proxy and console accept only `127.0.0.1:port` or
  `[::1]:port`; `localhost` and custom domains get a 403. Write requests reject cross-site or
  cross-origin sources, and the proxy accepts only `Content-Type: application/json` POSTs.
  These checks stop browser pages from using your local service to spend keys or change config.
  They are **not authentication** and do not protect against other programs running under your
  account.
- **Plaintext credentials.** `providers.json` and the backup directories contain plaintext
  provider keys; `sessions.json` contains conversation labels; the onboarding undo ledger
  `client-managed.json` (`0600`) stores the pre-write values of managed client fields so they can
  be restored, and may therefore contain a token or key you had before onboarding. Do not sync
  the data directory to a public location or commit it to git. Remove keys and session content
  before sharing logs, and never post that ledger.
- **The compatibility test spends quota.** It sends up to three real generation requests
  (non-streaming, streaming, and tool call) to the selected provider; nothing is sent without
  explicit confirmation. The console's redacted diagnostic report contains no keys, config
  bodies, raw logs, prompts, session titles, usernames, or private paths, but review it before
  sharing.
- **Response archiving is off by default.** Upstream response bodies are stored only when
  `MIXR_RESPONSE_ARCHIVE=on` is set explicitly. Size limits and sensitive-content boundaries are
  in [CLI and runtime boundaries](docs/cli.md#5-压缩日志与归档) (Chinese).
- **Upstreams are not provided by this project.** Forwarding uses only the `base_url` and keys
  you configure. No provider is promised to be available, free, or stable; providers can always
  read request content in plaintext.
- **Source changes are not hot-reloaded.** Run the tests. A foreground `npm run local` has no
  pid file and is not managed by `mixctl`: stop it with Ctrl+C, rerun the same command, then run
  `npm run doctor` to confirm state. Only a background `./mixctl start` uses `./mixctl restart`;
  `./mixctl status` must then report the current source. A 200 from `/healthz` only means the
  process is alive.

## Development and tests

```bash
npm test                 # = node scripts/run-tests.js, runs test/*.test.js in an isolated environment
npm test -- test/codex.test.js   # one file, through the same isolated entry point
npm run smoke            # offline end-to-end acceptance; exit code 0 means all green
```

`npm test` uses a temporary `HOME`, a temporary data directory, and kernel-assigned ports, and
filters `MIXR_` / `MIXROUTER_` / `MIXUI_` variables from the caller's environment, so it never
touches real configuration. Running `node --test` directly skips that isolation. `npm run smoke`
starts a temporary instance with an in-process mock upstream; it does not use the network and
does not spend money.

**The two entry points have different test scopes.** A GitHub source clone has the full `test/`
suite, so `npm test` works. The Release runtime package does **not** contain `test/`, `.github/`,
or other development material, but keeps user documentation; `npm test` there explicitly reports
that the development suite is absent. Use `npm run smoke` to validate the runtime package. See
[CONTRIBUTING.md](CONTRIBUTING.md) for submission requirements.

## Support, contributing, and security

- **Questions and bugs.** Check the documentation first, then use
  [Issues](https://github.com/yange0793-dot/mixrouter-oss/issues). This is a community-maintained
  open-source project: it has no commercial support or SLA and does not promise a fixed response
  time. Scope is described in [SUPPORT.md](SUPPORT.md).
- **Code contributions.** See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Security vulnerabilities.** **Do not open a public issue.** Use the private GitHub reporting
  channel described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
