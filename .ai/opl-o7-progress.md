# O7 progress (A2M player) — handoff, 2026-09-27

Read with `.ai/plan-opl.md` (§3, §4, §6, O6 record) and `.ai/opl-next-session-prompt.md`.
Commits so far: `14f3f8d5`, `701d87fe`, `66e2fad3`, plus the batch-4 checkpoint after them.

## Where things stand

- `rust-wasm/src/opl/a2/engine.rs` — `A2Engine`: tick/row clock, effects, macros, 4-op pitch
  sharing (partial), percussion (AdPlug's routing). Emits register writes to a `RegisterSink`.
  `adplug_quirks` flag = reproduce AdPlug-only behaviour (on in the compare tool only).
- **Gate status (per-tick register STATE equal to AdPlug, 3000 ticks, `A2M_STATE=1`):** all
  v9+ tier-1 files pass **except ETWARAWK and fm-tronikk** (4-op volume lock, below). v5
  prehistorik also passes. v1 intro-tune / super mario and v5 little boring trance need the
  old-effect mapping (below). Write-*sequence* equality also holds for most; the remaining
  sequence-only differences write identical values (e.g. arpeggio restore with 18/19 when
  there is no arpeggio memory, probe `combomem18`). Use state equality as the gate: the chip
  samples register state between ticks, so equal state = equal audio.
- All ~260 probes pass (`oracle/dev/runprobes.sh`, state and sequence).
- Nothing is exported to wasm yet; no worklet, no app hookup (steps 3–5 of the O7 prompt).

## Oracle and tools (all black-box; AdPlug player source not read)

- `oracle/trace-oracle.cpp`: `trace <file> <ticks>` / `render <file> <sec> <out.wav>`.
  **Always run with `A2M_PLAYER=v2`**: `CAdPlug::factory` sends v1–8 to the old `Ca2mLoader`
  (a CmodPlayer conversion); `Ca2mv2Player` (AdPlug's AT2 port) loads every version. It
  mis-reads *stored* modules (v4/v8; none in the corpus). Bank-1 writes appear both as
  `setchip(1)` and as `0x1xx`; normalise to `reg | chip<<8`.
- `oracle/craft_a2m.py`: synthetic modules for versions 1, 5 (literal-only SixPack), 11
  (literal-only aPLib) and 12–14 (literal-only AT2 LZH). Keys: instruments, fm_macros,
  arp_macros, vib_macros, disabled, locks, flags, four_op, four_op_ins, speedup, ...
- `oracle/probes/*.py`: the regression probes (SPEC dicts). `oracle/dev/`: `probe.py`
  (craft + print AdPlug trace), `runprobes.sh`, `tier1.sh`, `cmp.sh`, `freqs.py`, `lin.sh`,
  `mapfx.py`/`mapext.py` (brute-force old→new effect mapping). They hard-code the session
  scratch path `S=...`; point `S` at a directory holding a built `trace-oracle`
  (`g++ -O1 trace-oracle.cpp -I$P/include -I$P/include/adplug -L$P/lib -ladplug -llibbinio`,
  `P=.ai/adplug-oracle/prefix`).
- `examples/a2m_tool.rs`: `dump`, `macros`, `info`, `features`, `effects`, `raw`,
  `mine <file> <ticks> <regs>`, `cmp <file> [ticks] [show]` (needs `A2M_ORACLE`; env
  `A2M_STATE=1` for state compare).

## Pinned rules worth knowing (details are commented in engine.rs as MEASURED)

Track→channel [3,0,4,1,5,2,6,7,8,12,9,13,10,14,11,15,16,17]; percussion mode moves tracks
7–9 to 15–17 and 16–20 to BD/SD/TT/TC/HH (one-op drums at ops 0x14/0x12/0x15/0x11, second
op at +0xFF, keyed via B7/B8 — AdPlug's behaviour, possibly a port bug; flagged for Morten's
ears). Row clock: first row after `speed` row ticks; row tick every `speedup` timer ticks, or
`floor(18·speedup/tempo)` for tempo < 18 (AdPlug then plays too slowly: its refresh is
tempo×speedup; engine.refresh() follows AT2, 18.2 Hz floor). Extra-fine effects on row ticks
≡ 3 mod 4. Default instrument of a track = track number. AdPlug arpeggio-table off-by-one
(relative steps read element pos+1) is reproduced only under `adplug_quirks`; play follows
AT2 (corpus chord tables prove intent). Macro TL column is a volume (63 − value), genuine.

## Old effect numbers (v1–4 → v9+), from `dev/mapfx.py 1` / `mapext.py 1 0f`

0→00, 1→01, 2→02, 3→07, 4→08, 5→03, 6→05, 7→04, 8→06 (probable; ambiguous with other
vslide combos), A→0C, B→0D, C→0B, D→0F, E→0E.
9xy: nibble volume: x≠0 → carrier volume 4x+3 (like 12), else y → modulator 4y+3 (like 09).
Fxy (extended), by x: 0→Z0y, 1→Z1y, 3→&4y (fine tune up; also matched 07 y),
4→&5y, 6→volume slide (0A-like, needs exact variant), 8→fine volume slide (14-like),
A→Z2y, B→Z3y, C→Z4y, D→Z5y, E→ZAy, 9→no effect. Still unknown: 2 (writes carrier
waveform group: `0f 21` set carrier wf 1 — check 13 with nibble swap), 5, 7, F.
v5–8 (0–0x23) not mapped yet: run `mapfx.py 5` and `mapext.py 5 <e>` for the extended ones.
Implement as a conversion table applied at row time for song.version < 9.

## Open items, in order

1. v1–8 effect conversion (above) → intro-tune, super mario, little boring trance.
2. 4-op volume lock (lock bit 6, 3 corpus files): volume effects act on the 4-op algorithm's
   output ops ((ch0.con, ch3.con): 00 → O4; 10 → O1,O4; 01 → O2,O4; 11 → O1,O3,O4);
   set-volume scales each output op's *instrument* TL by v; volume slides write one common
   TL to all output ops (arithmetic not pinned — see probe output in the transcript notes:
   after 0C 10 then 0A 02 all three read 0x31, 0x33). Or declare and explain the divergence.
3. Run the whole corpus (278 files) in state mode to find untested semantics; extend
   tick counts to full song length (until AdPlug's `ended`).
4. Commit the gate as a Rust test: per-file per-tick state hashes (e.g. FNV per 64-tick
   chunk) generated by a `regen` script from the oracle; plus the probe suite as TSV.
5. Steps 3–5 of the O7 prompt: `A2Player` wasm class (engine + `Chip` + resampler, stepped at
   `refresh()`), worklet or `opl-audio-processor` mode (load, play/pause, seek, loop,
   mute/solo, scope taps), tracker hookup like AHX/SID, truthful refusal at load.
6. Audio A/B vs AdPlug renders (`trace-oracle render`), CoT vs SB16 recording, Morten's ears,
   landing record in the plan.
