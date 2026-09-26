import { sidDocForSubsong, type SidDoc } from 'src/audio/tracker/sid-doc';
import { exportSid } from 'src/audio/tracker/sid-export';
import { parsePsid } from './psid-file';
import { envelopeLevels } from './envelope';
import { captureSid, SID_EVENT_GATE_LOW, type SidTrace } from './sid-capture';
import { gateOnAt, pitchOf, traceFrames, type TraceFrames } from './transcribe/frames';

/**
 * How close a transcription sounds to its original (plan-psid-import.md D6):
 * the transcribed subsong is exported with the app's own `.sid` exporter
 * (GoatTracker's player) and run on the same emulated C64 as the original,
 * the two register traces are aligned on their note starts, and per voice
 * per frame compared:
 *
 *  - `gate`: the voice sounds in both or in neither (gate on, test bit off);
 *  - `onsets`: audible note starts in both within a frame (F1 score);
 *  - `pitch`: where both sound, the pitch within half a semitone;
 *  - `wave`: where both sound, the same waveform bits;
 *  - `envelope`: at the note starts both share, the same attack/decay/sustain/release;
 *  - `level`: how loud the voice is, frame by frame, as the SID's envelope
 *    makes it of the writes (`envelope.ts`, the ADSR delay bug included):
 *    1 - the mean level difference / 255, where either sounds;
 *  - `pulse`: where both sound a pulse, 1 - the mean width difference / 2048.
 *
 * `score` weighs them (pitch 0.3, gate 0.15, waveform 0.15, level 0.15,
 * onsets 0.1, envelope 0.1, pulse 0.05), and when the original uses the
 * filter, the filter (mode, routing, cutoff within 8 of 255) for 0.15 of
 * the whole.
 */

export interface VoiceFidelity {
  readonly gate: number;
  readonly onsets: number;
  readonly pitch: number;
  readonly wave: number;
  readonly envelope: number;
  readonly level: number;
  readonly pulse: number;
  readonly score: number;
}

export interface Fidelity {
  readonly voices: readonly VoiceFidelity[];
  /** Where the original routes a voice through the filter: the same mode and routing, and the cutoff within 8 of 255. */
  readonly filter: number;
  readonly score: number;
  /** Frames compared, and the transcription's delay against the original. */
  readonly frames: number;
  readonly offset: number;
}

const WEIGHTS = { pitch: 0.3, gate: 0.15, wave: 0.15, level: 0.15, onsets: 0.1, envelope: 0.1, pulse: 0.05 };

/** The voice's oscillator sounds under its gate: gate set, test bit clear (the test bit holds it silent). */
const soundOn = (ctrl: number): boolean => (ctrl & 0x09) === 0x01;

/**
 * A note starts audibly at frame `i`: a gate-on with the oscillator running,
 * or the test bit let go under a held gate (GoatTracker's first frame, `$09`,
 * then the note's waveform).
 */
function audibleOnsetAt(f: TraceFrames, v: number, i: number): boolean {
  const c = f.voices[v]!.ctrl;
  if (!soundOn(c[i]!)) return false;
  return gateOnAt(f, v, i) || (i > 0 && (c[i - 1]! & 0x09) === 0x09);
}

/** The delay (frames) of `b` against `a` that lines up most note starts. */
function bestOffset(a: TraceFrames, b: TraceFrames, maxOffset = 80, span = 1500): number {
  let best = 0;
  let bestHits = -1;
  const n = Math.min(span, a.frames);
  for (let off = -8; off <= maxOffset; off++) {
    let hits = 0;
    for (let v = 0; v < 3; v++) {
      for (let i = 0; i < n; i++) {
        const j = i + off;
        if (j < 0 || j >= b.frames) continue;
        if (audibleOnsetAt(a, v, i) && audibleOnsetAt(b, v, j)) hits++;
      }
    }
    if (hits > bestHits) [best, bestHits] = [off, hits];
  }
  return best;
}

/** Voice `v`'s envelope level at the end of each frame of `f`. */
function voiceLevels(f: TraceFrames, v: number): Uint8Array {
  const vf = f.voices[v]!;
  const frames = Array.from({ length: f.frames }, (_, i) => ({
    ad: vf.ad[i]!,
    sr: vf.sr[i]!,
    ctrl: vf.ctrl[i]!,
    gateLow: (vf.events[i]! & SID_EVENT_GATE_LOW) !== 0,
  }));
  return envelopeLevels(frames, Math.round(f.clockHz / f.rateHz));
}

