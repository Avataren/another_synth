/**
 * Post-fx state: the master OFF/ON/AUTO mode for the post-fx rack, the
 * engine-driven LED-filter activity, and the filter's tweakable parameters.
 *
 * The store is the single point where the playback engine's E0x events meet
 * the audio graph and the UI:
 *
 * - mode `auto` (default): a song load resets the LED filter to OFF, then E0x
 *   events toggle it. `applyEngineEvent` is the only engine-facing entry.
 *   AUTO also models the *hardware*: only a format that played through an
 *   Amiga (see AMIGA_CHAIN_FORMATS) gets the chain at all, so an XM or S3M
 *   comes out unfiltered rather than through the static RC stage.
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
  DEFAULT_MODULE_FORMAT,
  LIMITER_DEFAULT_PARAMS,
  getPostFxRack,
  onPostFxRackRegistered,
  sanitizeAmigaLpfParams,
  sanitizeLimiterParams,
  type AmigaLpfParams,
  type LimiterParams,
  type ModuleFormat,
  type PostFxRegistration,
} from '@another-synth/tracker-playback';
import { useUserSettingsStore } from 'src/stores/user-settings-store';

export type PostFxFilterMode = 'off' | 'on' | 'auto';

export const POST_FX_MODES: PostFxFilterMode[] = ['off', 'on', 'auto'];

/**
 * The formats that played through an Amiga's output chain, and so are the only
 * ones AUTO may filter at all.
 *
 * The chain is hardware, not a file feature: a MOD was played by Paula through
 * the A500's fixed ~4.9 kHz RC stage plus the switchable LED filter, which is
 * why `protracker` belongs here and why E0x means anything. FastTracker 2 and
 * Scream Tracker 3 were PC trackers whose output went to a Sound Blaster or a
 * GUS -- neither ever had that stage, so an XM or an S3M must come out
 * unfiltered in AUTO. (Both formats already refuse to *dispatch* E0x through
 * `FormatProfile.filterToggleCommand`; before this list, AUTO still engaged
 * the static RC filter on them, which audibly dulled every FT2 and ST3 song.)
 *
 * `native` is in for the same reason it dispatches E0x: in-app songs were
 * written against this engine with the chain in place, and can hand-type
 * E00/E01 into the effect column.
 *
 * Manual ON/OFF is unaffected -- it is a user override, and a user who wants
 * the Amiga colour on an XM may still ask for it.
 */
const AMIGA_CHAIN_FORMATS: readonly ModuleFormat[] = ['protracker', 'native'];

function formatHasAmigaChain(format: ModuleFormat): boolean {
  return AMIGA_CHAIN_FORMATS.includes(format);
}

export const usePostFxStore = defineStore('postFx', () => {
  const settingsStore = useUserSettingsStore();

  const mode = ref<PostFxFilterMode>(
    settingsStore.settings.postFxFilterMode ?? 'auto',
  );
  const params = ref<AmigaLpfParams>(
    sanitizeAmigaLpfParams(settingsStore.settings.postFxFilterParams ?? {}),
  );

  /**
   * The limiter is independent of the filter's OFF/ON/AUTO mode: no module
   * format commands it, so it is a plain persisted user toggle, on by
   * default (see user-settings-store).
   */
  const limiterEnabled = ref<boolean>(
    settingsStore.settings.postFxLimiterEnabled ?? true,
  );
  const limiterParams = ref<LimiterParams>(
    sanitizeLimiterParams(settingsStore.settings.postFxLimiterParams ?? {}),
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

  /**
   * Whether the loaded song's format has an Amiga output chain at all. Set on
   * every song load; the default matches the empty native song the app boots
   * with. AUTO consults it, manual on/off does not.
   */
  const songHasAmigaChain = ref(formatHasAmigaChain(DEFAULT_MODULE_FORMAT));
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
    if (mode.value === 'auto' && !songHasAmigaChain.value) {
      // AUTO on a PC-tracker song: no Amiga hardware to model, so the whole
      // stage is bypassed -- not merely the LED half. The static RC filter is
      // just as much an Amiga artefact as the LED one.
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
    registration.limiter.setParams(limiterParams.value);
    registration.limiter.setBypassed(
      !limiterEnabled.value,
      registration.rack.contextTime(),
    );
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
    // Belt to the engine's braces: `FormatProfile.filterToggleCommand` already
    // stops XM and S3M dispatching E0x, and a format with no Amiga chain has
    // nothing for the LED to switch.
    if (!songHasAmigaChain.value) return;
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
  function onSongLoad(format: ModuleFormat = DEFAULT_MODULE_FORMAT): void {
    // The format is recorded whatever the mode is -- a later switch back to
    // AUTO must know what the loaded song is.
    songHasAmigaChain.value = formatHasAmigaChain(format);
    if (mode.value !== 'auto') return;
    const now = currentAudioTime();
    pendingTransitions.length = 0;
    engineActive.value = false;
    const registration = getPostFxRack();
    if (registration) {
      registration.amigaLpf.cancelPending(now);
      // applyModeToStage bypasses the whole stage for a format that never had
      // the chain, and re-engages it (LED dark) for one that did.
      applyModeToStage(now);
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

  /** Engage or bypass the limiter (the stage crossfades, so no click). */
  function setLimiterEnabled(enabled: boolean): void {
    if (limiterEnabled.value === enabled) return;
    limiterEnabled.value = enabled;
    settingsStore.updateSetting('postFxLimiterEnabled', enabled);
    const registration = getPostFxRack();
    if (registration) {
      registration.limiter.setBypassed(!enabled, currentAudioTime());
    }
  }

  function setLimiterParams(next: LimiterParams): void {
    limiterParams.value = sanitizeLimiterParams(next);
    settingsStore.updateSetting('postFxLimiterParams', limiterParams.value);
    const registration = getPostFxRack();
    if (registration) {
      registration.limiter.setParams(limiterParams.value);
    }
  }

  function resetLimiterParamsToDefaults(): void {
    setLimiterParams({ ...LIMITER_DEFAULT_PARAMS });
  }

  /**
   * Gain reduction in dB (<= 0) for the meter. 0 when the stage is bypassed
   * or the rack does not exist yet (headless tests, pre-boot UI).
   */
  function limiterReduction(): number {
    const registration = getPostFxRack();
    if (!registration || !limiterEnabled.value) return 0;
    return registration.limiter.getReduction();
  }

  /**
   * The LED state at audio time `now`. In AUTO, a scheduled E0x flips the
   * display only when the audio clock reaches its scheduled time; with
   * several toggles queued, entries the clock has passed fold in order.
   */
  function resolveLedAt(now: number): boolean {
    if (mode.value === 'off') return false;
    if (mode.value === 'on') return true;
    if (!songHasAmigaChain.value) return false;
    foldPendingTransitions(now);
    return engineActive.value;
  }

  return {
    mode,
    params,
    limiterEnabled,
    limiterParams,
    setLimiterEnabled,
    setLimiterParams,
    resetLimiterParamsToDefaults,
    limiterReduction,
    engineActive,
    songHasAmigaChain,
    resolveLedAt,
    setMode,
    setParams,
    resetParamsToDefaults,
    applyEngineEvent,
    onSongLoad,
    onPlaybackStopped,
  };
});