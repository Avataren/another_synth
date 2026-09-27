/**
 * .ai/plan-opl.md O5: the song bank's OPL output. The driver's register
 * writes reach the worklet in batches (one per task, after the driver has
 * settled its open ticks), mute/solo is the chip's channel mask, and a stop
 * panics the chip and starts the driver over from initadlib.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OplInstrumentData } from '@another-synth/tracker-playback';
import { OplOutput, OPL_DEFAULT_MIX_GAIN } from 'src/audio/tracker/opl-output';
import type { OplCommand } from 'src/audio/worklets/opl-core';

const TIMBRE: OplInstrumentData = {
  kind: 'melody',
  registers: [0x01, 0x01, 0x10, 0x00, 0xf0, 0xf0, 0x77, 0x77, 0, 0, 0],
  volume: 63,
  c2spd: 8363,
};

function makeContext() {
  const gain = {
    value: 1,
    setValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
  return {
    currentTime: 5,
    createGain: () => ({ gain, connect: vi.fn(), disconnect: vi.fn() }),
  } as unknown as BaseAudioContext;
}

async function makeOutput(channels: Array<number | null> = [null, 2, 5]) {
  const posted: OplCommand[] = [];
  const node = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { postMessage: (m: OplCommand) => posted.push(m), onmessage: null },
  } as unknown as AudioWorkletNode;
  const factory = vi.fn(() => Promise.resolve(node));
  const out = new OplOutput(makeContext(), {} as AudioNode, factory);
  out.setSong({ instruments: new Map([['02', TIMBRE]]), channels, amigaLimits: false, gain: 0.8 });
  await out.ready();
  await Promise.resolve();
  return { out, posted, factory };
}

const batches = (posted: OplCommand[]) =>
  posted.filter((m): m is Extract<OplCommand, { type: 'writes' }> => m.type === 'writes');

/** (time, reg, val) triples of every batch, flattened. */
function writesOf(posted: OplCommand[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const b of batches(posted)) {
    const w = Array.from(b.writes);
    for (let i = 0; i < w.length; i += 3) out.push([w[i]!, w[i + 1]!, w[i + 2]!]);
  }
  return out;
}

describe('OplOutput', () => {
  it('builds no worklet for a song without AdLib instruments', async () => {
    const factory = vi.fn();
    const out = new OplOutput(makeContext(), {} as AudioNode, factory);
    out.setSong({ instruments: new Map(), channels: [], amigaLimits: false });
    await out.ready();
    expect(factory).not.toHaveBeenCalled();
    expect(out.handles('02')).toBe(false);
  });

  it('takes the song’s mix level, times the user volume, and sends initadlib once the node is up', async () => {
    const { out, posted, factory } = await makeOutput();
    expect(factory).toHaveBeenCalledTimes(1);
    const setValue = out.output.gain.setValueAtTime as unknown as ReturnType<typeof vi.fn>;
    expect(setValue).toHaveBeenLastCalledWith(0.8, 5);
    out.setUserVolume(0.5);
    expect(setValue).toHaveBeenLastCalledWith(0.4, 5);
    out.setSong({ instruments: new Map([['02', TIMBRE]]), channels: [], amigaLimits: false });
    expect(setValue).toHaveBeenLastCalledWith(OPL_DEFAULT_MIX_GAIN * 0.5, 5);
    expect(out.handles('02')).toBe(true);
    expect(writesOf(posted).some(([, r, v]) => r === 0x01 && v === 0x20)).toBe(true);
  });

  it('batches a task of events into one message, the tick settled first', async () => {
    const { out, posted } = await makeOutput();
    posted.length = 0;
    // A note and a fine slide on its own tick: one retrigger, at the slid pitch.
    out.noteOn('02', 127, 6, 1, 261.63);
    out.setPitch(6, 1, 262.5);
    out.setVolume(6, 1, 0.5);
    await Promise.resolve();
    await Promise.resolve();
    expect(batches(posted)).toHaveLength(1);
    const writes = writesOf(posted);
    // Track 1 is OPL channel 2: its B0 gets key-off then key-on, once.
    const b2 = writes.filter(([, r]) => r === 0xb2);
    expect(b2.map(([, , v]) => v & 0x20)).toEqual([0, 0x20]);
    // The carrier TL for channel 2 (0x43 + adlibiadd[2] = 0x45) is written.
    expect(writes.some(([, r]) => r === 0x45)).toBe(true);
  });

  it('mutes by channel mask, keeping a channel another heard track shares', async () => {
    const { out, posted } = await makeOutput([null, 2, 5, 5]);
    posted.length = 0;
    out.setTrackAudibility((t) => t !== 1, 4);
    expect(posted.at(-1)).toEqual({ type: 'set-channel-mask', mask: ((1 << 18) - 1) & ~(1 << 2) });
    // Track 2 muted, but track 3 on the same channel 5 is heard.
    out.setTrackAudibility((t) => t !== 2, 4);
    expect(posted.at(-1)).toEqual({ type: 'set-channel-mask', mask: (1 << 18) - 1 });
  });

  it('panics and re-inits on restart, dropping unsent writes', async () => {
    const { out, posted } = await makeOutput();
    out.noteOn('02', 127, 6, 1, 261.63);
    posted.length = 0;
    out.restart();
    await Promise.resolve();
    expect(posted[0]).toEqual({ type: 'panic' });
    const writes = writesOf(posted);
    // No key-on survives: only initadlib, whose channel 2 note is key-off.
    expect(writes.filter(([, r, v]) => r === 0xb2 && v & 0x20)).toHaveLength(0);
    expect(writes.some(([, r, v]) => r === 0x01 && v === 0x20)).toBe(true);
  });
});
