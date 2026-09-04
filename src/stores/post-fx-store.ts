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
   * The LED state the engine last commanded (in AUTO). `activeFrom` is the
   * audio time that command takes effect; `activeBefore` is what was in
   * effect until then, so the LED can be resolved "right now" against
   * `audioContext.currentTime` even though scheduling runs ahead.
   */
  const engineActive = ref(false);
  const activeFrom = ref(0);
  const activeBefore = ref(false);

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
    activeBefore.value = engineActive.value;
    engineActive.value = active;
    activeFrom.value = time;
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
    engineActive.value = false;
    activeBefore.value = false;
    activeFrom.value = now;
    const registration = getPostFxRack();
    if (registration) {
      registration.amigaLpf.cancelPending(now);
      registration.amigaLpf.setLedActive(false, now);
    }
  }

  /**
   * Playback stopped: drop queued toggles (they belong to the stopped song)
   * while the applied LED state persists, like the hardware's (review S4).
   */
  function onPlaybackStopped(): void {
    const registration = getPostFxRack();
    if (!registration) return;
    registration.amigaLpf.cancelPending(registration.rack.contextTime());
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
   * display only when the audio clock reaches its scheduled time.
   */
  function resolveLedAt(now: number): boolean {
    if (mode.value === 'off') return false;
    if (mode.value === 'on') return true;
    return now >= activeFrom.value ? engineActive.value : activeBefore.value;
  }

  return {
    mode,
    params,
    engineActive,
    activeFrom,
    resolveLedAt,
    setMode,
    setParams,
    resetParamsToDefaults,
    applyEngineEvent,
    onSongLoad,
    onPlaybackStopped,
  };
});