import type { OplCommand } from 'src/audio/worklets/opl-core';
import { createOplNode } from 'src/audio/tracker/opl-output';
import type { A2mInstrumentJson } from 'src/audio/tracker/a2m-codec';

/**
 * Playing one Adlib Tracker II instrument by hand: the instrument editor's
 * keyboard. The OPL worklet takes register writes, so this does what AT2 does
 * at a note-on for channel 0: it loads the instrument's eleven FM bytes into
 * the operators, sets the pitch and keys the channel on; a key-off clears the
 * key bit and the instrument's release plays out. The song's macros (FM,
 * arpeggio, vibrato) are not part of this: they belong to the song, and play
 * when it does.
 *
 * Registers are the chip's own (`rust-wasm/src/opl`): operator offsets 0 and 3
 * for channel 0, bank 1 at +0x100, OPL3 mode switched on so the waveforms 4-7
 * and the panning bits work.
 */

/** The chip's native rate and the F-number's 20-bit scale: `f = fnum × 49716 / 2^(20 - block)`. */
const NATIVE_RATE = 49716;
const OPL3_ENABLE = 0x105;
const WAVEFORM_SELECT = 0x01;
const CHANNEL = 0;
const MODULATOR = 0x00;
const CARRIER = 0x03;
/** A write per 10 microseconds, so a batch lands in the order it was written. */
const STEP = 1e-5;

/** The block (octave) and F-number that sound `midi` (equal temperament, A4 = 440 Hz), plus AT2's fine-tune. */
export function a2mPitch(midi: number, finetune = 0): { block: number; fnum: number } {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  for (let block = 0; block < 8; block++) {
    const fnum = Math.round((hz * 2 ** (20 - block)) / NATIVE_RATE);
    if (fnum <= 1023 || block === 7) {
      return { block, fnum: Math.max(1, Math.min(1023, fnum + finetune)) };
    }
  }
  return { block: 7, fnum: 1023 };
}

/** OPL3's channel bits in register 0xC0: 0x10 left, 0x20 right; the instrument's panning is 0 centre, 1 left, 2 right. */
function panBits(panning: number): number {
  if (panning === 1) return 0x10;
  if (panning === 2) return 0x20;
  return 0x30;
}

/** The `(reg, value)` pairs that load `instrument` into channel 0 and key it on at `midi`. */
export function a2mNoteOnRegisters(instrument: A2mInstrumentJson, midi: number): Array<[number, number]> {
  const fm = instrument.fm;
  const at = (i: number) => fm[i] ?? 0;
  const { block, fnum } = a2mPitch(midi, instrument.finetune);
  return [
    [0xb0 + CHANNEL, 0],
    [OPL3_ENABLE, 1],
    [WAVEFORM_SELECT, 0x20],
    [0x20 + MODULATOR, at(0)],
    [0x20 + CARRIER, at(1)],
    [0x40 + MODULATOR, at(2)],
    [0x40 + CARRIER, at(3)],
    [0x60 + MODULATOR, at(4)],
    [0x60 + CARRIER, at(5)],
    [0x80 + MODULATOR, at(6)],
    [0x80 + CARRIER, at(7)],
    [0xe0 + MODULATOR, at(8)],
    [0xe0 + CARRIER, at(9)],
    [0xc0 + CHANNEL, (at(10) & 0x0f) | panBits(instrument.panning)],
    [0xa0 + CHANNEL, fnum & 0xff],
    [0xb0 + CHANNEL, 0x20 | (block << 2) | (fnum >> 8)],
  ];
}

/** Key-off: the key bit clears, the pitch bits stay, and the release plays. */
export function a2mNoteOffRegisters(instrument: A2mInstrumentJson, midi: number): Array<[number, number]> {
  const { block, fnum } = a2mPitch(midi, instrument.finetune);
  return [[0xb0 + CHANNEL, (block << 2) | (fnum >> 8)]];
}

export type A2mAuditionNodeFactory = (audioContext: BaseAudioContext) => Promise<AudioWorkletNode>;

/** One OPL worklet that plays notes of the instrument being edited. */
export class A2mAudition {
  private node: AudioWorkletNode | null = null;
  private nodePromise: Promise<AudioWorkletNode | null> | null = null;
  private disposed = false;
  private sounding: { instrument: A2mInstrumentJson; midi: number } | null = null;

  constructor(
    private readonly audioContext: BaseAudioContext,
    private readonly destination: AudioNode,
    private readonly createNode: A2mAuditionNodeFactory = createOplNode,
  ) {}

  private ready(): Promise<AudioWorkletNode | null> {
    this.nodePromise ??= this.createNode(this.audioContext).then(
      (node) => {
        if (this.disposed) {
          node.port.postMessage({ type: 'dispose' } satisfies OplCommand);
          return null;
        }
        node.connect(this.destination, 0);
        this.node = node;
        return node;
      },
      (error: unknown) => {
        console.error('[A2mAudition] OPL worklet failed to start:', error);
        this.nodePromise = null;
        return null;
      },
    );
    return this.nodePromise;
  }

  private send(registers: Array<[number, number]>): void {
    const node = this.node;
    if (!node) return;
    const start = this.audioContext.currentTime;
    const writes = new Float64Array(registers.length * 3);
    registers.forEach(([reg, value], i) => writes.set([start + i * STEP, reg, value], i * 3));
    node.port.postMessage({ type: 'writes', writes } satisfies OplCommand, [writes.buffer]);
  }

  /** Strike `midi` with `instrument`; a note already sounding is struck again. */
  async noteOn(instrument: A2mInstrumentJson, midi: number): Promise<void> {
    if (this.disposed) return;
    await this.ready();
    if (this.disposed || !this.node) return;
    this.sounding = { instrument, midi };
    this.send(a2mNoteOnRegisters(instrument, midi));
  }

  /** Let go of the note sounding (its release plays). */
  noteOff(): void {
    const held = this.sounding;
    if (!held) return;
    this.sounding = null;
    this.send(a2mNoteOffRegisters(held.instrument, held.midi));
  }

  /** The note sounding now, if any (the page strikes it again after an edit). */
  get current(): { midi: number } | null {
    return this.sounding ? { midi: this.sounding.midi } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.sounding = null;
    if (this.node) {
      this.node.port.postMessage({ type: 'dispose' } satisfies OplCommand);
      this.node.disconnect();
      this.node = null;
    }
  }
}
