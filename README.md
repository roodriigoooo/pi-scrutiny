# pi-scrutiny

a pi extension for multi-model deliberation and objective repo verification.

the spark was openrouter fusion: send a hard prompt to a panel of models and use the combined signal. but that spark only holds for **bounded, research-style synthesis**. it is not strong evidence that fusing model outputs helps long-horizon coding.

so this extension is built around a stricter idea:

> do not fuse patches. fuse hypotheses, constraints, risks, and verification strategies. then let one coding agent act against the repo and tests. the arbiter is objective repo tools and sometimes human review — never an llm judge.

this is scrutiny as consultation, not scrutiny as democracy, and not scrutiny of final code.

## what it does

one tool, `scrutiny_consult`, and one command, `/scrutiny`, expose six **surfaces**. each surface produces a distinct non-patch artifact:

```text
consult      bounded research/synthesis. trade-off explainer runs by default.
hypotheses   ranked root causes + confirming evidence + minimal distinguishing tests. no fix yet.
criteria     fused acceptance spec: edge cases, backward-compat, migration, test cases.
repo-map     compact context (symbols, call paths, tests, config, invariants) for an upcoming edit.
risks        per-class risk review of a patch (concurrency, reactive-chain, api-compat, security, perf, migration, null, flaky). runs verify.
verify       runs tests/typecheck/lint as the objective arbiter. no panel, no judge. blocks.
```

deliberation surfaces run **inline** and stream compact status chips while the panel works; `verify` blocks on objective checks. the main pi agent synthesizes and acts.

## principles

- **arbiter is objective, not textual.** correctness is decided by tests, type checks, static analysis, runtime, diff size, architecture constraints, and sometimes human review. an llm judge is weak as the final arbiter of a repo-wide change.
- **do not fuse patches.** fusing N patches into one frankenstein diff that no model validated is the failure mode to avoid. fuse uncertainty, evidence, tests, plans, context, risks.
- **disagreement is a stop signal.** if panelists disagree sharply, that means gather more evidence, run a narrower test, or ask the human — not smooth it into a synthesized answer.
- **judge demoted to trade-off explainer.** it never decides correctness. it only explains trade-offs, and only runs for `consult` by default.
- **simplicity is protected.** few surfaces, legible activation, simple model selection. the palette shows only the chips that matter for the chosen surface.

## why not just use subagents?

pi subagents and docket workers already do fanout. the point here is the layer around it:

- task packet builder
- per-surface panel lenses and prompt schemas
- compact structured return + disagreement stop-signal
- replicated input budget awareness
- objective `verify` as the real arbiter
- out-of-context storage of full panel outputs under `.pi/scrutiny/<run-id>/`
- a quiet tui for seeing what happened

the runner inside this repo is intentionally tiny and swappable. long term it should sit on the subagent or docket substrate.

## configure

preferred: edit config inside pi:

```text
/scrutiny config edit           # global ~/.pi/agent/scrutiny.json
/scrutiny config edit project   # project .pi/scrutiny.json (trusted projects only)
/scrutiny config                # show active config + sources
```

example `scrutiny.json`:

```json
{
  "panel": ["openai-codex/gpt-5.4-mini", "opencode-go/kimi-k2.7-code"],
  "judge": "openai-codex/gpt-5.4-mini",
  "verifyChecks": [{ "name": "typecheck", "command": "npm", "args": ["run", "check"] }],
  "councils": {
    "code-duo": {
      "surface": "risks",
      "panelists": [
        { "model": "openai-codex/gpt-5.4-mini", "lens": "concurrency" },
        { "model": "opencode-go/kimi-k2.7-code", "lens": "reactive-chain" }
      ],
      "verify": true,
      "judgeMode": "off"
    }
  }
}
```

`PI_SCRUTINY_*` env vars still work and override config files for shell-specific experiments.

install locally:

```bash
pi install /Users/rosastre/.pi/scrutiny
```

or try it once:

```bash
pi -e ./extensions/scrutiny.ts
```

## use

```text
/scrutiny                                    # open palette (surface-first)
/scrutiny models
/scrutiny runs                               # recent runs + artifact paths (this session)
/scrutiny councils                           # list named council presets
/scrutiny config                             # show active config + sources
/scrutiny config edit                        # edit global config in pi
/scrutiny verify:                            # run objective checks now
/scrutiny @code-duo: review this patch       # run a named council
/scrutiny risks: review this webflux retry patch
/scrutiny hypotheses: intermittent offset commit on kafka consumer
/scrutiny criteria: migrate orders service to new idempotency key
/scrutiny ask compare these two implementation plans
```

or open the palette (`/scrutiny`) and press **ctrl+c** to cycle through configured council presets — the surface, panelists, and lenses update to match the council.

or let the main model call `scrutiny_consult` when the extra spend is worth it.

## flow

surfaces run **inline** and stream a compact status footer plus an active-run dock while the panel works — these show elapsed time, ready/thinking/failed counts, and current phase (panel / evidence map / verify). press **esc** to cancel a foreground run (native pi abort, propagated to panel subprocesses). deliberation can take time; that is expected and deliberate. flow protection here means legibility — surfaces are well-understood, reachable, and show what is happening — not minimal latency.

run tracking: a lightweight in-memory registry records each run (run-id, surface, status, runDir). `/scrutiny runs` lists recent runs with their artifact paths so you can inspect what happened. full outputs persist on disk under `.pi/scrutiny/<run-id>/` regardless of the registry.

the main pi agent synthesizes and acts on the evidence. the arbiter is objective repo tools + human review, never an llm judge.

## defaults

- 2 panelists is the intended shape for deliberation
- panel models run independently, `--no-tools` by default
- no auto-spend
- trade-off explainer skipped except `consult` (or `judgeMode: on`)
- `risks` and `verify` run objective repo checks
- full outputs saved under `.pi/scrutiny/<run-id>/` (`packet.md`, `responses.json`, `verify.json`, `result.json`)

## status

early. the reorientation from answer-scrutiny to deliberation+verify is in progress. patch tournament (N independent patches scored by objective checks) is deferred and opt-in only, because it is the most failure-prone surface.
