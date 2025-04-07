<template>
  <div class="knob-wrapper">
    <div
      class="knob-container"
      :style="{ width: knobSize + 'px', height: knobSize + 'px' }"
      :class="{ disabled: props.disable }"
      ref="knobRef"
    >
      <!-- Base Track -->
      <svg
        class="knob-track"
        :width="knobSize"
        :height="knobSize"
        :viewBox="`0 0 ${knobSize} ${knobSize}`"
      >
        <path
          :d="describeSemiCircle"
          stroke="#333333"
          :stroke-width="props.thickness"
          fill="none"
          stroke-linecap="round"
        />
        <!-- Value Track -->
        <path
          :d="describeValueArc"
          :stroke="props.color"
          :stroke-width="props.thickness"
          fill="none"
          stroke-linecap="round"
        />
      </svg>

      <!-- Center Value Display / Input (double-click to edit) -->
      <div
        class="value-display"
        @dblclick.stop="startEditing"
        @mousedown="handleValueMouseDown"
      >
        <template v-if="isEditing">
          <input
            ref="inputRef"
            class="value-input"
            v-model="inputValue"
            @keydown.enter="commitEditing"
            @blur="commitEditing"
            type="number"
            :step="inputStep"
          />
        </template>
        <template v-else>
          <div v-if="props.unitFunc">
            {{ displayUnit }}
          </div>
          <div v-else>
            {{ formatValue(props.modelValue) }}
          </div>
        </template>
      </div>

      <!-- Label -->
      <div class="knob-label">{{ props.label }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';

interface Props {
  modelValue: number;
  label: string;
  min: number;
  max: number;
  decimals: number;
  unit?: string;
  color?: string;
  unitFunc?: (val: number) => string;
  size?: number;
  dragSensitivity?: number;
  thickness?: number;
  scale?: 'full' | 'half' | 'mini';
  disable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 1,
  decimals: 2,
  unit: '',
  color: '#ff9800',
  size: 70,
  dragSensitivity: 0.5,
  thickness: 4,
  scale: 'full',
  disable: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

const knobSize = computed(() => {
  switch (props.scale) {
    case 'full':
      return 70;
    case 'half':
      return 50;
    case 'mini':
      return 35;
    default:
      return props.size;
  }
});

const knobRef = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const pendingDrag = ref(false);
const startX = ref(0); // Initial mouse X on mousedown
const startY = ref(0); // Initial mouse Y on mousedown
const lastX = ref(0); // Last known mouse X during move
const lastY = ref(0); // Last known mouse Y during move
// startValue is no longer the primary base for calculation during move,
// but we keep it to know the value when drag started if needed elsewhere.
const startValue = ref(props.modelValue);

const START_ANGLE = 210; // Visual start angle (bottom-left quadrant)
const SWEEP_ANGLE = 300; // Total degrees of rotation for the knob
const END_ANGLE = START_ANGLE + SWEEP_ANGLE; // = 510 degrees. SVG handles angles > 360
const RANGE = SWEEP_ANGLE; // The range used for value calculation is the sweep angle
const FINE_TUNE_FACTOR = 0.1; // How much Ctrl reduces sensitivity

// --- Arc Calculation Helpers  ---
const describeSemiCircle = computed((): string => {
  const radius = knobSize.value / 2 - props.thickness / 2;
  const center = knobSize.value / 2;
  return describeArc(center, center, radius, START_ANGLE, END_ANGLE);
});

const currentAngle = computed((): number => {
  const clampedValue = Math.min(
    props.max,
    Math.max(props.min, props.modelValue),
  );
  const valueRange = props.max - props.min;
  if (valueRange === 0) return START_ANGLE; // Avoid division by zero
  const percentage = (clampedValue - props.min) / valueRange;
  return START_ANGLE + percentage * RANGE;
});

const describeValueArc = computed((): string => {
  const radius = knobSize.value / 2 - props.thickness / 2;
  const center = knobSize.value / 2;
  const effectiveEndAngle = Math.max(START_ANGLE, currentAngle.value);
  // Prevent tiny negative arcs if value is slightly below min due to precision
  if (effectiveEndAngle <= START_ANGLE)
    return describeArc(center, center, radius, START_ANGLE, START_ANGLE);
  return describeArc(center, center, radius, START_ANGLE, effectiveEndAngle);
});

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  angleInDegrees: number,
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  if (endAngle <= startAngle + 1e-6) {
    // Handle precision issues or zero arc
    const start = polarToCartesian(x, y, radius, startAngle);
    // Draw a tiny line or just the start point to avoid errors
    // A simple 'M' command is often sufficient if no visible arc needed
    return `M ${start.x} ${start.y}`;
  }

  const start = polarToCartesian(x, y, radius, startAngle);
  const end = polarToCartesian(x, y, radius, endAngle);
  const angleDiff = endAngle - startAngle;
  const largeArcFlag = angleDiff > 180 ? '1' : '0';

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}
// --- End Arc Calculation Helpers ---

// --- Value Formatting and Editing ---
const displayUnit = computed((): string =>
  props.unitFunc ? props.unitFunc(props.modelValue) : props.unit || '',
);

const formatValue = (value: number | null | undefined) => {
  if (value === undefined || value === null || isNaN(value)) {
    return Number(props.min).toFixed(props.decimals); // Default to min formatted
  }
  try {
    return value.toFixed(props.decimals);
  } catch (e) {
    console.warn('Error formatting value', value, e);
    return Number(props.min).toFixed(props.decimals); // Fallback
  }
};

const isEditing = ref(false);
const inputValue = ref(String(formatValue(props.modelValue)));
const inputRef = ref<HTMLInputElement | null>(null);
const inputStep = computed(() => 1 / Math.pow(10, props.decimals)); // Step for number input

function startEditing(e: MouseEvent) {
  if (props.disable) return;
  e.stopPropagation();
  isEditing.value = true;
  inputValue.value = String(formatValue(props.modelValue)); // Use formatted value
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function commitEditing() {
  if (props.disable) return;
  const newValueRaw = parseFloat(inputValue.value);
  if (!isNaN(newValueRaw)) {
    // Keep current behavior: allow out-of-range input, but format decimals
    const newValue = Number(newValueRaw.toFixed(props.decimals));
    emit('update:modelValue', newValue);
  } else {
    // Reset input if invalid
    inputValue.value = String(formatValue(props.modelValue));
  }
  isEditing.value = false;
}

function handleValueMouseDown(e: MouseEvent) {
  if (!isEditing.value) {
    e.preventDefault(); // Prevent text selection on value display when not editing
  }
}
// --- End Value Formatting and Editing ---

// --- Drag Handling ---
function onMouseDown(e: MouseEvent) {
  if (props.disable || isEditing.value) return;
  // Prevent drag start if clicking the text input area itself
  if ((e.target as HTMLElement).closest('.value-display')) return;

  e.preventDefault();
  startX.value = e.clientX;
  startY.value = e.clientY;
  startValue.value = props.modelValue; // Store value at drag start
  lastX.value = e.clientX;
  lastY.value = e.clientY;
  pendingDrag.value = true; // Flag that drag might start if mouse moves enough
  knobRef.value?.classList.add('no-select'); // Prevent text selection during drag
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (props.disable) return; // Should not happen if listener is removed, but safe check

  // Check if minimum drag distance threshold is met
  if (pendingDrag.value) {
    const dx = e.clientX - startX.value;
    const dy = e.clientY - startY.value;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 3) {
      // Threshold = 3 pixels
      isDragging.value = true;
      pendingDrag.value = false;
      // Optional: Set cursor to grabbing if needed via CSS or JS
    } else {
      return; // Not dragging yet
    }
  }

  if (!isDragging.value) return; // Exit if not actively dragging

  const deltaY = lastY.value - e.clientY; // Vertical movement delta since last event

  // Check if the Ctrl key is pressed for fine-tuning
  const isFineTuning = e.ctrlKey;
  const effectiveSensitivity = isFineTuning
    ? props.dragSensitivity * FINE_TUNE_FACTOR
    : props.dragSensitivity;

  const valueRange = props.max - props.min;
  if (valueRange <= 0) return; // Avoid division by zero/negative range

  // Calculate the *change* in value based on the mouse delta and sensitivity
  const deltaValue = (deltaY * effectiveSensitivity * valueRange) / 200; // Normalize sensitivity (adjust 200 if needed)

  // Apply the calculated change to the *current* modelValue
  const newValue = props.modelValue + deltaValue;

  // Clamp the value to the defined min/max range
  const clampedValue = Math.min(props.max, Math.max(props.min, newValue));

  // Round the final clamped value according to decimals *before* emitting
  const roundedClampedValue = Number(clampedValue.toFixed(props.decimals));

  // Emit only if the rounded value has actually changed
  if (roundedClampedValue !== props.modelValue) {
    emit('update:modelValue', roundedClampedValue);
  }

  lastX.value = e.clientX;
  lastY.value = e.clientY;
}

function onMouseUp() {
  // Clean up regardless of whether a drag actually occurred
  knobRef.value?.classList.remove('no-select');
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  isDragging.value = false;
  pendingDrag.value = false;
  // Optional: Reset cursor if changed during drag
}
// --- End Drag Handling ---

// --- Lifecycle Hooks ---
onMounted(() => {
  // Use capture phase? Generally not needed unless preventing child handlers
  knobRef.value?.addEventListener('mousedown', onMouseDown);
});

onUnmounted(() => {
  // Crucial: Remove global listeners when component is destroyed
  // to prevent memory leaks and errors, especially if unmounted mid-drag.
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  // No need to remove listener from knobRef itself if it's being destroyed
});
// --- End Lifecycle Hooks ---
</script>

<style scoped>
.knob-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
  color: #ffffff;
  min-width: 80px; /* Ensure minimum width */
}

