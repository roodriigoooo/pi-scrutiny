# pi-scrutiny

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-scrutiny.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-scrutiny)
[![CI](https://github.com/roodriigoooo/pi-scrutiny/actions/workflows/ci.yml/badge.svg)](https://github.com/roodriigoooo/pi-scrutiny/actions/workflows/ci.yml)

Multi-model deliberation and objective repository verification for the Pi coding agent.

## Why this exists

Scrutiny collects independent evidence from multiple models, then leaves the decision to objective repo checks and human review. It never fuses patches or treats an LLM judge as a correctness arbiter.

- Panels run a named lineup of models.
- Templates define a reusable deliberation method.
- Results are evidence for a later, explicitly requested action—not an automatic Pi turn or code edit.

Consultation, not democracy. Deliberation, not patch fusion.

## Concepts

**Panel = who runs.** A panel is only a named model lineup and optional thinking levels.

**Template = how a run executes.** A template selects a surface, deliberation strategy, role lenses when needed, packet context policy, judge policy, verify policy, and optionally a default panel.

Panels and templates are deliberately independent. Multiple templates can reuse one panel, and a template can run with a different selected panel.

### Deliberation strategies

- **replicate**: every model receives the exact same prompt. Agreement and sharp disagreement are signals; disagreement is a stop signal that calls for more evidence, a narrower test, or stopping.
- **roles**: each model receives one explicit lens. Coverage and gaps are signals; non-overlapping role output is not a contradiction.

For roles templates, the panel may have fewer members than lenses. Assignments use the ordered prefix (`member 1 → lens 1`, and so on), and remaining lenses are reported as uncovered. A roles panel may never have more members than template lenses.

`verify` is strategy-free: it runs objective checks with no model panel or judge.

## Surfaces

```text
consult      built-in replicate template for bounded research and synthesis
hypotheses   built-in replicate template for ranked root causes and tests
criteria     built-in replicate template for acceptance criteria
repo-map     built-in roles template for symbols, calls, tests, and config
risks        built-in roles template for explicit risk-lens review
verify       objective checks only; no panel and no judge
```

The built-in template names are reserved: `consult`, `hypotheses`, `criteria`, `repo-map`, `risks`, and `verify`.

## Activation boundary

Scrutiny starts only when you invoke `/scrutiny` or confirm through its palette. Natural-language requests do not start a run, and there is no model-callable Scrutiny tool.

Before any panel spend, the TUI shows the exact task packet and requires confirmation. It shows the selected template, panel, strategy, model-to-lens assignments, uncovered lenses, and spend estimate. Results persist and Pi remains idle: no synthesis, diagnostics, edits, or implementation start automatically.

## Configure

```text
/scrutiny config edit           # global ~/.pi/agent/scrutiny.json
/scrutiny config edit project   # project .pi/scrutiny.json (trusted projects only)
/scrutiny config                # sources, active panels/templates, diagnostics
```

Configuration sources merge in order: global → trusted project → environment. Named panels and templates merge by name; a later source replaces a same-named entry.

```json
{
  "schemaVersion": 2,
  "defaultPanel": "balanced",
  "panels": {
    "balanced": {
      "members": [
        { "model": "openai-codex/gpt-5.4-mini", "thinking": "low" },
        { "model": "opencode-go/kimi-k2.7-code", "thinking": "off" }
      ]
    }
  },
  "templates": {
    "release-risk": {
      "surface": "risks",
      "strategy": "roles",
      "panel": "balanced",
      "lenses": [
        "api compatibility",
        "failure semantics"
      ],
      "includeGitDiff": true,
      "judgeMode": "off",
      "verify": true
    }
  }
}
```

Panel resolution is deterministic:

```text
selected panel in palette or command → template.panel → defaultPanel
```

Run-only controls can override git context, judge mode, or verify policy without editing the saved template.

### Configuration rules

- Panel members cannot declare a lens.
- Every deliberation template requires `strategy`.
- Replicate templates must omit `lenses`, even an empty array.
- Roles templates require unique, non-empty lenses.
- A roles panel may contain `1..N` members where `N` is the template lens count.
- Verify templates omit strategy, lenses, panel, and judge policy.

Invalid configurations are rejected before scouting, packet preview, runner locks, or model subprocesses. They create no `packet.md` or `responses.json`.

### Migrating legacy configuration

No config file is rewritten automatically. A config without `schemaVersion: 2` is read through a temporary compatibility parser and reports a migration diagnostic with a v2 example.

- A legacy top-level `panel` becomes the synthetic `default` panel.
- A legacy saved bundled panel becomes a same-named v2 panel plus a same-named template whose default panel points to it.
- Legacy roles member lenses become the template’s effective lenses, including the historical fallback lenses.
- Legacy replicate member lenses are discarded because replicate execution never used them.

The legacy raw keys remain readable temporarily for migration, but public commands and documentation use only panels and templates.

## Use

```text
/scrutiny                                    # open the palette
/scrutiny models                             # current default lineup
/scrutiny panels                             # model lineups only
/scrutiny templates                          # strategy and policies
/scrutiny runs                               # recent run artifacts
/scrutiny history                            # searchable artifact history
/scrutiny config edit [project]              # edit v2 configuration
/scrutiny verify:                            # run objective checks
/scrutiny @release-risk: review this patch   # choose a template directly
/scrutiny risks: review this webflux retry patch
/scrutiny hypotheses: intermittent offset commit on kafka consumer
/scrutiny ask compare these two implementation plans
```

In the palette, `Tab` cycles templates and `Ctrl+P` cycles panels independently. Switching to `verify` hides the panel without deleting the retained selection.

## Runtime and artifacts

Panelists run sequentially, one at a time, in `pi` subprocesses with tools disabled by default. The engine records template, panel, strategy, assignments, and unassigned lenses in `result.json` and per-surface artifacts.

Runs persist under `.pi/scrutiny/<run-id>/`:

```text
packet.md        # only after valid config and packet confirmation
responses.json   # only after models begin
result.json
summary.json
<surface>.json
verify.json       # when verify ran
```

`/scrutiny history` reads the persisted summary index. Objective repo checks—not textual synthesis—remain the correctness arbiter.

## Development

```bash
npm install
npm run check
npm run eval:templates
npm run eval:boundaries
npm run eval:coverage
npm run eval:scout
npm run eval:artifacts
npm run eval:verify
npm run eval:normalize
npm run pack:dry
```

The package preserves explicit activation, packet confirmation, inline/idle completion, and no automatic agent turn.
