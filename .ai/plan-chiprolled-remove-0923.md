# Plan: remove chiprolled.hvl from the demo corpus (2026-09-23)

## Decision and dupe fact

- Morten, 2026-09-23 08:50: **"Chiprolled can be discarded."**
- Fact, md5-proven: `public/demos/ahx/chiprolled.hvl` =
  `0af72bfefc975982c8b8d03c7e1127ab` — byte-identical to Xeron's ModLand
  `"never gonna give you up.hvl"`. The embedded title already reads
  "never gonna give you up"; the *filename* was the mislabel. Recorded earlier in
  `.ai/plan-hvl-corpus-0923.md` (surprise 3 + landing note). The file was the only
  copy in the corpus (no `never gonna give you up.hvl` file existed), so removal
  drops the song entirely — that is the decision.

## Landed (coder run, branch `agent/chiprolled-remove-0923a`)

Commit `7c208866` (on top of `6123b5f4` = main at 2026-09-23 ~08:52):

- Deleted `public/demos/ahx/chiprolled.hvl`; `public/demos/index.json` re-indexed
  via `scripts/refresh-demos.sh` (237 modules, chiprolled entry gone).
- JS pins re-measured fresh: corpus files 100→99, instruments 1542→1531,
  `.hvl` 23→22; writer (B) model-alone byte-identical 92→91 (chiprolled measured
  byte-identical before deletion); writer (A)/fixed point 100→99; exporter corpus
  23→22.
- JS fxb second-effect-column coverage retargeted to `sliding_away.hvl`
  (both-columns row: track 1 row 0; column-2-only row: track 4 row 2 via
  position 7, channel 3 — all measured through the parser + projection).
- Wide-HVL fixture swaps chiprolled→illuminated in ahx-writeback,
  song-export-dialog, song-export-registry, tracker-playback-ahx-routing
  (illuminated also reaches track 6, so AHX-refusal reason texts are unchanged).
- Gates 08:57–09:00: test:run 235 files / 3834 tests all passed, eslint 0,
  vue-tsc 0, gitleaks clean, check:artifacts ok.

## Review FAIL fix (rust-wasm test hygiene, second commit on the same branch)

Review found chiprolled pins in `rust-wasm/tests/` that would panic on the
missing fixture. Fixes, all test-hygiene, no engine (`src/`) changes:

- `ahx_format.rs`: sniff-list entry removed (redundant — other HVLs sniffed);
  golden header + instrument-1 tests retargeted to `sunspots.hvl` (same coverage
  class: 6-channel HVL; instrument 1 PList keeps the direct-4-bit-FX claim with
  raw `fx=4` in entry 0's second column), values re-measured via the Rust parser;
  sweep-table row dropped.
- `ahx_render_golden.rs`: `chiprolled_matches_reference` deleted (per-fixture
  test of a deleted fixture); `hvl_ignores_the_defstereo_argument` retargeted to
  sunspots (see manifest); `("chiprolled.hvl", 6)` row dropped from the
  native-channels table (three other 6-channel HVLs keep the class).
- `golden/cases.manifest`: 7 chiprolled rows removed; the 7 `chiprolled.*.txt`
  goldens deleted with them; 2 new rows added — `sunspots.hvl 48000 s0/s4 cap4`
  — so the defstereo-ignores coverage keeps three s0/s2/s4 goldens. Generated
  with the vendored C reference (`gen_goldens.sh`'s exact gcc invocation,
  absolute `REF` path because the worktree's `.ai/` has no references dir).
  Drift check: regenerating the existing `sunspots.48000.s2.cap4.txt` with the
  freshly built tool is byte-identical; the three sunspots s0/s2/s4 goldens
  differ only in their `case` metadata line, all audio hashes equal.
- `ahx_capture.rs` / `ahx_mute_solo.rs` / `ahx_seek.rs`: chiprolled dropped from
  the SONGS arrays; HVL coverage stays via `sunspots.hvl` in each; no unique
  coverage lost.
- Pre-existing debt NOT touched: `cases.manifest` still covers only the original
  fixture set (not the 16-song curated batch), so the manifest-coverage
  assertion keeps failing for exactly the same pre-existing reason.

## Verification

Recorded after the gates run (cargo before/after failure lists + JS gate table)
in the landing report for this branch.
## Landing record (2026-09-23, agent/chiprolled-remove-0923a)

Merge: `6d02f6d2` (`git merge --no-ff` into main, message: "Merge chiprolled.hvl removal
(byte-identical dupe of 'never gonna give you up.hvl', discarded per Morten 08:50)").
Branch tip reviewed: `023c7c53` (delta re-review PASS; base `6123b5f4`); main pre-merge
`6123b5f4` = `origin/main`, worktree clean, no `.ai/worktree-owner` claim, no other writer.

### Review reference

Delta re-review **PASS** on fix commit `023c7c53` (dropped/retargeted chiprolled pins).
Cargo gates pre-existing state: 267 pass / 1 fail, the single failure being the known
pre-existing `manifest_covers_every_fixture` (cases.manifest covers only the original
fixture set, not the 16-song curated batch) — not introduced by this branch.

### Post-merge gates on main (real exit codes, this run)

| Gate | Result | Exit |
|---|---|---|
| vitest (full) | 235 files / 3834 tests passed (62.5s) | 0 |
| eslint | no findings | 0 |
| vue-tsc --noEmit | clean | 0 |
| gitleaks detect --no-git | no leaks (3.43 GB scanned, 1m24s) | 0 |
| npm run check:artifacts | worklets + wasm match sources | 0 |

Note: `npm run gitleaks` has no package script in this repo ("Missing script: gitleaks");
the direct `gitleaks detect --no-git` was used, which is clean.

### Push

`git push origin main`: `6123b5f4..6d02f6d2 main -> main`, exit 0, no force.

### Deploy

`scripts/deploy.sh` (repo-root `deploy.sh` does not exist; the script lives at
`scripts/deploy.sh` with the exact same defaults) →
`avatar@192.168.50.161:~/repos/docker-info-ws-server/html/synth`.
Build succeeded (spa mode); wasm rebuilt per script design (bytes vary run-to-run is
benign; freshness via `SOURCE_HASH.json`); script self-verification
`Deployed and verified (2f5ed95176293785eb615b5725a68487)` (index.html md5); deploy exit 0.

**Fresh md5 spot-check (local `dist/spa` ↔ remote, all identical): 4/4**

| File | md5 |
|---|---|
| index.html | `2f5ed95176293785eb615b5725a68487` |
| demos/index.json | `1af2ad61f3036704122cfb3fd97c4d0a` |
| wasm/audio_processor_bg.wasm | `178c2b860fdf34c6e17b5afd817bfaae` |
| worklets/ahx-worklet.js | `0b1e28a2d692f80a2f9fc3a46d77f1e6` |

### Remote chiprolled.hvl absence proof (this run)

- `grep -c chiprolled ~/…/html/synth/demos/index.json` → **0** references.
- `test -e demos/ahx/chiprolled.hvl` on the remote → **absent** (`REMOTE_CHIPROLLED_ABSENT`).

### Worktree

`.ai/worktrees/chiprolled-remove`: clean at merge time; no owner marker present to clear.
