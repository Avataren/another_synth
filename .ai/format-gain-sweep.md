# Per-format output level (2026-09-28)

**Problem:** at 100% master volume, MOD/XM/S3M overdrove the limiter hard
while SID and AHX sat well under it, so the volume slider had to be
re-set for each kind of song.

**Fix:** `src/audio/tracker/format-output-gain.ts` gives each format a fixed
trim. `TrackerSongBank.formatTrim` applies it: a `GainNode` after the master
bus and the OPL chip, and before the post-fx rack. It is set from
`playbackStore.loadSong`, which every format passes through.

| format | trim |
| --- | --- |
| native | 0 dB |
| MOD, ≤4 channels | −4 dB |
| MOD, >4 channels | −6 dB (a PC-tracker module, mixed like XM) |
| XM | −6 dB |
| S3M, samples and AdLib | −6 dB |
| AHX / HVL | 0 dB |
| A2M | 0 dB |
| SID (PSID/RSID, GoatTracker) | +3 dB |

## Method

- **Setup:** real app in headless Chrome (`--mute-audio`), dev server,
  jukebox page, one song at a time. User volume was 1.
- **Meter:** an AudioWorklet on `audioSystem.destinationNode`, which is
  pre-limiter and after everything else. It records the sample peak, a
  0.25 dB histogram, and the mean square of 400 ms blocks.
- **Duration:** 50 s from the start of each song. The context ran at
  96 kHz.
- **Loudness:** the mean of the 400 ms blocks within 10 dB of the song's
  ungated mean, in dBFS. It is a rough LUFS stand-in with no K-weighting.
- **Harness:** `format-gain-sweep/`: `sweep.sh` runs 4 Chrome/driver pairs,
  and `analyze.mjs` summarises the results. Per-song numbers, before the
  trim, are in `format-gain-sweep/results.tsv`.

## Before the trim (136 songs)

The level columns are in dBFS; the last column is the share of songs that
peaked over full scale.

| group | n | peak median | peak p80 | p99.9 median | p99.9 p80 | loudness median (range) | peaked > 0 dBFS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MOD 4ch | 15 | +4.6 | +6.8 | +2.0 | +4.5 | −9.6 (−20.6..−4.6) | 93% |
| MOD >4ch | 2 | +11.5 | +12.1 | +8.1 | +8.3 | −3.1 | 100% |
| XM | 18 | +8.0 | +9.9 | +3.5 | +6.5 | −9.0 (−20.1..−2.7) | 94% |
| S3M | 20 | +8.2 | +11.4 | +3.9 | +6.8 | −9.9 (−18.5..−0.2) | 100% |
| S3M AdLib | 14 | +4.9 | +6.6 | +1.9 | +4.3 | −8.9 (−15.7..−0.9) | 86% |
| A2M ≤9ch | 11 | −0.7 | +0.1 | −3.0 | −1.0 | −12.8 (−18.1..−7.6) | 45% |
| A2M >9ch | 16 | −0.2 | +0.2 | −3.1 | −0.8 | −14.1 (−28.6..−8.2) | 44% |
| AHX | 8 | −2.2 | −1.1 | −3.6 | −3.0 | −12.9 | 0% |
| HVL | 6 | 0.0 | 0.0 | −2.1 | −1.8 | −13.4 | 0% |
| GoatTracker | 10 | −3.3 | −2.4 | −6.5 | −5.5 | −17.6 | 0% |
| PSID | 16 | −3.2 | −2.1 | −6.0 | −5.3 | −17.2 | 0% |

The limiter's ceiling is −1.5 dBFS. Each trim puts the format's median
p99.9 about there, so the limiter works only on transients. After the trim,
format medians fall within about 3 dB: −13 to −16. A re-measure of 20 songs
with the trim live matched the table to ±0.7 dB.

## Findings that the trim does not address

- **Channel count barely predicts level for XM/S3M.** 4-channel and
  32-channel songs spread over the same range, so a per-channel-count formula
  like OpenMPT's or FT2's would not help. The trim is flat per format.
- **The S3M header master volume (preamp) does not explain the spread.**
  Applying it to the samples, as OpenMPT does, widens the loudness range
  instead of narrowing it.
- **The spread within each format is 15–20 dB.** For example, A2M runs
  from Bad Apple at −25 to boss8 at −8. That is the composers' own mixes.
  Only per-song normalisation (ReplayGain-style) would even it out.
- **A2M "clipping":** the OPL emulation clamps its stereo sum to 16 bits
  (`opl/chip.rs` `clock_sample`), as the YMF262 does. So A2M never passes
  full scale, but the loud songs meet the clamp. At the chip ceiling, over
  50 s, boss8, oblivion blast and evil sounding loop had 0.14–0.17% of
  samples; Bad Apple, Corridors of Time and most others had 0%. That is
  in-chip hard clipping, which no downstream gain can undo. Avoiding it
  would need an unclamped float mix out of the renderer. That is a
  departure from hardware, so it is left open.
- **`s3m-adlib/Xenon (DE)/hope, let me stay alive.s3m` was silent** for the
  whole 50 s (peak −64 dBFS). This is worth a look on its own.