.knob-container {
  position: relative;
  cursor: grab;
  display: flex; /* Aligns SVG and text box */
  justify-content: center; /* Center SVG horizontally */
  align-items: center; /* Center SVG vertically */
  /* width/height set by :style */
}
.knob-container:active {
  cursor: grabbing;
}

.no-select {
  user-select: none; /* Standard */
  -webkit-user-select: none; /* Safari */
  -moz-user-select: none; /* Firefox */
  -ms-user-select: none; /* IE/Edge */
}

.knob-track {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none; /* SVG shouldn't block mouse events for the container */
}

.value-display {
  position: absolute;
  /* Centering is handled by parent flexbox, transform might interfere */
  /* top: 50%; left: 50%; transform: translate(-50%, -50%); */
  min-width: 40px;
  max-width: 90%; /* Prevent overflow on small knobs */
  padding: 2px 4px;
  text-align: center;
  z-index: 1;
  font-size: 0.9rem;
  color: #ffffff;
  cursor: text; /* Indicate text input possibility */
  user-select: none; /* Default to no selection */
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
  box-sizing: border-box;
}

.value-input {
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  font-size: inherit; /* Match parent font size */
  border: none;
  outline: none;
  background: transparent;
  color: inherit; /* Match parent text color */
  padding: 0;
  margin: 0;
  /* Remove spinner arrows on number input */
  -moz-appearance: textfield;
}
.value-input::-webkit-outer-spin-button,
.value-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.knob-label {
  margin-top: 0.5rem; /* Space between knob and label */
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
  text-align: center;
  /* Positioning relative to wrapper might be better if wrapper controls layout */
  position: absolute;
  bottom: -20px; /* Adjust as needed */
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap; /* Prevent label wrapping */
  user-select: none;
  pointer-events: none;
}

.disabled {
  opacity: 0.5;
  cursor: not-allowed !important; /* Override grab cursor */
  pointer-events: none; /* Block all interactions */
}
/* Ensure children of disabled also look disabled */
.disabled .value-display {
  cursor: not-allowed;
}
</style>
