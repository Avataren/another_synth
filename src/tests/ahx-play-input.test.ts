import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import {
  decodeMidiMessage,
  MidiInput,
  type MidiAccessLike,
  type MidiPortLike,
} from 'src/audio/midi-input';
import { isTextEntryTarget, TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';

type Play = ReturnType<typeof useAhxPlayInput>;

class FakePort implements MidiPortLike {
  onmidimessage: MidiPortLike['onmidimessage'] = null;
  state = 'connected';
  constructor(
    public id: string,
    public name: string | null,
  ) {}
  send(...bytes: number[]): void {
    this.onmidimessage?.({ data: Uint8Array.from(bytes) });
  }
}

class FakeAccess implements MidiAccessLike {
  ports = new Map<string, FakePort>();
  onstatechange: MidiAccessLike['onstatechange'] = null;
  inputs = { forEach: (cb: (port: MidiPortLike) => void) => this.ports.forEach((p) => cb(p)) };
  plug(port: FakePort): void {
    this.ports.set(port.id, port);
    this.onstatechange?.({ port });
  }
  unplug(id: string): void {
    const port = this.ports.get(id);
    if (!port) return;
    port.state = 'disconnected';
    this.ports.delete(id);
    this.onstatechange?.({ port });
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent(type, { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('note key map and text-entry gate', () => {
  it('is the tracker map: two rows, C-3 and C-4 anchors, ', () => {
    expect(TRACKER_NOTE_KEY_MAP.KeyZ).toBe(48);
    expect(TRACKER_NOTE_KEY_MAP.KeyS).toBe(49);
    expect(TRACKER_NOTE_KEY_MAP.KeyQ).toBe(60);
    expect(TRACKER_NOTE_KEY_MAP.Comma).toBe(60);
    expect(TRACKER_NOTE_KEY_MAP.Digit2).toBe(61);
    expect(TRACKER_NOTE_KEY_MAP.Backslash).toBe(81);
    expect(Object.keys(TRACKER_NOTE_KEY_MAP)).toHaveLength(38);
  });

  it('the tracker page takes its map from the shared module (no second copy)', () => {
    const source = readFileSync(resolve(__dirname, '../pages/TrackerPage.vue'), 'utf8');
    expect(source).toContain("from 'src/composables/keyboard/note-key-map'");
    expect(source).not.toMatch(/KeyZ:\s*48/);
  });

  it('treats text-like fields as typing, and sliders / checkboxes as not', () => {
    const input = (type: string) => Object.assign(document.createElement('input'), { type });
    expect(isTextEntryTarget(input('text'))).toBe(true);
    expect(isTextEntryTarget(input('number'))).toBe(true);
    expect(isTextEntryTarget(document.createElement('textarea'))).toBe(true);
    expect(isTextEntryTarget(document.createElement('select'))).toBe(true);
    expect(isTextEntryTarget(input('range'))).toBe(false);
    expect(isTextEntryTarget(input('checkbox'))).toBe(false);
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false);
    expect(isTextEntryTarget(window)).toBe(false);
  });
});

describe('decodeMidiMessage', () => {
  it('reads note-on with velocity, note-on velocity 0 as off, note-off, all-notes-off', () => {
    expect(decodeMidiMessage([0x90, 60, 99])).toEqual({ kind: 'on', midi: 60, velocity: 99 });
    expect(decodeMidiMessage([0x93, 61, 1])).toEqual({ kind: 'on', midi: 61, velocity: 1 });
    expect(decodeMidiMessage([0x90, 60, 0])).toEqual({ kind: 'off', midi: 60 });
    expect(decodeMidiMessage([0x80, 60, 64])).toEqual({ kind: 'off', midi: 60 });
    expect(decodeMidiMessage([0xb0, 123, 0])).toEqual({ kind: 'allOff' });
    expect(decodeMidiMessage([0xb0, 120, 0])).toEqual({ kind: 'allOff' });
  });
  it('ignores what an instrument does not use', () => {
    expect(decodeMidiMessage([0xb0, 7, 100])).toBeNull(); // volume CC
    expect(decodeMidiMessage([0xe0, 0, 64])).toBeNull(); // pitch bend
    expect(decodeMidiMessage([0xf8])).toBeNull(); // clock
    expect(decodeMidiMessage(null)).toBeNull();
  });
});

describe('MidiInput', () => {
  it('reports unsupported without Web MIDI', async () => {
    const seen: string[] = [];
    const input = new MidiInput({ noteOn() {}, noteOff() {}, onStatus: (s) => seen.push(s.state) }, undefined);
    await input.start();
    expect(input.current).toEqual({ state: 'unsupported', devices: [] });
    expect(seen).toEqual(['unsupported']);
  });

  it('a refused permission is a state, not a throw, and can be retried', async () => {
    const access = new FakeAccess();
    const request = vi
      .fn<() => Promise<MidiAccessLike>>()
      .mockRejectedValueOnce(new DOMException('no', 'SecurityError'))
      .mockResolvedValueOnce(access);
    const input = new MidiInput({ noteOn() {}, noteOff() {} }, request);
    await expect(input.start()).resolves.toBeUndefined();
    expect(input.current.state).toBe('denied');
    await input.start();
    expect(input.current.state).toBe('ready');
  });

  it('lists connected inputs, follows statechange hot-plug and delivers notes', async () => {
    const access = new FakeAccess();
    const a = new FakePort('a', 'Keystation');
    access.ports.set('a', a);
    const events: string[] = [];
    const input = new MidiInput(
      {
        noteOn: (m, v) => events.push(`on:${m}:${v}`),
        noteOff: (m) => events.push(`off:${m}`),
        allNotesOff: () => events.push('all'),
      },
      async () => access,
    );
    await input.start();
    expect(input.current).toEqual({ state: 'ready', devices: ['Keystation'] });
    a.send(0x90, 64, 87);
    a.send(0x80, 64, 0);
    expect(events).toEqual(['on:64:87', 'off:64']);

    // Hot-plug: a second device appears and is heard.
    const b = new FakePort('b', null);
    access.plug(b);
    expect(input.current.devices).toEqual(['Keystation', 'b']);
    b.send(0x90, 50, 10);
    expect(events.at(-1)).toBe('on:50:10');

    // Unplug: it drops out of the list, is detached, and its held notes are let go of.
    access.unplug('a');
    expect(input.current.devices).toEqual(['b']);
    expect(a.onmidimessage).toBeNull();
    expect(events.at(-1)).toBe('all');

    input.stop();
    expect(input.current.state).toBe('idle');
    expect(b.onmidimessage).toBeNull();
    expect(access.onstatechange).toBeNull();
  });

  it('a permission answer that arrives after stop() is dropped', async () => {
    const access = new FakeAccess();
    let resolve!: (a: MidiAccessLike) => void;
    const input = new MidiInput(
      { noteOn() {}, noteOff() {} },
      () => new Promise<MidiAccessLike>((r) => (resolve = r)),
    );
    const started = input.start();
    expect(input.current.state).toBe('requesting');
    input.stop();
    resolve(access);
    await started;
    expect(input.current.state).toBe('idle');
    expect(access.onstatechange).toBeNull();
  });
});

describe('useAhxPlayInput', () => {
  let log: string[];
  let slot: Ref<number | null>;
  let audible: Ref<boolean>;
  let play: Play;
  let wrapper: VueWrapper;
  let access: FakeAccess;

  function mountHarness(autoMidi = false) {
    wrapper = mount(
      defineComponent({
        setup() {
          play = useAhxPlayInput({
            slot,
            audible,
            sink: {
              noteOn: (s, m, v) => log.push(`on:${s}:${m}:${v}`),
              noteOff: (m) => log.push(`off:${m}`),
            },
            requestMidi: async () => access,
            autoMidi,
          });
          return () => h('div');
        },
      }),
      { attachTo: document.body },
    );
  }

  beforeEach(() => {
    log = [];
    slot = ref<number | null>(3);
    audible = ref(true);
    access = new FakeAccess();
    mountHarness();
  });
  afterEach(() => {
    wrapper.unmount();
    document.body.innerHTML = '';
  });

  it('plays the tracker map: Z is C-3, Q is C-4, with a velocity, and releases on key-up', () => {
    const down = key('keydown', 'KeyZ');
    expect(down.defaultPrevented).toBe(true);
    key('keydown', 'KeyQ');
    expect(log).toEqual(['on:3:48:100', 'on:3:60:100']);
    key('keyup', 'KeyZ');
    key('keyup', 'KeyQ');
    // Z was not the sounding key (Q was): its release is only a note-off, then Q's ends the note.
    expect(log).toEqual(['on:3:48:100', 'on:3:60:100', 'off:48', 'off:60']);
    expect(play.heldKeys.size).toBe(0);
  });

  it('ignores auto-repeat, unmapped keys and modified keys', () => {
    key('keydown', 'KeyZ');
    key('keydown', 'KeyZ', { repeat: true });
    expect(log).toHaveLength(1);
    expect(key('keydown', 'KeyA').defaultPrevented).toBe(false);
    expect(key('keydown', 'ArrowLeft').defaultPrevented).toBe(false);
    key('keydown', 'KeyX', { ctrlKey: true });
    key('keydown', 'KeyX', { metaKey: true });
    key('keydown', 'KeyX', { altKey: true });
    expect(log).toHaveLength(1);
  });

  it('two keys for one note (Q and Comma) hold it until both are up', () => {
    key('keydown', 'KeyQ');
    key('keydown', 'Comma');
    expect(log).toEqual(['on:3:60:100']);
    key('keyup', 'KeyQ');
    expect(log).toEqual(['on:3:60:100']);
    key('keyup', 'Comma');
    expect(log).toEqual(['on:3:60:100', 'off:60']);
  });

  it('is polyphonic in what it holds and falls back to the earlier key when the sounding one goes', () => {
    key('keydown', 'KeyZ');
    key('keydown', 'KeyX');
    expect([...play.heldKeys]).toEqual([48, 50]);
    key('keyup', 'KeyX'); // the sounding key: the earlier one still down sounds again
    expect(log).toEqual(['on:3:48:100', 'on:3:50:100', 'off:50', 'on:3:48:100']);
    key('keyup', 'KeyZ');
    expect(log.at(-1)).toBe('off:48');
  });

  describe('octave shift', () => {
    it('Shift+PageUp / PageDown move the octave by 12 semitones and clamp at 0..8', () => {
      expect(play.octave.value).toBe(4);
      expect(key('keydown', 'PageUp', { key: 'PageUp', shiftKey: true }).defaultPrevented).toBe(true);
      expect(play.octave.value).toBe(5);
      key('keydown', 'KeyZ');
      expect(log.at(-1)).toBe('on:3:60:100');
      key('keyup', 'KeyZ');
      key('keydown', 'PageDown', { key: 'PageDown', shiftKey: true });
      key('keydown', 'PageDown', { key: 'PageDown', shiftKey: true });
      expect(play.octave.value).toBe(3);
      key('keydown', 'KeyZ');
      expect(log.at(-1)).toBe('on:3:36:100');
      for (let i = 0; i < 12; i++) key('keydown', 'PageDown', { key: 'PageDown', shiftKey: true });
      expect(play.octave.value).toBe(0);
      for (let i = 0; i < 12; i++) key('keydown', 'PageUp', { key: 'PageUp', shiftKey: true });
      expect(play.octave.value).toBe(8);
    });

    it('plain PageUp is left alone, and a key-up after a shift releases the note it struck', () => {
      expect(key('keydown', 'PageUp', { key: 'PageUp' }).defaultPrevented).toBe(false);
      expect(play.octave.value).toBe(4);
      key('keydown', 'KeyZ');
      play.setOctave(6);
      key('keyup', 'KeyZ');
      expect(log).toEqual(['on:3:48:100', 'off:48']);
    });

    it('never leaves 0..127', () => {
      play.setOctave(8);
      key('keydown', 'Backslash'); // 81 + 48 = 129
      expect(log.at(-1)).toBe('on:3:127:100');
    });
  });

  describe('the focus gate', () => {
    it('does not play while a text field has focus, and leaves the keystroke alone', () => {
      const field = document.createElement('input');
      field.type = 'number';
      document.body.appendChild(field);
      const event = key('keydown', 'KeyZ', {}, field);
      expect(event.defaultPrevented).toBe(false);
      expect(log).toEqual([]);
      const area = document.body.appendChild(document.createElement('textarea'));
      key('keydown', 'KeyX', {}, area);
      expect(log).toEqual([]);
    });

    it('does play with a slider or checkbox focused', () => {
      const slider = document.body.appendChild(Object.assign(document.createElement('input'), { type: 'range' }));
      key('keydown', 'KeyZ', {}, slider);
      expect(log).toEqual(['on:3:48:100']);
    });

    it('lets a key-up through wherever focus went, so a note never hangs', () => {
      key('keydown', 'KeyZ');
      const field = document.body.appendChild(document.createElement('input'));
      key('keyup', 'KeyZ', {}, field);
      expect(log.at(-1)).toBe('off:48');
    });
  });

  describe('latch', () => {
    it('a tap latches, a second tap releases, one voice at a time', () => {
      play.latch.value = true;
      key('keydown', 'KeyZ');
      key('keyup', 'KeyZ');
      expect(log).toEqual(['on:3:48:100']);
      expect([...play.heldKeys]).toEqual([48]);
      key('keydown', 'KeyX');
      key('keyup', 'KeyX');
      expect(log).toEqual(['on:3:48:100', 'off:48', 'on:3:50:100']);
      key('keydown', 'KeyX');
      expect(log.at(-1)).toBe('off:50');
      expect(play.heldKeys.size).toBe(0);
    });

    it('turning latch off lets the note go', async () => {
      play.latch.value = true;
      await tick();
      key('keydown', 'KeyZ');
      play.latch.value = false;
      await tick();
      expect(log.at(-1)).toBe('off:48');
    });

    it('does not drop a latched note when the window loses focus, but drops a held one', async () => {
      play.latch.value = true;
      await tick();
      key('keydown', 'KeyZ');
      window.dispatchEvent(new Event('blur'));
      expect(log).toEqual(['on:3:48:100']);
      play.latch.value = false;
      await tick();
      log.length = 0;
      key('keydown', 'KeyX');
      window.dispatchEvent(new Event('blur'));
      expect(log).toEqual(['on:3:50:100', 'off:50']);
    });
  });

  describe('honest byte-less state', () => {
    it('plays nothing and swallows nothing when there is no source', () => {
      audible.value = false;
      const event = key('keydown', 'KeyZ');
      expect(event.defaultPrevented).toBe(false);
      play.pointerDown(60);
      play.press(60, 90, 'midi');
      expect(log).toEqual([]);
      expect(play.heldKeys.size).toBe(0);
    });

    it('lets go of what sounds when the source goes away', async () => {
      key('keydown', 'KeyZ');
      audible.value = false;
      await tick();
      expect(log.at(-1)).toBe('off:48');
    });
  });

  it('on-screen keys hold on press and release on up/leave', () => {
    play.pointerDown(64);
    play.pointerUp(64);
    expect(log).toEqual(['on:3:64:100', 'off:64']);
  });

  it('a change of instrument lets go of what was held on the old one', async () => {
    key('keydown', 'KeyZ');
    slot.value = 4;
    await tick();
    expect(log.at(-1)).toBe('off:48');
    key('keydown', 'KeyX');
    expect(log.at(-1)).toBe('on:4:50:100');
  });

  it('re-strikes what is held', () => {
    key('keydown', 'KeyZ');
    play.restrikeHeld();
    expect(log).toEqual(['on:3:48:100', 'off:48', 'on:3:48:100']);
  });

  describe('MIDI', () => {
    it('passes velocity through and maps notes as they are (no octave shift)', async () => {
      const port = new FakePort('a', 'Keys');
      access.ports.set('a', port);
      await play.enableMidi();
      expect(play.midiStatus.value).toEqual({ state: 'ready', devices: ['Keys'] });
      play.setOctave(6);
      port.send(0x90, 67, 33);
      port.send(0x90, 67, 0);
      expect(log).toEqual(['on:3:67:33', 'off:67']);
    });

    it('a device pulled out mid-note releases it; hot-plug shows up in the status', async () => {
      const a = new FakePort('a', 'A');
      access.ports.set('a', a);
      await play.enableMidi();
      const b = new FakePort('b', 'B');
      access.plug(b);
      expect(play.midiStatus.value.devices).toEqual(['A', 'B']);
      a.send(0x90, 60, 100);
      key('keydown', 'KeyX'); // a keyboard note is not a MIDI note
      log.length = 0;
      access.unplug('a');
      expect(log).toEqual(['off:60']);
      expect([...play.heldKeys]).toEqual([50]);
    });

    it('CC 123 releases every MIDI note', async () => {
      const a = new FakePort('a', 'A');
      access.ports.set('a', a);
      await play.enableMidi();
      a.send(0x90, 60, 100);
      a.send(0x90, 62, 100);
      a.send(0xb0, 123, 0);
      expect(play.heldKeys.size).toBe(0);
    });

    it('is silent while byte-less, and latch toggles on MIDI note-on', async () => {
      const a = new FakePort('a', 'A');
      access.ports.set('a', a);
      await play.enableMidi();
      audible.value = false;
      a.send(0x90, 60, 100);
      expect(log).toEqual([]);
      audible.value = true;
      play.latch.value = true;
      a.send(0x90, 60, 100);
      a.send(0x80, 60, 0);
      expect(log).toEqual(['on:3:60:100']);
    });

    it('a denied permission leaves a retry-able chip state', async () => {
      wrapper.unmount();
      const request = vi
        .fn<() => Promise<MidiAccessLike>>()
        .mockRejectedValueOnce(new Error('denied'))
        .mockResolvedValueOnce(access);
      wrapper = mount(
        defineComponent({
          setup() {
            play = useAhxPlayInput({
              slot,
              audible,
              sink: { noteOn() {}, noteOff() {} },
              requestMidi: request,
            });
            return () => h('div');
          },
        }),
      );
      await play.toggleMidi();
      expect(play.midiStatus.value.state).toBe('denied');
      expect(play.midiOn.value).toBe(false);
      await play.toggleMidi();
      expect(play.midiStatus.value.state).toBe('ready');
      await play.toggleMidi(); // and a second click turns it off
      expect(play.midiStatus.value.state).toBe('idle');
    });

    it('starts by itself when the user setting says so', async () => {
      wrapper.unmount();
      mountHarness(true);
      await tick();
      expect(play.midiStatus.value.state).toBe('ready');
    });
  });

  it('stops listening to the keyboard when unmounted', () => {
    wrapper.unmount();
    key('keydown', 'KeyZ');
    expect(log).toEqual([]);
    mountHarness(); // afterEach unmounts a live wrapper
  });
});
