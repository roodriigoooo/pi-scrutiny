# scrutiny eval

black-box eval harness for pi-scrutiny. runs the real `pi` command path per task (same path users hit), parses the JSON event stream + on-disk `result.json`, checks expectations, emits a markdown + json report.

no internal api coupling. no new dependencies. node native type-stripping (`--experimental-strip-types`).

## run

```bash
npm run eval:smoke          # runs eval/out/{smoke.report.md,json}
npm run eval:coverage      # unit-level surface catalog coverage (no subprocesses)
```

exit code is non-zero if any task fails or errors.

## coverage suite (`eval:coverage`)

not black-box. imports the surface catalog (`extensions/scrutiny/surfaces.ts`) directly and treats `SCRUTINY_SURFACES` as the source of truth, asserting every surface is wired with defaults, prompt specs, lenses, palette hints, action lines, docs, mode lines, and correct prompt→surface routing. also scans extension sources to fail if anyone re-introduces a per-surface table outside the catalog. fast, no model keys, no `pi` subprocesses.

## what the smoke suite checks (no model keys needed)

- `help`, `models` — command paths emit clean messages.
- `verify-ground-truth` — the `verify` surface runs objective repo checks against this repo. known ground truth: typecheck passes, tests+lint fail (missing npm scripts). this is the real arbiter eval: 6 assertions over pass/fail counts and per-check status.
- `missing-panel-gate` — deliberation with no panel configured returns a non-synthesizing failure (`failure_reason: missing_panel`), not a synthesized answer from nothing.

## adding a panel/deliberation suite

deliberation surfaces (`consult`, `hypotheses`, `criteria`, `repo-map`, `risks`) need real model keys + a panel env. those evals need planted-bug repos or known-answer tasks to have objective ground truth — a judge model is NOT the arbiter per the extension's own principle.

to add one:

1. create `eval/<suite>.ts` exporting an `EvalTask[]` + meta, mirroring `suites.ts`.
2. register it in the `SUITES` map in `run-eval.ts`.
3. add an npm script `eval:<suite>`.
4. write expectations against `ctx.result` (the parsed `result.json`) and/or `ctx.stdout`. prefer objective checks (verify pass/fail, artifact schema, disagreement-signal presence) over prose quality.

tasks with `requiresPanel: true` and no `PI_SCRUTINY_PANEL` in env are recorded as `skipped` so a suite can degrade gracefully when keys are absent.

## shape of an expectation

```ts
{ name: "typecheck passes", check: (ctx) => Boolean(ctx.result?.verify?.checks?.find(c => c.name === "typecheck" && c.status === "pass")) }
```

`ctx` = `{ result?: ScrutinyResultJson; stdout: string }`. throw to record an error for that expectation.
