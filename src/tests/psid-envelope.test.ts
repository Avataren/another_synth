import { describe, expect, it } from 'vitest';
import { envelopeLevels, SID_RATE_PERIODS, SidEnvelope } from 'src/audio/tracker/psid/envelope';

/**
 * plan-psid-import.md D6: the SID's envelope, as the fidelity measure runs
 * it over a register trace (the model of the app's chip,
 * `rust-wasm/src/sid/envelope.rs`, stepped rather than clocked).
 */

const FRAME = 19656;

describe('SidEnvelope', () => {
  it('attacks one step per rate period, to 255', () => {
    const env = new SidEnvelope();
    env.setAdsr(0x00, 0xf0);
    env.setGate(true);
    env.run(SID_RATE_PERIODS[0]! * 100);
    expect(env.level).toBe(100);
    env.run(SID_RATE_PERIODS[0]! * 155);
    expect(env.level).toBe(255);
  });

  it('decays to the sustain level and holds there; released, it falls to zero and stays', () => {
    const env = new SidEnvelope();
    env.setAdsr(0x00, 0x80);
    env.setGate(true);
    env.run(10 * FRAME);
    expect(env.level).toBe(0x88);
    env.setGate(false);
    env.run(50 * FRAME);
    expect(env.level).toBe(0);
  });

  it('a sustain raised above the level never matches: the decay runs on to zero', () => {
    const env = new SidEnvelope();
    env.setAdsr(0x00, 0x40);
    env.setGate(true);
    env.run(10 * FRAME);
    expect(env.level).toBe(0x44);
    env.setAdsr(0x00, 0xc0);
    env.run(50 * FRAME);
    expect(env.level).toBe(0);
  });

  it('the ADSR delay bug: a gate-on after the rate counter ran past the attack period waits for it to wrap', () => {
    // A frame of release at rate $B (period 3126) leaves the counter far above attack 0's period 9.
    const env = new SidEnvelope();
    env.setAdsr(0x0d, 0xfb);
    env.run(FRAME + 100);
    env.setGate(true);
    env.run(FRAME);
    expect(env.level).toBe(0);
    env.run(FRAME);
    expect(env.level).toBe(255);
    // After a hard restart (release rate 0: period 9) the same gate-on attacks at once.
    const hr = new SidEnvelope();
    hr.setAdsr(0x0f, 0x00);
    hr.run(3 * FRAME);
    hr.setAdsr(0x0d, 0xfb);
    hr.setGate(true);
    hr.run(FRAME);
    expect(hr.level).toBe(255);
  });

  it('envelopeLevels: per frame, the writes then the frame; a gate that goes low inside a frame and ends high retriggers', () => {
    // Attack and decay 0 (period 9, so no delay bug), sustain 0: up and down within a frame.
    const on = { ad: 0x00, sr: 0x00, ctrl: 0x41, gateLow: false };
    const levels = envelopeLevels([on, on, on, { ...on, gateLow: true }, on], FRAME);
    expect(Array.from(levels.slice(0, 3))).toEqual([0, 0, 0]);
    // The retrigger attacks again, and the decay takes it back down within the frame.
    const env = new SidEnvelope();
    for (const f of [on, on, on]) {
      env.setAdsr(f.ad, f.sr);
      env.setGate(true);
      env.run(FRAME);
    }
    env.setGate(false);
    env.setGate(true);
    env.run(SID_RATE_PERIODS[0]! * 255);
    expect(env.level).toBe(255);
  });
});
