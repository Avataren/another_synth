import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import type { MidiInputStatus } from 'src/audio/midi-input';

/**
 * B3: AhxAuditionBar.vue in isolation — the props/emits contract (plan §3
 * B3) and the midiChip computed's 4 branches + device pluralization, which
 * risk 6 flags as unpinned anywhere before this extraction.
 */

const status = (partial: Partial<MidiInputStatus>): MidiInputStatus => ({
  state: 'idle',
  devices: [],
  ...partial,
});

function mountBar(midiStatus: MidiInputStatus) {
  return mount(AhxAuditionBar, {
    props: {
      audible: true,
      heldKeys: new Set<number>(),
      latch: false,
      restrike: false,
      octave: 4,
      stripStart: 48,
      midiStatus,
    },
  });
}

describe('AhxAuditionBar', () => {
  it('renders the three keys, latch and re-strike, and the audience gates the audition keys', () => {
    const w = mountBar(status({}));
    for (const id of ['ahx-audition-48', 'ahx-audition-60', 'ahx-audition-72', 'ahx-audition-latch', 'ahx-audition-restrike']) {
      expect(w.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
    expect(w.get('[data-testid="ahx-audition"]').classes()).toContain('ahx-audition-bar');
  });

  it('emits pointer-down/pointer-up with the key’s midi number', async () => {
    const w = mountBar(status({}));
    await w.get('[data-testid="ahx-audition-60"]').trigger('pointerdown');
    expect(w.emitted('pointer-down')).toEqual([[60]]);
    await w.get('[data-testid="ahx-audition-60"]').trigger('pointerup');
    expect(w.emitted('pointer-up')).toEqual([[60]]);
  });

  it('emits set-octave with the next value on the up/down buttons', async () => {
    const w = mountBar(status({}));
    await w.get('[data-testid="ahx-octave-up"]').trigger('click');
    expect(w.emitted('set-octave')).toEqual([[5]]);
    await w.get('[data-testid="ahx-octave-down"]').trigger('click');
    expect(w.emitted('set-octave')![1]).toEqual([3]);
  });

  it('emits toggle-midi on the chip, and update:latch/update:restrike on the checkboxes', async () => {
    const w = mountBar(status({}));
    await w.get('[data-testid="ahx-midi-chip"]').trigger('click');
    expect(w.emitted('toggle-midi')).toHaveLength(1);
    await w.get('[data-testid="ahx-audition-latch"]').setValue(true);
    expect(w.emitted('update:latch')).toEqual([[true]]);
    await w.get('[data-testid="ahx-audition-restrike"]').setValue(true);
    expect(w.emitted('update:restrike')).toEqual([[true]]);
  });

  it('shows the off hint and disables the keys when not audible', () => {
    const w = mount(AhxAuditionBar, {
      props: {
        audible: false,
        heldKeys: new Set<number>(),
        latch: false,
        restrike: false,
        octave: 4,
        stripStart: 48,
        midiStatus: status({}),
      },
    });
    expect(w.find('[data-testid="ahx-audition-off"]').exists()).toBe(true);
    expect((w.get('[data-testid="ahx-audition-60"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('midiChip: unsupported', () => {
    const w = mountBar(status({ state: 'unsupported' }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: not supported');
  });

  it('midiChip: requesting', () => {
    const w = mountBar(status({ state: 'requesting' }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: asking…');
  });

  it('midiChip: denied', () => {
    const w = mountBar(status({ state: 'denied' }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: denied');
  });

  it('midiChip: ready, no device', () => {
    const w = mountBar(status({ state: 'ready', devices: [] }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: no device');
  });

  it('midiChip: ready, one device names it', () => {
    const w = mountBar(status({ state: 'ready', devices: ['Keystep'] }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: Keystep');
  });

  it('midiChip: ready, several devices names the first and counts the rest', () => {
    const w = mountBar(status({ state: 'ready', devices: ['Keystep', 'Launchkey', 'nanoKEY'] }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: Keystep +2');
    expect(w.get('[data-testid="ahx-midi-chip"]').attributes('title')).toBe('Keystep, Launchkey, nanoKEY. Click to turn MIDI off.');
  });

  it('midiChip: the default (idle) branch reads off', () => {
    const w = mountBar(status({ state: 'idle' }));
    expect(w.get('[data-testid="ahx-midi-chip"]').text()).toBe('MIDI: off');
  });
});
