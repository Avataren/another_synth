<template>
  <!--
    Post-fx master control: OFF / ON / AUTO for the rack's Amiga-style low
    pass filter, with the LED showing whether the LED filter stage is active
    *right now* (resolved against the audio clock, since E0x events are
    scheduled up to a second ahead -- see post-fx-store.resolveLedAt).
  -->
  <div v-if="!compact" class="post-fx-control">
    <span
      class="post-fx-led"
      :class="{ on: ledOn }"
      :title="ledOn ? 'LED filter active' : 'LED filter off'"
    ></span>
    <div class="post-fx-segment" role="group" aria-label="Post-fx filter mode">
      <button
        v-for="option in MODE_OPTIONS"
        :key="option.id"
        type="button"
        class="post-fx-mode-btn"
        :class="{ active: mode === option.id }"
        :title="option.title"
        @click="selectMode(option.id)"
      >
        {{ option.label }}
      </button>
    </div>
    <button type="button" class="post-fx-params-btn" title="Filter parameters">
      <q-icon name="tune" size="16px" />
      <q-menu class="post-fx-params-menu" anchor="bottom right" self="top right">
        <div class="post-fx-params">
          <label class="post-fx-param">
            <span class="param-label">Static cutoff</span>
            <input
              type="range"
              min="200"
              max="16000"
              step="10"
              :value="params.staticCutoffHz"
              @input="onStaticCutoff($event)"
            />
            <span class="param-value">{{ Math.round(params.staticCutoffHz) }} Hz</span>
          </label>
          <label class="post-fx-param">
            <span class="param-label">LED cutoff</span>
            <input
              type="range"
              min="200"
              max="16000"
              step="10"
              :value="params.ledCutoffHz"
              @input="onLedCutoff($event)"
            />
            <span class="param-value">{{ Math.round(params.ledCutoffHz) }} Hz</span>
          </label>
          <label class="post-fx-param">
            <span class="param-label">LED resonance</span>
            <input
              type="range"
              min="-12"
              max="6"
              step="0.1"
              :value="params.ledResDb"
              @input="onLedRes($event)"
            />
            <span class="param-value">{{ params.ledResDb.toFixed(1) }} dB</span>
          </label>
          <button
            type="button"
            class="post-fx-reset song-button ghost"
            @click="postFxStore.resetParamsToDefaults()"
          >
            Amiga defaults
          </button>
        </div>
      </q-menu>
    </button>
  </div>

  <!-- Compact chip for the tracker's mobile toolbar strip. -->
  <button
    v-else
    type="button"
    class="panel-chip post-fx-chip"
    :title="`Filter: ${mode.toUpperCase()}`"
  >
    <span class="post-fx-led" :class="{ on: ledOn }"></span>
    FX: {{ mode.toUpperCase() }}
    <q-menu class="post-fx-params-menu" anchor="bottom left" self="top left">
      <div class="post-fx-params">
        <div class="post-fx-segment compact-segment">
          <button
            v-for="option in MODE_OPTIONS"
            :key="option.id"
            type="button"
            class="post-fx-mode-btn"
            :class="{ active: mode === option.id }"
            @click="selectMode(option.id)"
          >
            {{ option.label }}
          </button>
        </div>
        <label class="post-fx-param">
          <span class="param-label">Static cutoff</span>
          <input
            type="range"
            min="200"
            max="16000"
            step="10"
            :value="params.staticCutoffHz"
            @input="onStaticCutoff($event)"
          />
          <span class="param-value">{{ Math.round(params.staticCutoffHz) }} Hz</span>
        </label>
        <label class="post-fx-param">
          <span class="param-label">LED cutoff</span>
          <input
            type="range"
            min="200"
            max="16000"
            step="10"
            :value="params.ledCutoffHz"
            @input="onLedCutoff($event)"
          />
          <span class="param-value">{{ Math.round(params.ledCutoffHz) }} Hz</span>
        </label>
        <label class="post-fx-param">
          <span class="param-label">LED resonance</span>
          <input
            type="range"
            min="-12"
            max="6"
            step="0.1"
            :value="params.ledResDb"
            @input="onLedRes($event)"
          />
          <span class="param-value">{{ params.ledResDb.toFixed(1) }} dB</span>
        </label>
        <button
          type="button"
          class="post-fx-reset song-button ghost"
          @click="postFxStore.resetParamsToDefaults()"
        >
          Amiga defaults
        </button>
      </div>
    </q-menu>
  </button>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { usePostFxStore, type PostFxFilterMode } from 'src/stores/post-fx-store';
