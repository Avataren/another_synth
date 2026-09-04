/**
 * Post-fx state: the master OFF/ON/AUTO mode for the post-fx rack, the
 * engine-driven LED-filter activity, and the filter's tweakable parameters.
 *
 * The store is the single point where the playback engine's E0x events meet
 * the audio graph and the UI:
 *
 * - mode `auto` (default): a song load resets the LED filter to OFF, then E0x
 *   events toggle it. `applyEngineEvent` is the only engine-facing entry.
 * - modes `on`/`off`: engine events are swallowed here -- the single choke
 *   point for manual override (review M7 discipline); manual state persists
 *   across song loads.
 *
 * The LED means "the LED filter stage is active right now" -- in AUTO-off the
 * static ~4.9 kHz RC filter is still audibly engaged while the LED shows dark;
 * that is correct (hardware-faithful, D116), because the LED mirrors the LED
 * filter, not "any filtering".
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  AMIGA_LPF_DEFAULT_PARAMS,
  getPostFxRack,
  onPostFxRackRegistered,
  sanitizeAmigaLpfParams,
  type AmigaLpfParams,
  type PostFxRegistration,
} from '@another-synth/tracker-playback';
import { useUserSettingsStore } from 'src/stores/user-settings-store';

export type PostFxFilterMode = 'off' | 'on' | 'auto';

export const POST_FX_MODES: PostFxFilterMode[] = ['off', 'on', 'auto'];

export const usePostFxStore = defineStore('postFx', () => {
  const settingsStore = useUserSettingsStore();

  const mode = ref<PostFxFilterMode>(
    settingsStore.settings.postFxFilterMode ?? 'auto',
  );
  const params = ref<AmigaLpfParams>(
    sanitizeAmigaLpfParams(settingsStore.settings.postFxFilterParams ?? {}),
  );

  /**
   * The LED state in effect right now (in AUTO), plus the ordered queue of
   * engine-commanded transitions still in the future. The engine schedules
   * 0.5-1 s ahead and a song can carry adjacent E0x rows, so several toggles
   * are commonly pending at once; `resolveLedAt` folds entries the audio
   * clock has passed, in order, before answering -- the LED shows the state
   * that is actually in effect at `now`, never a state scheduled ahead of it
   * (fix-cycle F4).
   */
  const engineActive = ref(false);
  const pendingTransitions: Array<{ time: number; active: boolean }> = [];

  function foldPendingTransitions(now: number): void {
    while (
      pendingTransitions.length > 0 &&
      pendingTransitions[0]!.time <= now
    ) {
      engineActive.value = pendingTransitions.shift()!.active;
    }
  }

  function pushParamsToStage(): void {
    const registration = getPostFxRack();
    if (!registration) return;
    registration.amigaLpf.setParams(params.value);
  }

  /**
   * Push the current mode (+ resolved LED state) into the stage. Manual
   * override lives here: engine events below never reach the stage in
   * on/off modes, and this is the only place the mode is interpreted.
   */
  function applyModeToStage(now: number): void {
    const registration = getPostFxRack();
    if (!registration) return;
    const stage = registration.amigaLpf;
    if (mode.value === 'off') {
      stage.setBypassed(true, now);
      return;
    }
    stage.setBypassed(false, now);
    const led = mode.value === 'on' ? true : engineActive.value;
    stage.setLedActive(led, now);
  }

  function currentAudioTime(): number {
    const registration = getPostFxRack();
    return registration ? registration.rack.contextTime() : 0;
  }

  // If AudioSystem already exists, apply immediately; otherwise the callback
  // fires on registration and pushes the persisted state in.
  onPostFxRackRegistered((registration: PostFxRegistration) => {
    registration.amigaLpf.setParams(params.value);
    applyModeToStage(registration.rack.contextTime());
  });

  /** Set the master mode. Manual changes cancel pending engine toggles. */
  function setMode(next: PostFxFilterMode): void {
    if (mode.value === next) return;
    mode.value = next;
    settingsStore.updateSetting('postFxFilterMode', next);
    // Fold first so `engineActive` is what is actually applied at now, then
    // drop the whole queue: a mode switch mid-lookahead must not let any
    // already-scheduled E0x fire after the override (fix-cycle F4).
    foldPendingTransitions(currentAudioTime());
    pendingTransitions.length = 0;
    const now = currentAudioTime();
    const registration = getPostFxRack();
    if (registration) {
      registration.amigaLpf.cancelPending(now);
      applyModeToStage(now);
    }
  }

  /** Apply engine (E0x) activity. Ignored unless the mode is auto. */
  function applyEngineEvent(active: boolean, time: number): void {
    if (mode.value !== 'auto') return;
    // Queue the event, then fold anything the clock has already passed (the
    // event itself included, if its time has passed), so `engineActive`
    // always reads as the state in effect right now.
    let index = pendingTransitions.length;
    while (index > 0 && pendingTransitions[index - 1]!.time > time) {
      index -= 1;
    }
    pendingTransitions.splice(index, 0, { time, active });
    foldPendingTransitions(currentAudioTime());
    const registration = getPostFxRack();
    if (registration) {
      registration.amigaLpf.setLedActive(active, time);
    }
  }

  /**
   * A song was loaded (file open, demo browser, URL load, jukebox, New Song).
   * AUTO resets to OFF (Morten: AUTO defaults to OFF whenever a song is
   * loaded); manual modes are untouched and persist across loads.
   */
  function onSongLoad(): void {
    if (mode.value !== 'auto') return;
    const now = currentAudioTime();
    pendingTransitions.length = 0;
    engineActive.value = false;
    const registration = getPostFxRack();
    if (registration) {
      registration.amigaLpf.cancelPending(now);
      registration.amigaLpf.setLedActive(false, now);
    }
  }

  /**
   * Playback stopped: drop queued toggles (they belong to the stopped song)
   * while the applied LED state persists, like the hardware's (review S4).
   * Folding first means the applied state is the last transition the audio
   * clock actually passed (fix-cycle F4).
   */
  function onPlaybackStopped(): void {
    const registration = getPostFxRack();
    if (!registration) return;
    const now = registration.rack.contextTime();
    foldPendingTransitions(now);
    pendingTransitions.length = 0;
    registration.amigaLpf.cancelPending(now);
  }

  /** User tweaked the parameters. Both channels share the one set. */
  function setParams(next: AmigaLpfParams): void {
    params.value = sanitizeAmigaLpfParams(next);
    settingsStore.updateSetting('postFxFilterParams', params.value);
    pushParamsToStage();
  }

  function resetParamsToDefaults(): void {
    setParams({ ...AMIGA_LPF_DEFAULT_PARAMS });
  }

  /**
   * The LED state at audio time `now`. In AUTO, a scheduled E0x flips the
   * display only when the audio clock reaches its scheduled time; with
   * several toggles queued, entries the clock has passed fold in order.
   */
  function resolveLedAt(now: number): boolean {
    if (mode.value === 'off') return false;
    if (mode.value === 'on') return true;
    foldPendingTransitions(now);
    return engineActive.value;
  }

  return {
    mode,
    params,
    engineActive,
    resolveLedAt,
    setMode,
    setParams,
    resetParamsToDefaults,
    applyEngineEvent,
    onSongLoad,
    onPlaybackStopped,
  };
});