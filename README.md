# pi-scrutiny

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-scrutiny.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-scrutiny)
[![CI](https://github.com/roodriigoooo/pi-scrutiny/actions/workflows/ci.yml/badge.svg)](https://github.com/roodriigoooo/pi-scrutiny/actions/workflows/ci.yml)

multi-model deliberation and objective repo verification for the pi coding agent.

## why this exists

openrouter fusion sends one hard prompt to several models at once and merges the answers. it works well for bounded research questions where you want diverse priors on the same problem. that was the original inspiration for this extension.

but fusion is not evidence that fusing model outputs helps with long-horizon coding. multi-turn coding workflows involve editing files, running tests, reading feedback, iterating. no amount of parallel prose from language models settles whether a change to a real repo is correct. tests, type checks, and human review do that.

so scrutiny takes the part of fusion that is grounded (independent perspectives on a shared question) and drops the part that is not (textual merging as a correctness signal). what you get is:

- send a hard question to a panel of models, each answering independently from the same packet
- fuse hypotheses, constraints, risks, and verification strategies, never patches
- let one coding agent act against the repo and tests
- the arbiter is objective repo tools, not an llm judge

consultation, not democracy. deliberation, not patch fusion.

## what it does

one tool, `scrutiny_consult`, and one command, `/scrutiny`, expose six **surfaces**. each produces a distinct non-patch artifact:

```text
consult      replicate mode: bounded research/synthesis. trade-off explainer runs by default.
hypotheses   replicate mode: ranked root causes + confirming evidence + minimal distinguishing tests. no fix yet.
criteria     replicate mode: acceptance spec: edge cases, backward-compat, migration, test cases.
repo-map     roles mode: compact context (symbols, call paths, tests, config, invariants) for an upcoming edit.
risks        roles mode: per-class risk review of a patch (concurrency, reactive-chain, api-compat, security, perf, migration, null, flaky). runs verify.
verify       no panel: runs tests/typecheck/lint as objective arbiter. no judge. blocks.
```

## panel modes

two epistemic instruments, not stylistic variants:

- **replicate** (`consult`, `hypotheses`, `criteria`): every panelist gets the same prompt. diversity comes from model priors. the signal is agreement or disagreement. sharp disagreement is a stop signal: gather more evidence, run a narrower test, or ask the human. do not smooth it into a synthesized answer.

- **roles** (`repo-map`, `risks`): each panelist gets a different lens. diversity comes from task-splitting. the signal is coverage and gaps, not conflict. a concurrency reviewer saying "avoid X" and a security reviewer not mentioning X is not a disagreement. it is coverage of different facets.

the analysis layer is honest about which mode it is in. disagreement is computed only in replicate mode. roles mode computes coverage and gaps instead.

## how calls happen

panelists run **sequentially**, one at a time. each panelist is a `pi` subprocess (`pi --mode json -p --no-session --model <model> --no-tools <prompt>`) that receives the full task packet and returns its analysis as structured markdown. the engine collects each response, then builds a deterministic evidence map (shared vocabulary, contradictions, unique insights, risks, coverage/gaps). optionally, a trade-off explainer model compares the panel outputs. optionally, verify runs objective repo checks.

only one scrutiny run can be active at a time. if you call `/scrutiny` while a run is in progress, the second call is rejected with a clear message. this is deliberate: parallel scrutiny runs would compete for provider rate limits, make progress harder to read, and add cost without adding signal.

## principles

- **arbiter is objective, not textual.** correctness is decided by tests, type checks, static analysis, runtime, diff size, architecture constraints, and sometimes human review. an llm judge is weak as the final arbiter of a repo-wide change.
- **do not fuse patches.** fusing N patches into one frankenstein diff that no model validated is the failure mode to avoid. fuse uncertainty, evidence, tests, plans, context, risks.
- **disagreement is a stop signal only in replicate mode.** same-prompt panelists disagreeing on a load-bearing point means gather more evidence. role-lens panelists not overlapping means coverage, not conflict.
- **sequential, not parallel.** panelists run one at a time. one run at a time. scrutiny is deliberation, not a race.
- **judge demoted to trade-off explainer.** it never decides correctness. it only explains trade-offs, and only runs for `consult` by default.
- **simplicity is protected.** few surfaces, legible activation, simple model selection.

## configure

```text
/scrutiny config edit           # global ~/.pi/agent/scrutiny.json
/scrutiny config edit project   # project .pi/scrutiny.json (trusted projects only)
/scrutiny config                # show active config + sources
```

example `scrutiny.json`:

```json
{
  "panel": [
    { "model": "openai-codex/gpt-5.4-mini", "thinking": "low" },
    { "model": "opencode-go/kimi-k2.7-code", "thinking": "off" }
  ],
  "judge": "openai-codex/gpt-5.4-mini",
  "verifyChecks": [{ "name": "typecheck", "command": "npm", "args": ["run", "check"] }],
  "panels": {
    "code-duo": {
      "surface": "risks",
      "members": [
        { "model": "openai-codex/gpt-5.4-mini", "lens": "concurrency", "thinking": "low" },
        { "model": "opencode-go/kimi-k2.7-code", "lens": "reactive-chain", "thinking": "off" }
      ],
      "verify": true,
      "judgeMode": "off"
    }
  }
}
```

`councils`/`panelists` still work as old aliases for `panels`/`members`. `PI_SCRUTINY_*` env vars still work and override config files.

## install

Pi Scrutiny is published on npm as [`@roodriigoooo/pi-scrutiny`](https://www.npmjs.com/package/@roodriigoooo/pi-scrutiny).

Install it globally for pi:

```bash
pi install npm:@roodriigoooo/pi-scrutiny
```

Or install it for a single project:

```bash
pi install -l npm:@roodriigoooo/pi-scrutiny
```

Pin a specific version when you need reproducible installs:

```bash
pi install npm:@roodriigoooo/pi-scrutiny@0.1.0
```

You can also install directly from GitHub:

```bash
pi install git:github.com/roodriigoooo/pi-scrutiny
```

For local development from a checkout:

```bash
git clone https://github.com/roodriigoooo/pi-scrutiny.git
cd pi-scrutiny
npm install
npm run check
pi install "$(pwd)"
```

To try the extension for one session without installing it:

```bash
pi -e ./extensions/scrutiny.ts
```

After installation, restart pi and run `/scrutiny help`.

## use

```text
/scrutiny                                    # open palette (surface-first)
/scrutiny models
/scrutiny runs                               # recent runs + artifact paths (this session)
/scrutiny history                            # interactive searchable artifact history
/scrutiny history list retry                 # text history for scripts
/scrutiny panels                             # list saved panel presets
/scrutiny config                             # show active config + sources
/scrutiny config edit                        # edit global config in pi
/scrutiny verify:                            # run objective checks now
/scrutiny @code-duo: review this patch       # run a saved panel
/scrutiny risks: review this webflux retry patch
/scrutiny hypotheses: intermittent offset commit on kafka consumer
/scrutiny criteria: migrate orders service to new idempotency key
/scrutiny ask compare these two implementation plans
```

press **ctrl+p** in the palette to cycle through saved panels.

or let the main model call `scrutiny_consult` when the extra spend is worth it.

## flow

surfaces run **inline** and stream a compact status line while the panel works. press **esc** to cancel. deliberation takes time; that is expected.

runs persist on disk under `.pi/scrutiny/<run-id>/` (`packet.md`, `responses.json`, per-surface JSON, `verify.json`, `result.json`). `/scrutiny history` opens searchable artifact history backed by `.pi/scrutiny/index.jsonl`.

every brief ends with one machine-actionable line: `RECOMMENDED NEXT ACTION: ...`. that is what the main agent acts on. prose lives in the expanded view and history.

## release

Releases are handled by GitHub Actions:

- `CI` runs on pushes and pull requests, then typechecks and verifies package contents with `npm pack --dry-run`.
- `Release` is a manual workflow. Choose a semver bump and npm dist tag; it runs the same verification, bumps `package.json` and `package-lock.json`, pushes the release commit and tag, publishes to npm with provenance, and creates the GitHub release.

To publish from GitHub, add an npm automation token with publish access as the repository secret `NPM_TOKEN`.

## defaults

- 2 panelists is the intended shape for deliberation
- `consult`, `hypotheses`, `criteria` use replicate mode (same prompt, disagreement is signal)
- `repo-map`, `risks` use roles mode (assigned lenses, coverage/gaps is signal)
- panelists run sequentially, one at a time, `--no-tools` by default
- only one scrutiny run active at a time
- panel timeout: 180s per panelist (configurable via `PI_SCRUTINY_PANEL_TIMEOUT_MS`)
- no auto-spend
- trade-off explainer skipped except `consult` (or `judgeMode: on`)
- `risks` and `verify` run objective repo checks