/** Compare frames `a` (the original) with `b` (the transcription), `b` delayed by `offset`. */
export function compareFrames(a: TraceFrames, b: TraceFrames, offset: number, maxFrames = 6000): Fidelity {
  const n = Math.max(0, Math.min(maxFrames, a.frames, b.frames - offset));
  const voices: VoiceFidelity[] = [];
  for (let v = 0; v < 3; v++) {
    const va = a.voices[v]!;
    const vb = b.voices[v]!;
    const la = voiceLevels(a, v);
    const lb = voiceLevels(b, v);
    let loud = 0;
    let levelErr = 0;
    let gate = 0;
    let sounding = 0;
    let pitch = 0;
    let wave = 0;
    let pulseN = 0;
    let pulseErr = 0;
    let onA = 0;
    let onB = 0;
    let onBoth = 0;
    let env = 0;
    for (let i = 0; i < n; i++) {
      const j = i + offset;
      if (j < 0) continue;
      const ca = va.ctrl[i]!;
      const cb = vb.ctrl[j]!;
      if (la[i]! > 0 || lb[j]! > 0) {
        loud++;
        levelErr += Math.abs(la[i]! - lb[j]!);
      }
      if (soundOn(ca) === soundOn(cb)) gate++;
      if (audibleOnsetAt(a, v, i)) {
        onA++;
        const near = [j - 1, j, j + 1].find((k) => k >= 0 && k < b.frames && audibleOnsetAt(b, v, k));
        if (near !== undefined) {
          onBoth++;
          if (va.ad[i] === vb.ad[near] && va.sr[i] === vb.sr[near]) env++;
        }
      }
      if (audibleOnsetAt(b, v, j)) onB++;
      if (soundOn(ca) && soundOn(cb)) {
        sounding++;
        const pa = pitchOf(va.freq[i]!, a.clockHz);
        const pb = pitchOf(vb.freq[j]!, b.clockHz);
        if ((pa === -Infinity && pb === -Infinity) || Math.abs(pa - pb) <= 0.5) pitch++;
        if ((ca & 0xf0) === (cb & 0xf0)) wave++;
        if (ca & 0x40 && cb & 0x40) {
          pulseN++;
          pulseErr += Math.abs(va.pw[i]! - vb.pw[j]!);
        }
      }
    }
    const f1 = onA + onB === 0 ? 1 : (2 * onBoth) / (onA + onB);
    const r: Omit<VoiceFidelity, 'score'> = {
      gate: n === 0 ? 1 : gate / n,
      onsets: f1,
      pitch: sounding === 0 ? 1 : pitch / sounding,
      wave: sounding === 0 ? 1 : wave / sounding,
      envelope: onBoth === 0 ? (onA === 0 ? 1 : 0) : env / onBoth,
      level: loud === 0 ? 1 : 1 - levelErr / loud / 255,
      pulse: pulseN === 0 ? 1 : Math.max(0, 1 - pulseErr / pulseN / 2048),
    };
    const score =
      r.pitch * WEIGHTS.pitch +
      r.gate * WEIGHTS.gate +
      r.wave * WEIGHTS.wave +
      r.level * WEIGHTS.level +
      r.onsets * WEIGHTS.onsets +
      r.envelope * WEIGHTS.envelope +
      r.pulse * WEIGHTS.pulse;
    voices.push({ ...r, score });
  }
  // The filter, where the original routes a voice through it.
  let filtered = 0;
  let filterHits = 0;
  for (let i = 0; i < n; i++) {
    const j = i + offset;
    if (j < 0 || !(a.resonance[i]! & 7)) continue;
    filtered++;
    const sameRouting = (a.resonance[i]! & 7) === (b.resonance[j]! & 7);
    const sameMode = (a.modeVolume[i]! & 0x70) === (b.modeVolume[j]! & 0x70);
    if (sameRouting && sameMode && Math.abs((a.cutoff[i]! >> 3) - (b.cutoff[j]! >> 3)) <= 8) filterHits++;
  }
  const filter = filtered === 0 ? 1 : filterHits / filtered;
  // Voices that never sound in the original count less; the filter counts when it is used.
  const weight = (v: number): number => (a.voices[v]!.ctrl.some(soundOn) ? 1 : 0.2);
  const total = [0, 1, 2].reduce((s, v) => s + weight(v), 0);
  const voiceScore = voices.reduce((s, x, v) => s + x.score * weight(v), 0) / total;
  const filterWeight = filtered === 0 ? 0 : 0.15;
  const score = voiceScore * (1 - filterWeight) + filter * filterWeight;
  return { voices, filter, score, frames: n, offset };
}

/**
 * `f` played on past its end through its exact loop, to `n` frames (`f`
 * itself when it has no loop or is long enough): a capture stops where its
 * state repeats, and the music goes on from `loopFrame` just the same.
 */
export function unrolled(f: TraceFrames, n: number): TraceFrames {
  const loop = f.loopFrame;
  if (loop === null || loop >= f.frames || f.frames >= n) return f;
  const period = f.frames - loop;
  const at = (i: number): number => (i < f.frames ? i : loop + ((i - f.frames) % period));
  const u16 = (src: Uint16Array): Uint16Array => Uint16Array.from({ length: n }, (_, i) => src[at(i)]!);
  const u8 = (src: Uint8Array): Uint8Array => Uint8Array.from({ length: n }, (_, i) => src[at(i)]!);
  return {
    ...f,
    frames: n,
    voices: f.voices.map((v) => ({ freq: u16(v.freq), pw: u16(v.pw), ctrl: u8(v.ctrl), ad: u8(v.ad), sr: u8(v.sr), events: u8(v.events) })),
    cutoff: u16(f.cutoff),
    resonance: u8(f.resonance),
    modeVolume: u8(f.modeVolume),
  };
}

/** The fidelity of `doc`'s subsong `gtSubsong` against the original `trace`, or the reason it could not be measured. */
export function measureFidelity(trace: SidTrace, doc: SidDoc, gtSubsong: number, maxFrames = 6000): Fidelity | string {
  const exported = exportSid(sidDocForSubsong(doc, gtSubsong));
  if (!exported.ok) return exported.reason;
  const parsed = parsePsid(exported.bytes);
  if (!parsed.ok) return parsed.reason;
  const a = unrolled(traceFrames(trace), maxFrames);
  const seconds = Math.min(600, (maxFrames + 200) / Math.max(1, a.rateHz) + 5);
  const capture = captureSid(parsed.file, { subsong: 0, maxSeconds: seconds });
  if (!capture.ok) return capture.reason;
  const b = unrolled(traceFrames(capture.trace), maxFrames + 200);
  return compareFrames(a, b, bestOffset(a, b), maxFrames);
}
