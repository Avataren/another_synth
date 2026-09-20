import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { AhxEnvelope } from '@another-synth/tracker-playback';
import AhxEnvelopeEditor from 'src/components/ahx/AhxEnvelopeEditor.vue';

const env: AhxEnvelope = { aFrames: 4, aVolume: 64, dFrames: 6, dVolume: 40, sFrames: 10, rFrames: 8, rVolume: 5 };

function mountEditor(props: Partial<InstanceType<typeof AhxEnvelopeEditor>['$props']> = {}) {
  return mount(AhxEnvelopeEditor, {
    attachTo: document.body,
    props: { envelope: env, volume: 64, hardCutRelease: false, hardCutFrames: 0, ...props },
  });
}

const node = (w: ReturnType<typeof mountEditor>, n: string) => w.get(`[data-testid="ahx-env-node-${n}"]`);

function pointer(type: string, x: number, y: number, extra: { shift?: boolean } = {}): PointerEvent {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, shiftKey: extra.shift ?? false });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e as PointerEvent;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('AhxEnvelopeEditor (E2)', () => {
  it('draws four keyboard-focusable slider nodes with a readable value', () => {
    const w = mountEditor();
    for (const n of ['A', 'D', 'S', 'R']) {
      const el = node(w, n);
      expect(el.element.tagName).toBe('BUTTON');
      expect(el.attributes('role')).toBe('slider');
      expect((el.element as HTMLButtonElement).tabIndex).toBeGreaterThanOrEqual(0);
    }
    expect(node(w, 'A').attributes('aria-valuetext')).toBe('Attack: 4 frames, level 64');
    expect(node(w, 'D').attributes('aria-valuetext')).toBe('Decay: 6 frames, level 40');
    expect(w.get('[data-testid="ahx-envelope"]').attributes('aria-label')).toMatch(/attack 4 to level 64/);
    w.unmount();
  });

  it('draws the volume ceiling, and no ideal (dotted) curve when the engine plays what the numbers say', () => {
    const w = mountEditor({ volume: 32 });
    expect(w.find('[data-testid="ahx-envelope-ceiling"]').exists()).toBe(true);
    expect(w.text()).toContain('volume 32');
    expect(w.find('[data-testid="ahx-envelope-ideal"]').exists()).toBe(false);
    w.unmount();
  });

  it('draws the ideal curve dotted where a zero-frame stage makes the engine play something else', () => {
    const w = mountEditor({ envelope: { ...env, aFrames: 0 } });
    expect(w.find('[data-testid="ahx-envelope-ideal"]').exists()).toBe(true);
    w.unmount();
  });

  it('arrow keys move a focused node: frames and level, Shift for bigger steps, in one change', async () => {
    const w = mountEditor();
    const a = node(w, 'A');
    await a.trigger('keydown', { key: 'ArrowRight' });
    await a.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
    await node(w, 'D').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    await node(w, 'D').trigger('keydown', { key: 'ArrowUp' });
    expect(w.emitted('change')).toEqual([
      [{ aFrames: 5, aVolume: 64 }],
      [{ aFrames: 0, aVolume: 64 }],
      [{ dFrames: 6, dVolume: 36 }],
      [{ dFrames: 6, dVolume: 41 }],
    ]);
    w.unmount();
  });

  it('a key the node uses is consumed; Escape and the sustain\'s up/down are left alone', async () => {
    const w = mountEditor();
    const seen: string[] = [];
    document.body.addEventListener('keydown', (e) => seen.push(e.key));
    await node(w, 'A').trigger('keydown', { key: 'ArrowRight' });
    await node(w, 'A').trigger('keydown', { key: 'Escape' });
    await node(w, 'S').trigger('keydown', { key: 'ArrowUp' });
    expect(seen).toEqual(['Escape', 'ArrowUp']); // ArrowRight was stopped
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    node(w, 'A').element.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    w.unmount();
  });

  it('does not emit when an arrow key cannot move the value (already at the edge)', async () => {
    const w = mountEditor({ envelope: { ...env, aFrames: 0, aVolume: 64 } });
    await node(w, 'A').trigger('keydown', { key: 'ArrowLeft' });
    await node(w, 'A').trigger('keydown', { key: 'ArrowUp' });
    expect(w.emitted('change')).toBeUndefined();
    w.unmount();
  });

  it('double-click asks for the matching typed field', async () => {
    const w = mountEditor();
    await node(w, 'R').trigger('dblclick');
    expect(w.emitted('focus-field')).toEqual([['ahx-env-rFrames']]);
    w.unmount();
  });

  it('a pointer drag emits changes coalesced per frame and ends on the last position; the axis stays put', async () => {
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });
    const w = mountEditor();
    const a = node(w, 'A').element as HTMLElement;
    a.setPointerCapture = vi.fn();
    a.releasePointerCapture = vi.fn();
    const ticksBefore = w.findAll('.ahx-env__tick').map((t) => t.text());
    a.dispatchEvent(pointer('pointerdown', 100, 100));
    a.dispatchEvent(pointer('pointermove', 130, 100));
    a.dispatchEvent(pointer('pointermove', 160, 80));
    expect(w.emitted('change')).toBeUndefined(); // nothing until the frame
    queued.shift()!(0);
    expect(w.emitted('change')).toHaveLength(1);
    const first = (w.emitted('change')![0] as [Partial<AhxEnvelope>])[0];
    expect(first.aFrames).toBeGreaterThan(4); // dragged right: attack got longer
    expect(first.aVolume).toBe(64); // dragged up from the ceiling: clamped
    // Drag far right (beyond the axis): the ticks do not rescale under the cursor.
    a.dispatchEvent(pointer('pointermove', 900, 80));
    a.dispatchEvent(pointer('pointerup', 900, 80));
    const last = (w.emitted('change')!.at(-1) as [Partial<AhxEnvelope>])[0];
    expect(last.aFrames).toBeGreaterThan(first.aFrames!);
    expect(w.findAll('.ahx-env__tick').map((t) => t.text())).toEqual(ticksBefore);
    w.unmount();
  });

  it('shows the hard-cut marker and lead only when hard cut frames are set, and says what it does', async () => {
    const off = mountEditor({ hardCutFrames: 0 });
    expect(off.find('[data-testid="ahx-envelope-hardcut"]').exists()).toBe(false);
    expect(off.find('[data-testid="ahx-env-marker-next"]').exists()).toBe(false);
    off.unmount();
    const w = mountEditor({ hardCutFrames: 3, hardCutRelease: true });
    expect(w.find('[data-testid="ahx-envelope-hardcut"]').exists()).toBe(true);
    expect(w.get('[data-testid="ahx-envelope-hardcut-note"]').text()).toMatch(/last 3 frames before it/);
    // The lead marker: moving it left lengthens the cut, through the instrument's own field.
    await w.get('[data-testid="ahx-env-marker-lead"]').trigger('keydown', { key: 'ArrowLeft' });
    expect(w.emitted('hard-cut-frames')).toEqual([[4]]);
    // The arrival marker is UI-only: it moves without emitting anything.
    await w.get('[data-testid="ahx-env-marker-next"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.emitted('change')).toBeUndefined();
    await w.setProps({ hardCutRelease: false });
    expect(w.get('[data-testid="ahx-envelope-hardcut-note"]').text()).toMatch(/muted 3 frames before the next row that sets an instrument/);
    w.unmount();
  });
});
