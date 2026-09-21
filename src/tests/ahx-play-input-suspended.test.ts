import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useAhxPlayInput } from 'src/composables/useAhxPlayInput';
import type { MidiAccessLike, MidiPortLike } from 'src/audio/midi-input';

/**
 * `suspended` (PList canvas Edit mode, plan §4.4): the computer keyboard does
 * not play while it is true, and only a key going DOWN is refused. The
 * on-screen keys, MIDI and Latch are not affected. Kept beside, not inside,
 * `ahx-play-input.test.ts`, whose suite is unchanged.
 */
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
}

type Play = ReturnType<typeof useAhxPlayInput>;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe('useAhxPlayInput: suspended', () => {
  let log: string[];
  let suspended: Ref<boolean>;
  let play: Play;
  let wrapper: VueWrapper;
  let access: FakeAccess;

  beforeEach(() => {
    log = [];
    suspended = ref(false);
    access = new FakeAccess();
    wrapper = mount(
      defineComponent({
        setup() {
          play = useAhxPlayInput({
            slot: ref<number | null>(3),
            audible: ref(true),
            sink: { noteOn: (s, m, v) => log.push(`on:${s}:${m}:${v}`), noteOff: (m) => log.push(`off:${m}`) },
            requestMidi: async () => access,
            suspended,
          });
          return () => h('div');
        },
      }),
      { attachTo: document.body },
    );
  });
  afterEach(() => wrapper.unmount());

  it('not suspended: the keyboard plays as always', () => {
    key('keydown', 'KeyQ');
    expect(log).toEqual(['on:3:60:100']);
    key('keyup', 'KeyQ');
    expect(log).toEqual(['on:3:60:100', 'off:60']);
  });

  it('suspended: a key going down is not taken (not struck, not swallowed), and the octave shortcut goes with it', () => {
    suspended.value = true;
    const event = key('keydown', 'KeyQ');
    expect(log).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    const shifted = key('keydown', 'PageUp', { key: 'PageUp', shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(play.octave.value).toBe(4);
    expect(play.onKeyDown(new KeyboardEvent('keydown', { code: 'KeyZ' }))).toBe(false);
    expect(log).toEqual([]);
  });

  it('suspended: a key-up still releases the note its key-down struck before (a held key does not stick)', () => {
    key('keydown', 'KeyQ');
    suspended.value = true;
    key('keyup', 'KeyQ');
    expect(log).toEqual(['on:3:60:100', 'off:60']);
    // And the released note is really gone: nothing is held.
    expect([...play.heldKeys]).toEqual([]);
  });

  it('resuming: the keyboard plays again', () => {
    suspended.value = true;
    key('keydown', 'KeyQ');
    suspended.value = false;
    key('keydown', 'KeyQ');
    expect(log).toEqual(['on:3:60:100']);
  });

  it('suspended: the on-screen keys, Latch and MIDI still sound', async () => {
    suspended.value = true;
    play.pointerDown(64);
    play.pointerUp(64);
    expect(log).toEqual(['on:3:64:100', 'off:64']);
    log.length = 0;
    play.latch.value = true;
    play.pointerDown(67);
    play.pointerUp(67);
    expect(log).toEqual(['on:3:67:100']);
    // Tapping the latched key again lets it go.
    play.pointerDown(67);
    play.latch.value = false;
    log.length = 0;
    const port = new FakePort('a', 'K');
    access.ports.set('a', port);
    await play.enableMidi();
    await tick();
    port.send(0x90, 50, 90);
    port.send(0x80, 50, 0);
    expect(log).toEqual(['on:3:50:90', 'off:50']);
  });

  it('releaseKeyboard lets go of what the computer keyboard holds and nothing else', () => {
    key('keydown', 'KeyQ');
    play.pointerDown(64);
    expect([...play.heldKeys].sort()).toEqual([60, 64]);
    log.length = 0;
    play.releaseKeyboard();
    expect([...play.heldKeys]).toEqual([64]);
    expect(log).toContain('off:60');
    // The key-up that follows finds nothing more to do.
    log.length = 0;
    key('keyup', 'KeyQ');
    expect(log).toEqual([]);
  });
});
