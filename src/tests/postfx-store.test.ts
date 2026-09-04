/**
 * Post-fx store pins: the OFF/ON/AUTO mode machine, engine-event handling,
 * song-load reset, scheduled-transition timing, and persistence into
 * user-settings (D116).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import {
  resetPostFxRegistryForTests,
  registerPostFxRack,
} from '@another-synth/tracker-playback';
import { usePostFxStore } from 'src/stores/post-fx-store';
import type { PostFxRegistration } from '@another-synth/tracker-playback';
import { useUserSettingsStore } from 'src/stores/user-settings-store';

function makeMockStage() {
  return {
    setParams: vi.fn(),
    setLedActive: vi.fn(),
    setBypassed: vi.fn(),
    cancelPending: vi.fn(),
  };
}

function makeMockRack() {
  return { contextTime: vi.fn(() => 10), input: {}, output: {} };
}

beforeEach(() => {
  localStorage.clear();
  resetPostFxRegistryForTests();
  setActivePinia(createPinia());
});

function registerMocks() {
  const stage = makeMockStage();
  const rack = makeMockRack();
  registerPostFxRack(castRegistration(stage, rack));
  return { stage, rack };
}

function castRegistration(
  stage: ReturnType<typeof makeMockStage>,
  rack: ReturnType<typeof makeMockRack>,
) {
  return {
    rack: rack as unknown as PostFxRegistration['rack'],
    amigaLpf: stage as unknown as PostFxRegistration['amigaLpf'],
  };
}

describe('mode defaults and LED truth table', () => {
  it('defaults to AUTO with the engine LED off', () => {
    registerMocks();
    const store = usePostFxStore();
    expect(store.mode).toBe('auto');
    expect(store.engineActive).toBe(false);
    expect(store.resolveLedAt(100)).toBe(false);
  });

  it('the LED means the LED stage: ON mode shows lit, OFF dark', () => {
    registerMocks();
    const store = usePostFxStore();
    store.setMode('on');
    expect(store.resolveLedAt(0)).toBe(true);
    store.setMode('off');
    expect(store.resolveLedAt(0)).toBe(false);
  });
});

describe('engine events in AUTO', () => {
  it('E0x events toggle the state and the LED flips at the scheduled time', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    // An event whose time is already behind the rack clock (10) is applied
    // immediately.
    store.applyEngineEvent(true, 5.0);
    expect(store.engineActive).toBe(true);
    expect(stage.setLedActive).toHaveBeenCalledWith(true, 5.0);
    expect(store.resolveLedAt(10)).toBe(true);

    // A future toggle keeps the applied state until its time arrives.
    store.applyEngineEvent(false, 12.0);
    expect(store.resolveLedAt(11.99)).toBe(true);
    expect(store.resolveLedAt(12.0)).toBe(false);
    expect(store.resolveLedAt(15)).toBe(false);
  });

  it('two queued future toggles keep the LED truthful at every moment', () => {
    registerMocks();
    const store = usePostFxStore();

    // Both events are ahead of the rack clock (10). Before any of them fires
    // the LED shows the pre-event state; between t1 and t2 the t1 state; at
    // t2 the t2 state. The old single-slot bookkeeping lit the LED early.
    store.applyEngineEvent(true, 12.0);
    store.applyEngineEvent(false, 14.0);
    expect(store.resolveLedAt(11.99)).toBe(false);
    expect(store.resolveLedAt(12.0)).toBe(true);
    expect(store.resolveLedAt(13.5)).toBe(true);
    expect(store.resolveLedAt(14.0)).toBe(false);
    expect(store.resolveLedAt(20)).toBe(false);
  });

  it('stop between two queued toggles keeps the t1 state applied', () => {
    const { stage, rack } = registerMocks();
    const store = usePostFxStore();

    store.applyEngineEvent(true, 8.0); // already past the rack clock (10)
    store.applyEngineEvent(false, 15.0); // still queued
    rack.contextTime.mockReturnValue(10);
    store.onPlaybackStopped();
    // The applied state is the last transition the clock passed (t1: ON),
    // not the state preceding both events.
    expect(store.resolveLedAt(10)).toBe(true);
    expect(stage.cancelPending).toHaveBeenCalledWith(10);
  });

  it('song load in AUTO resets the LED to OFF, cancelling queued toggles', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    store.applyEngineEvent(true, 5.0);
    expect(store.engineActive).toBe(true);
    store.onSongLoad();
    expect(store.engineActive).toBe(false);
    expect(stage.cancelPending).toHaveBeenCalledWith(10);
    expect(stage.setLedActive).toHaveBeenLastCalledWith(false, 10);
    expect(store.resolveLedAt(10)).toBe(false);
  });

  it('mode switches cancel pending engine toggles mid-lookahead', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    store.applyEngineEvent(true, 5.0); // scheduled ahead of now=10? no --
    // use a future toggle relative to the rack clock:
    store.applyEngineEvent(false, 15.0);
    store.setMode('on');
    expect(stage.cancelPending).toHaveBeenCalledWith(10);
    // Manual ON: full cascade, LED lit regardless of the queued toggle.
    expect(stage.setBypassed).toHaveBeenLastCalledWith(false, 10);
    expect(stage.setLedActive).toHaveBeenLastCalledWith(true, 10);
  });
  it('a mode switch mid-queue cancels both queued toggles', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    store.applyEngineEvent(true, 12.0);
    store.applyEngineEvent(false, 14.0);
    store.setMode('on');
    // Both queued toggles are dropped at the single choke point; the manual
    // mode shows the LED lit regardless of either.
    expect(store.resolveLedAt(12.5)).toBe(true);
    expect(store.resolveLedAt(15)).toBe(true);
    expect(stage.cancelPending).toHaveBeenCalledWith(10);
    expect(stage.setBypassed).toHaveBeenLastCalledWith(false, 10);
    expect(stage.setLedActive).toHaveBeenLastCalledWith(true, 10);
  });
});

describe('manual override', () => {
  it('ON/OFF swallow engine events entirely', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    store.setMode('on');
    const callsBefore = stage.setLedActive.mock.calls.length;
    store.applyEngineEvent(false, 5.0);
    store.applyEngineEvent(true, 6.0);
    expect(stage.setLedActive.mock.calls.length).toBe(callsBefore);
    expect(store.engineActive).toBe(false);

    store.setMode('off');
    expect(stage.setBypassed).toHaveBeenLastCalledWith(true, 10);
    store.applyEngineEvent(true, 7.0);
    expect(store.engineActive).toBe(false);
  });

  it('manual state persists across song loads', () => {
    registerMocks();
    const store = usePostFxStore();
    store.setMode('on');
    store.onSongLoad();
    expect(store.mode).toBe('on');
    // LED stays lit in ON mode, untouched by the load.
    expect(store.resolveLedAt(0)).toBe(true);
  });

  it('stop cancels queued toggles but keeps the applied state', () => {
    const { stage } = registerMocks();
    const store = usePostFxStore();

    store.applyEngineEvent(true, 5.0);
    store.onPlaybackStopped();
    expect(stage.cancelPending).toHaveBeenCalledWith(10);
    // The applied state persists: resolveLedAt still reports the engine state.
    expect(store.resolveLedAt(10)).toBe(true);
  });
});

describe('persistence', () => {
  it('mode and params survive a store re-creation via user-settings', async () => {
    registerMocks();
    const store = usePostFxStore();
    store.setMode('on');
    store.setParams({ staticCutoffHz: 4200, ledCutoffHz: 3000, ledResDb: -1 });
    // The settings deep-watch persists on Vue's next flush.
    await nextTick();
    const settings = useUserSettingsStore().settings;
    expect(settings.postFxFilterMode).toBe('on');
    expect(settings.postFxFilterParams).toEqual({
      staticCutoffHz: 4200,
      ledCutoffHz: 3000,
      ledResDb: -1,
    });

    // A fresh store reads the persisted values back.
    setActivePinia(createPinia());
    const revived = usePostFxStore();
    expect(revived.mode).toBe('on');
    expect(revived.params).toEqual({
      staticCutoffHz: 4200,
      ledCutoffHz: 3000,
      ledResDb: -1,
    });
  });

  it('engine activity is session state, never persisted', () => {
    registerMocks();
    const store = usePostFxStore();
    store.applyEngineEvent(true, 5.0);
    expect(useUserSettingsStore().settings).not.toHaveProperty('engineActive');
    const raw = localStorage.getItem('synth-user-settings') ?? '';
    expect(raw).not.toContain('engineActive');
  });

  it('the reset button restores the Amiga defaults', () => {
    registerMocks();
    const store = usePostFxStore();
    store.setParams({ staticCutoffHz: 1000, ledCutoffHz: 800, ledResDb: -3 });
    store.resetParamsToDefaults();
    expect(store.params).toEqual({
      staticCutoffHz: 4900,
      ledCutoffHz: 3275,
      ledResDb: -0.7,
    });
  });
});

describe('registration timing', () => {
  it('pushes persisted state into the stage when AudioSystem registers late', () => {
    const store = usePostFxStore();
    store.setMode('on');
    const stage = makeMockStage();
    const rack = makeMockRack();
    registerPostFxRack(castRegistration(stage, rack));
    // Registration replays the store's mode into the fresh stage.
    expect(stage.setParams).toHaveBeenCalled();
    expect(stage.setBypassed).toHaveBeenLastCalledWith(false, 10);
    expect(stage.setLedActive).toHaveBeenLastCalledWith(true, 10);
  });

  it('pushes a stored AUTO mode into the stage as LED-off', () => {
    const stage = makeMockStage();
    const rack = makeMockRack();
    registerPostFxRack(castRegistration(stage, rack));
    const store = usePostFxStore();
    expect(store.mode).toBe('auto');
    expect(stage.setBypassed).toHaveBeenLastCalledWith(false, 10);
    expect(stage.setLedActive).toHaveBeenLastCalledWith(false, 10);
  });
});