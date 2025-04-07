```vue
<template>
  <div class="knob-wrapper">
    <div
      class="knob-container"
      :style="{ width: knobSize + 'px', height: knobSize + 'px' }"
      :class="{ disabled: props.disable }"
      ref="knobRef"
    >
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
        <path
          :d="describeValueArc"
          :stroke="props.color"
          :stroke-width="props.thickness"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
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
const startX = ref(0);
const startY = ref(0);
const lastX = ref(0);
const lastY = ref(0);
const dragValue = ref(props.modelValue);

const START_ANGLE = 210;
const SWEEP_ANGLE = 300;
const END_ANGLE = START_ANGLE + SWEEP_ANGLE;
const RANGE = SWEEP_ANGLE;
const FINE_TUNE_FACTOR = 0.1;

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
  if (valueRange === 0) return START_ANGLE;
  const percentage = (clampedValue - props.min) / valueRange;
  return START_ANGLE + percentage * RANGE;
});

const describeValueArc = computed((): string => {
  const radius = knobSize.value / 2 - props.thickness / 2;
  const center = knobSize.value / 2;
  const effectiveEndAngle = Math.max(START_ANGLE, currentAngle.value);
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
    const start = polarToCartesian(x, y, radius, startAngle);
    return `M ${start.x} ${start.y}`;
  }
  const start = polarToCartesian(x, y, radius, startAngle);
  const end = polarToCartesian(x, y, radius, endAngle);
  const angleDiff = endAngle - startAngle;
  const largeArcFlag = angleDiff > 180 ? '1' : '0';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

const displayUnit = computed((): string =>
  props.unitFunc ? props.unitFunc(props.modelValue) : props.unit || '',
);

const formatValue = (value: number | null | undefined) => {
  if (value === undefined || value === null || isNaN(value)) {
    return Number(props.min).toFixed(props.decimals);
  }
  try {
    return value.toFixed(props.decimals);
  } catch (e) {
    console.warn('Error formatting value', value, e);
    return Number(props.min).toFixed(props.decimals);
  }
};

const isEditing = ref(false);
const inputValue = ref(String(formatValue(props.modelValue)));
const inputRef = ref<HTMLInputElement | null>(null);
const inputStep = computed(() => 1 / Math.pow(10, props.decimals));

function startEditing(e: MouseEvent) {
  if (props.disable) return;
  e.stopPropagation();
  isEditing.value = true;
  inputValue.value = String(formatValue(props.modelValue));
  nextTick(() => {
    inputRef.value?.focus();
    inputRef.value?.select();
  });
}

function commitEditing() {
  if (props.disable) return;
  const newValueRaw = parseFloat(inputValue.value);
  if (!isNaN(newValueRaw)) {
    const newValue = Number(newValueRaw.toFixed(props.decimals));
    emit('update:modelValue', newValue);
  } else {
    inputValue.value = String(formatValue(props.modelValue));
  }
  isEditing.value = false;
}

function handleValueMouseDown(e: MouseEvent) {
  if (!isEditing.value) {
    e.preventDefault();
  }
}

function onMouseDown(e: MouseEvent) {
  if (props.disable || isEditing.value) return;
  if ((e.target as HTMLElement).closest('.value-display')) return;
  e.preventDefault();
  startX.value = e.clientX;
  startY.value = e.clientY;
  dragValue.value = props.modelValue;
  lastX.value = e.clientX;
  lastY.value = e.clientY;
  pendingDrag.value = true;
  knobRef.value?.classList.add('no-select');
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (props.disable) return;
  if (pendingDrag.value) {
    const dx = e.clientX - startX.value;
    const dy = e.clientY - startY.value;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 3) {
      isDragging.value = true;
      pendingDrag.value = false;
    } else {
      return;
    }
  }
  if (!isDragging.value) return;
  const isFineTuning = e.ctrlKey;
  const effectiveSensitivity = isFineTuning
    ? props.dragSensitivity * FINE_TUNE_FACTOR
    : props.dragSensitivity;
  const valueRange = props.max - props.min;
  if (valueRange <= 0) return;
  const deltaY = lastY.value - e.clientY;
  const deltaValue = (deltaY * effectiveSensitivity * valueRange) / 200;
  dragValue.value += deltaValue;
  const clampedValue = Math.min(
    props.max,
    Math.max(props.min, dragValue.value),
  );
  const roundedClampedValue = Number(clampedValue.toFixed(props.decimals));
  if (roundedClampedValue !== props.modelValue) {
    emit('update:modelValue', roundedClampedValue);
    dragValue.value = roundedClampedValue;
  }
  lastX.value = e.clientX;
  lastY.value = e.clientY;
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
  min-width: 80px;
}
.knob-container {
  position: relative;
  cursor: grab;
  display: flex;
  justify-content: center;
  align-items: center;
}
.knob-container:active {
  cursor: grabbing;
}
.no-select {
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
}
.knob-track {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}
.value-display {
  position: absolute;
  min-width: 40px;
  max-width: 90%;
  padding: 2px 4px;
  text-align: center;
  z-index: 1;
  font-size: 0.9rem;
  color: #ffffff;
  cursor: text;
  user-select: none;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
  box-sizing: border-box;
}
.value-input {
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  font-size: inherit;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  padding: 0;
  margin: 0;
  -moz-appearance: textfield;
}
.value-input::-webkit-outer-spin-button,
.value-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
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
  user-select: none;
  pointer-events: none;
}
.disabled {
  opacity: 0.5;
  cursor: not-allowed !important;
  pointer-events: none;
}
.disabled .value-display {
  cursor: not-allowed;
}
</style>
