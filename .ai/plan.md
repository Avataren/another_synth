# Plan — Add the missing docstring to the `clamp` helper

## Selected issue (exactly one)
The private helper `clamp` in `src/audio/utils/sampler-detune.ts` has **no docstring**, while every other function in that module does. It is a short, simple, pure function — exactly the task's "missing docstring on a short simple function" case. We add the one missing docstring and change nothing else.

## File & location
- **File (absolute):** `/home/openclaw/.openclaw/workspace/another_synth/src/audio/utils/sampler-detune.ts`
- **Location:** the `clamp` function declaration, **line 12**. The signature line below is **unique in the file** and is the exact anchor for the edit:
  - Current text (the line used as the edit anchor):
    `function clamp(value: number, min: number, max: number): number {`

## Exact change (verbatim)
Insert a JSDoc block **immediately before** the declaration; the declaration line itself is preserved unchanged. Net effect: 5 comment lines added, zero code changed.

- **Current text (unique anchor):**
```
function clamp(value: number, min: number, max: number): number {
```
- **Replacement text (verbatim):**
```
/**
 * Clamp `value` to the inclusive range [min, max].
 *
 * NaN is treated as `min` so a bad input falls back to a defined bound
 * instead of propagating.
 */
function clamp(value: number, min: number, max: number): number {
```

The docstring is accurate to the body, which is:
```
if (Number.isNaN(value)) {
  return min;
}
return Math.min(Math.max(value, min), max);
```
i.e. bounds non-NaN input to `[min, max]`, and maps `NaN` → `min`.

## Why this is the safest / most clearly-correct candidate
- **Purely additive:** no existing text is rewritten, so there is no pre-existing intent to conflict with.
- **Objectively verifiable:** the behavior is fully visible in the 3-line body, so the description is provably correct (range `[min, max]`; `NaN` → `min`).
- **Exactly the target shape:** a ~5-line pure function with no side effects ("short simple function").
- **Restores consistency:** it is the lone docstring gap in an otherwise fully-documented module.
- **Syntactically inert:** a JSDoc block cannot affect type-checking, ESLint, Prettier, the build, or runtime.

### Candidates considered and rejected
- `build-demo-manifest.mjs` — the word "unrecognised" (British spelling) appears once in a `console.warn`. Rejecting because it may be intentional and "fixing" it is a judgment call, not a clear defect.
- `README.md` — inconsistent `##` vs `###` heading levels under "Install the dependencies". Rejecting because it is a heading-style choice, not an unambiguous typo.

The `clamp` docstring is the only candidate that is both unambiguously correct and impossible to make wrong.

## Risk level
- **trivial** — documentation/comment only. **No behavior change** (confirmed: a comment cannot alter compilation or execution).
- **None** of the pipeline's stop-for-user categories are triggered: no auth/credentials, CI/CD, deploy, dependency, DB migration, or OS/network/infra impact.

## Acceptance-criteria mapping
- `task.md` lists **no explicit acceptance criteria** (that section is empty). This change satisfies the stated **Goal**: "Find one small, safe documentation or comment issue (typo, missing docstring on a short simple function) and fix it." — specifically, a missing docstring on a short simple function.
- Suggested verification for the coder (all should pass with only 5 comment lines changed):
  - `npm run lint` passes
  - repo type-check passes (e.g. `npx vue-tsc --noEmit`)
  - `git diff` shows exactly the 5 added JSDoc lines and nothing else

## Notes for the coder
- Apply as a **single find-and-replace** on the unique anchor line shown above; leave the function body and every other line untouched.
- Keep the JSDoc block exactly as written (Prettier-compatible, all lines short).
- **Do not** add or rewrite any other docstring, comment, or code anywhere — the task scope is exactly this one issue.
- Commit on the `agent/<task-slug>` branch; do not push.
