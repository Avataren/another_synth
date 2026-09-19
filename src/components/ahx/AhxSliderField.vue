<template>
  <div
    class="ahx-slider-field"
    :class="{ 'ahx-slider-field--disabled': disabled === true, 'ahx-slider-field--nolabel': !label }"
  >
    <span v-if="label" class="ahx-slider-field__label">{{ label }}</span>
    <div v-if="stepper" class="ahx-slider-field__stepper">
      <button
        type="button"
        class="ahx-slider-field__step"
        :disabled="disabled === true || shown <= (min ?? 0)"
        :aria-label="`${label || 'Value'}: one less`"
        :data-testid="testid ? `${testid}-dec` : ''"
        @click="emit('update:modelValue', Math.max(min ?? 0, shown - 1))"
      >
        −
      </button>
      <button
        type="button"
        class="ahx-slider-field__step"
        :disabled="disabled === true || shown >= max"
        :aria-label="`${label || 'Value'}: one more`"
        :data-testid="testid ? `${testid}-inc` : ''"
        @click="emit('update:modelValue', Math.min(max, shown + 1))"
      >
        +
      </button>
    </div>
    <div v-else class="ahx-slider-field__track">
      <input
        class="ahx-slider-field__range"
        type="range"
        step="1"
        :min="min ?? 0"
        :max="max"
        :value="shown"
        :disabled="disabled === true"
        v-bind="label ? { 'aria-label': label } : {}"
        :title="title ?? ''"
        :data-testid="testid ? `${testid}-slider` : ''"
        @input="onRangeInput"
        @change="onRangeChange"
        @blur="onRangeChange"
      />
      <span
        v-if="markerPercent !== null"
        class="ahx-slider-field__marker"
        :style="{ left: `${markerPercent}%` }"
        :title="markerTitle ?? ''"
        aria-hidden="true"
      />
    </div>
    <AhxNumberField
      compact
      :model-value="shown"
      :min="min ?? 0"
      :max="max"
      :disabled="disabled === true"
      :title="title ?? ''"
      :testid="testid ?? ''"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <span v-if="suffix" class="ahx-slider-field__suffix">{{ suffix }}</span>
    <p v-if="hint" class="ahx-slider-field__hint ahx-warn" :data-testid="testid ? `${testid}-hint` : ''">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * A GUI-first numeric control (editor plan E3): a native range input (or, with
 * `stepper`, minus/plus buttons) beside the typed number field, which keeps its
 * own `data-testid` and clamping. The slider is `${testid}-slider`.
 *
 * `throttleMs` is for fields that cost the song worklet a hi-fi table walk: while
 * the thumb is dragged the value goes out at most that often, and the value the
 * thumb is released on always goes out.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import { createCoalescer } from 'src/composables/useAhxDrag';

interface Props {
  modelValue: number;
  min?: number;
  max: number;
  label?: string;
  suffix?: string;
  title?: string;
  testid?: string;
  disabled?: boolean;
  stepper?: boolean;
  throttleMs?: number;
  /** A value to mark on the track (e.g. the filter's neutral position). */
  marker?: number;
  markerTitle?: string;
  /** A note under the control, e.g. that the value is past what the engine uses. */
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  label: '',
  suffix: '',
  title: '',
  testid: '',
  throttleMs: 0,
  markerTitle: '',
  hint: '',
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void;
}>();

/** What the thumb is at while it is being dragged, ahead of what the song has caught up to. */
const draft = ref<number | null>(null);
const shown = computed(() => draft.value ?? props.modelValue);

const coalescer = createCoalescer<number>((value) => emit('update:modelValue', value), {
  intervalMs: props.throttleMs,
});

function onRangeInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  draft.value = value;
  coalescer.push(value);
}

/** Release (or blur): the last value goes out now, and the song's value is shown again. */
function onRangeChange(event: Event): void {
  if (draft.value === null) return;
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isFinite(value)) coalescer.push(value);
  coalescer.flush();
  draft.value = null;
}

onBeforeUnmount(() => coalescer.flush());

const markerPercent = computed(() =>
  props.marker === undefined || props.max <= (props.min ?? 0)
    ? null
    : ((props.marker - (props.min ?? 0)) / (props.max - (props.min ?? 0))) * 100,
);
</script>

<style scoped>
.ahx-slider-field {
  display: grid;
  grid-template-columns: 100px minmax(60px, 1fr) auto auto;
  align-items: center;
  gap: 4px 10px;
}

.ahx-slider-field--nolabel {
  grid-template-columns: minmax(60px, 1fr) auto auto;
}

.ahx-slider-field__label {
  opacity: 0.65;
}

.ahx-slider-field__track {
  position: relative;
  min-width: 0;
}

.ahx-slider-field__range {
  display: block;
  width: 100%;
  min-height: 28px;
  margin: 0;
  accent-color: var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-slider-field__marker {
  position: absolute;
  bottom: 1px;
  width: 1px;
  height: 6px;
  background: currentColor;
  opacity: 0.6;
  pointer-events: none;
}

.ahx-slider-field__stepper {
  display: inline-flex;
  justify-self: start;
  gap: 4px;
}

.ahx-slider-field__step {
  min-width: 32px;
  min-height: 28px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.ahx-slider-field__step:disabled {
  cursor: default;
  opacity: 0.4;
}

.ahx-slider-field__suffix {
  opacity: 0.55;
  font-size: 0.8rem;
}

.ahx-slider-field__hint {
  grid-column: 1 / -1;
  margin: 0;
  color: #f0b25e;
  font-size: 0.8rem;
}

.ahx-slider-field--disabled {
  opacity: 0.6;
}
</style>