import { getPostFxRack } from '@another-synth/tracker-playback';
import { getSharedAudioSystem } from 'src/audio/shared-audio-system';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';

defineProps<{
  /** Compact chip form (tracker mobile strip). */
  compact?: boolean;
}>();

const emit = defineEmits<{
  (e: 'mode-change', mode: PostFxFilterMode): void;
}>();

const postFxStore = usePostFxStore();

const MODE_OPTIONS: Array<{ id: PostFxFilterMode; label: string; title: string }> = [
  { id: 'off', label: 'OFF', title: 'Full bypass' },
  { id: 'on', label: 'ON', title: 'Amiga filter cascade (static + LED)' },
  { id: 'auto', label: 'AUTO', title: "Follow the song's E0x set-filter commands" },
];

const mode = computed(() => postFxStore.mode);
const params = computed(() => postFxStore.params);

/**
 * The LED resolved against the audio clock, refreshed per frame: engine E0x
 * events are scheduled ahead, so the truth is time-dependent.
 */
const ledOn = ref(false);
let unregisterTick: (() => void) | null = null;
let audioContext: AudioContext | null = null;

/**
 * "Now" on the same clock the engine scheduled E0x against -- the rack's
 * context -- falling back to the shared context (and to 0 in headless envs).
 */
function resolveNow(): number {
  const registration = getPostFxRack();
  if (registration) return registration.rack.contextTime();
  return audioContext?.currentTime ?? 0;
}

onMounted(() => {
  try {
    audioContext = getSharedAudioSystem().audioContext;
  } catch {
    audioContext = null;
  }
  unregisterTick = registerAnimationCallback(() => {
    ledOn.value = postFxStore.resolveLedAt(resolveNow());
  });
});

onBeforeUnmount(() => {
  unregisterTick?.();
  unregisterTick = null;
});

function selectMode(next: PostFxFilterMode): void {
  postFxStore.setMode(next);
  emit('mode-change', next);
}

function onStaticCutoff(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  postFxStore.setParams({ ...postFxStore.params, staticCutoffHz: value });
}

function onLedCutoff(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  postFxStore.setParams({ ...postFxStore.params, ledCutoffHz: value });
}

function onLedRes(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  postFxStore.setParams({ ...postFxStore.params, ledResDb: value });
}
</script>

<style scoped>
/*
  Toolbar-sized: the control shares the tracker's single desktop toolbar
  row, so it stays LED + tight segment + tune icon and yields vertical
  space to the row's other controls.
 */
.post-fx-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.post-fx-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.25);
  flex: 0 0 auto;
}

.post-fx-led.on {
  background: #ffb347;
  border-color: #ffcf87;
  box-shadow: 0 0 6px rgba(255, 179, 71, 0.7);
}

.post-fx-segment {
  display: inline-flex;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  overflow: hidden;
}

.post-fx-mode-btn,
.post-fx-segment button {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 5px;
  cursor: pointer;
}

.post-fx-segment button + button {
  border-left: 1px solid rgba(255, 255, 255, 0.18);
}

.post-fx-segment button.active,
.post-fx-mode-btn.active {
  background: rgba(255, 179, 71, 0.16);
  color: #ffcf87;
}

.post-fx-params-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.post-fx-params-btn:hover,
.post-fx-mode-btn:hover,
.post-fx-segment button:hover {
  color: var(--text-primary, rgba(255, 255, 255, 0.95));
}

.post-fx-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.compact-segment {
  margin-bottom: 8px;
}
</style>

<style>
/* The menu renders in a portal, so it cannot be scoped. */
.post-fx-params {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  min-width: 240px;
  background: #1d2126;
}

.post-fx-param {
  display: grid;
  grid-template-columns: 1fr 70px;
  grid-template-rows: auto auto;
  column-gap: 8px;
  align-items: center;
}

.post-fx-param .param-label {
  grid-column: 1;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
}

.post-fx-param .param-value {
  grid-column: 2;
  grid-row: 1 / span 2;
  font-size: 11px;
  text-align: right;
  color: rgba(255, 255, 255, 0.9);
  font-variant-numeric: tabular-nums;
}

.post-fx-param input[type='range'] {
  grid-column: 1;
  width: 100%;
}

.post-fx-reset {
  align-self: flex-start;
}
</style>