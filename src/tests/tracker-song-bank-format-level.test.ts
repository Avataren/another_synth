import { describe, expect, it, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { formatOutputGain } from 'src/audio/tracker/format-output-gain';
import type AudioSystem from 'src/audio/AudioSystem';

const db = (gain: number) => 20 * Math.log10(gain);

describe('formatOutputGain', () => {
  it('trims each format by its measured level', () => {
    expect(db(formatOutputGain('native', 8))).toBeCloseTo(0);
    expect(db(formatOutputGain('protracker', 4))).toBeCloseTo(-4);
    expect(db(formatOutputGain('xm', 16))).toBeCloseTo(-6);
    expect(db(formatOutputGain('s3m', 9))).toBeCloseTo(-6);
    expect(db(formatOutputGain('ahx', 4))).toBeCloseTo(0);
    expect(db(formatOutputGain('a2m', 18))).toBeCloseTo(0);
    expect(db(formatOutputGain('sid', 3))).toBeCloseTo(3);
  });

  it('treats a multichannel MOD as the PC-tracker module it is', () => {
    expect(formatOutputGain('protracker', 8)).toBe(formatOutputGain('xm', 8));
    expect(formatOutputGain('protracker', 3)).toBe(formatOutputGain('protracker', 4));
  });

  it('reads a song with no format as native', () => {
    expect(formatOutputGain(undefined, 4)).toBe(1);
  });
});

describe('TrackerSongBank format level', () => {
  function build() {
    const nodes: Array<{ gain: { value: number }; connect: ReturnType<typeof vi.fn> }> = [];
    const createGain = () => {
      const node = {
        gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() },
        connect: vi.fn(),
        disconnect: vi.fn(),
        numberOfOutputs: 1,
      };
      nodes.push(node);
      return node;
    };
    const destinationNode = { connect: vi.fn() };
    const audioContext = {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain,
      destination: {},
      onstatechange: null as unknown,
    };
    const bank = new TrackerSongBank({ audioContext, destinationNode } as unknown as AudioSystem);
    return { bank, nodes, destinationNode };
  }

  it('sits between the master bus and OPL chip and the post-fx rack', () => {
    const { bank, nodes, destinationNode } = build();
    const [master, trim, opl] = nodes;
    expect(bank.output).toBe(master);
    expect(master?.connect).toHaveBeenCalledWith(trim);
    expect(opl?.connect).toHaveBeenCalledWith(trim);
    expect(trim?.connect).toHaveBeenCalledWith(destinationNode);
    expect(master?.connect).not.toHaveBeenCalledWith(destinationNode);
  });

  it('follows the loaded song and leaves the master volume alone', () => {
    const { bank, nodes } = build();
    const [master, trim] = nodes;
    bank.setFormatLevel('xm', 24);
    expect(trim?.gain.value).toBeCloseTo(formatOutputGain('xm', 24));
    bank.setFormatLevel('sid', 3);
    expect(trim?.gain.value).toBeCloseTo(formatOutputGain('sid', 3));
    expect(master?.gain.value).toBe(1);
  });
});
