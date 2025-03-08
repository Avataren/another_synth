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
  disable?: boolean; // New prop for disabling interaction
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
  disable: false, // Enabled by default
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

// Compute the knob size based on the selected scale.
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
const startX = ref(0);
const startY = ref(0);
const startValue = ref(props.modelValue);

const START_ANGLE = -40;
const END_ANGLE = 220;
const RANGE = END_ANGLE - START_ANGLE;

// Base track: always shows the full arc.
const describeSemiCircle = computed((): string => {
  const radius = knobSize.value / 2 - 4;
  const center = knobSize.value / 2;
  return describeArc(center, center, radius, START_ANGLE, END_ANGLE);
});

// When the modelValue is outside the legal range, show the full arc (END_ANGLE).
const currentAngle = computed((): number => {
  if (props.modelValue < props.min || props.modelValue > props.max) {
    return END_ANGLE;
  }
  const percentage = (props.modelValue - props.min) / (props.max - props.min);
  return START_ANGLE + percentage * RANGE;
});

const describeValueArc = computed((): string => {
  const radius = knobSize.value / 2 - 4;
  const center = knobSize.value / 2;
  return describeArc(center, center, radius, START_ANGLE, currentAngle.value);
});

const displayUnit = computed((): string =>
  props.unitFunc ? props.unitFunc(props.modelValue) : props.unit || '',
);

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
  const start = polarToCartesian(x, y, radius, startAngle);
  const end = polarToCartesian(x, y, radius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

const formatValue = (value: number): string => {
  return `${value.toFixed(props.decimals)}${props.unit || ''}`;
};

const isEditing = ref(false);
const inputValue = ref(String(props.modelValue));
const inputRef = ref<HTMLInputElement | null>(null);

function startEditing(e: MouseEvent) {
  if (props.disable) return;
  e.stopPropagation();
  isEditing.value = true;
  inputValue.value = String(props.modelValue);
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function commitEditing() {
  if (props.disable) return;
  const newValue = parseFloat(inputValue.value);
  if (!isNaN(newValue)) {
    // Allow custom values outside the legal range (no clamping here)
    emit('update:modelValue', Number(newValue.toFixed(props.decimals)));
  }
  isEditing.value = false;
}

function handleValueMouseDown(e: MouseEvent) {
  // Prevent text selection when not editing.
  if (!isEditing.value) {
    e.preventDefault();
  }
}

function onMouseDown(e: MouseEvent) {
  if (props.disable) return;
  // Do not start a drag if clicking inside the value display.
  if ((e.target as HTMLElement).closest('.value-display')) return;
  e.preventDefault();
  startX.value = e.clientX;
  startY.value = e.clientY;
  startValue.value = props.modelValue;
  pendingDrag.value = true;
  knobRef.value?.classList.add('no-select');
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (props.disable) return;
  // Check if we've moved far enough to consider this a drag.
  const dx = e.clientX - startX.value;
  const dy = e.clientY - startY.value;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (pendingDrag.value && distance > 3) {
    isDragging.value = true;
    pendingDrag.value = false;
  }
  if (!isDragging.value) return;
  const deltaY = startY.value - e.clientY;
  const deltaValue =
    (deltaY * props.dragSensitivity * (props.max - props.min)) / 200;
  const newValue = startValue.value + deltaValue;
  // For dragging, clamp the value to the legal range.
  const clampedValue = Math.min(
    props.max,
    Math.max(props.min, Number(newValue.toFixed(props.decimals))),
  );
  if (clampedValue !== props.modelValue) {
    emit('update:modelValue', clampedValue);
  }
}

function onMouseUp() {
  knobRef.value?.classList.remove('no-select');
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  isDragging.value = false;
  pendingDrag.value = false;
}

onMounted(() => {
  knobRef.value?.addEventListener('mousedown', onMouseDown);
});
onUnmounted(() => {
  knobRef.value?.removeEventListener('mousedown', onMouseDown);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});
</script>

<style scoped>
.knob-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
  color: #ffffff;
}

.knob-container {
  position: relative;
  cursor: grab;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.no-select {
  user-select: none;
}

.knob-track {
  transform: rotate(-90deg);
  position: absolute;
  top: 0;
  left: 0;
}

.value-display {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  min-width: 40px;
  text-align: center;
  z-index: 1;
  font-size: 0.9rem;
  color: #ffffff;
  cursor: text;
  user-select: none;
}

.value-input {
  width: 100%;
  text-align: center;
  font-size: 0.9rem;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
}

.knob-label {
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.7);
  text-align: center;
  position: absolute;
  bottom: -20px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
}

/* When disabled, reduce opacity and block pointer events */
.disabled {
  opacity: 0.5;
  pointer-events: none;
}
</style>
