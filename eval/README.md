# scrutiny eval

black-box eval harness for pi-scrutiny. runs the real `pi` command path per task (same path users hit), parses the JSON event stream + on-disk `result.json`, checks expectations, emits a markdown + json report.

no internal api coupling. no new dependencies. node native type-stripping (`--experimental-strip-types`).

## run

```bash
npm run eval:smoke          # runs eval/out/{smoke.report.md,json}
npm run eval:templates      # panel/template resolver and migration contract
npm run eval:setup          # first-use panel setup and persistence contract
npm run eval:coverage       # unit-level surface catalog coverage (no subprocesses)
npm run eval:scout         # unit-level context scout test (mock exec, no subprocesses)
npm run eval:artifacts     # unit-level artifact memory test (temp cwd, no subprocesses)
npm run eval:verify        # unit-level objective verify test (fake exec, no subprocesses)
npm run eval:normalize     # unit-level surface normalization test (fixtures, no subprocesses)
```

exit code is non-zero if any task fails or errors.

## importing extension modules from node tests

extension sources keep `.js` import specifiers for pi/bun compatibility, which node `--experimental-strip-types` cannot resolve on its own. `eval/_ts-resolve.ts` registers an in-process resolve hook (no deps) that remaps relative `.js` specifiers to `.ts` when the `.ts` file exists, so unit tests can import extension modules directly. tests that need it run with `node --import ./eval/_ts-resolve.ts --experimental-strip-types eval/<test>.ts`.

## template suite (`eval:templates`)

Unit-level contract suite for config v2. It validates named panel/template parsing, built-in template validation, panel/template composition and precedence, legacy migration behavior, forbidden strategy/lens combinations, roles cardinality and uncovered lenses, prompt identity/lens preservation, roles coverage semantics, and invalid-config artifact gating. Uses a temporary config and fake executor; no model calls.

## setup suite (`eval:setup`)

not black-box. drives the real palette/setup components with a fake TUI and authenticated-model registry, plus temporary global config. It covers the unconfigured state, task/template/toggle preservation, no automatic run after save, v2 global save/reload with `0600` permissions, explicit collision handling, no-model login guidance, non-interactive exit, thinking-level capabilities, and verify without a panel. No credentials, model calls, or subprocesses.

## coverage suite (`eval:coverage`)

not black-box. imports the surface catalog and built-in templates directly. It asserts that surface identity, prompts, hints, action lines, docs, and routing remain catalog-owned, while strategy, lenses, and policies live only in templates. Fast, no model keys or `pi` subprocesses.

## scout suite (`eval:scout`)

not black-box. imports `runContextScout` / `renderScoutMarkdown` / `pruneScoutCandidates` and exercises them with a mock exec + temp cwd: ranked candidates get stable `c0/c1...` ids, gaps (`no-tests`, `no-docs-config`, `no-anchors`, ...) are first-class data, and packet-preview pruning toggles by candidate id and rebuilds the scout section. uses the `_ts-resolve` hook to import extension sources. no model keys, no `pi` subprocesses.

## artifacts suite (`eval:artifacts`)

not black-box. imports `artifacts.ts` (which has no relative runtime imports, so no resolve hook needed) and exercises the `.pi/scrutiny` layout: data/run/index paths, surface artifact filenames, path-guarded artifact resolution, file hashing, freshness (fresh/stale/unknown), summary index append + load (sorted newest-first), index repair by scanning run dirs, related-summary lookup, and safe delete/clear (config untouched, escape refused). also scans extension sources to fail if anyone re-introduces layout logic outside `artifacts.ts`. no model keys, no `pi` subprocesses.

## verify suite (`eval:verify`)

not black-box. imports `verify.ts` via the `_ts-resolve` hook and exercises `runVerifyChecks` with a fake exec: pass/fail/error status from exit codes, output truncation, per-check progress events (running -> terminal), empty check list, diff-stat capture, `verifyProgressMessage` formatting, and the verify status policy (`classifyVerifyRun`: completed verify = ok run; check failures are findings). also scans `engine.ts` to fail if verify execution is re-declared outside `verify.ts` and that the dead `verify_failed` reason is gone. no model keys, no real subprocesses.

## normalize suite (`eval:normalize`)

not black-box. imports `normalize.ts` (type-only relative imports, no resolve hook needed) and exercises `normalizeSurface` with messy panel Markdown fixtures per surface: hypotheses (root causes/evidence/tests/missing), risks (findings grouped by risk class with severity + suggested check), criteria (criteria/edge cases/test cases/migration), repo-map (symbols/call paths/tests/configs + file-path extraction), consult (position/evidence/risks/recommendation), verify (marker), and empty/error responses (undefined). no model keys, no `pi` subprocesses.

## what the smoke suite checks (no model keys needed)

- `help`, `models` — command paths emit clean messages.
- `verify-ground-truth` — the `verify` surface runs objective repo checks against this repo. known ground truth: typecheck passes, tests+lint fail (missing npm scripts). this is the real arbiter eval: 6 assertions over pass/fail counts and per-check status.
- `missing-panel-gate` — non-interactive deliberation with no panel returns concise TUI setup guidance and creates no run artifacts.

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
