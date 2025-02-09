<!-- AudioKnobComponent.vue -->
<template>
  <div class="knob-wrapper">
    <div
      class="knob-container"
      :style="{ width: knobSize + 'px', height: knobSize + 'px' }"
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

      <!-- Center Value Display -->
      <div class="value-display">
        <div v-if="props.unitFunc">
          {{ displayUnit }}
        </div>
        <div v-else>
          {{ formatValue(props.modelValue) }}
        </div>
      </div>

      <!-- Label -->
      <div class="knob-label">{{ props.label }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';

interface Props {
  modelValue: number;
  label: string;
  min: number;
  max: number;
  decimals: number;
  unit?: string;
  color?: string;
  unitFunc?: (val: number) => string;
  size?: number; // still available as a fallback if needed
  dragSensitivity?: number;
  thickness?: number;
  // New prop to select a preset scale:
  scale?: 'full' | 'half' | 'mini';
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
  scale: 'full', // default scale
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void;
}>();

// Compute the knob size based on the selected scale.
// These numbers are arbitrary – adjust as needed.
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

// Define a ref for the knob container so we can attach drag events.
const knobRef = ref<HTMLElement | null>(null);

// Local state for dragging
const isDragging = ref(false);
const pendingDrag = ref(false);
const startX = ref(0);
const startY = ref(0);
const startValue = ref(props.modelValue);

// ───── ARC CONSTANTS ─────
// We want an arc that spans 260° (from -40° to 220°)
const START_ANGLE = -40;
const END_ANGLE = 220;
const RANGE = END_ANGLE - START_ANGLE; // 260°

// ─── COMPUTED PROPERTIES ───
const describeSemiCircle = computed((): string => {
  const radius = knobSize.value / 2 - 4;
  const center = knobSize.value / 2;
  return describeArc(center, center, radius, START_ANGLE, END_ANGLE);
});

const currentAngle = computed((): number => {
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

// ─── HELPER FUNCTIONS ───

// Converts polar coordinates to cartesian.
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

// Returns an SVG arc path.
function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): string {
  const start = polarToCartesian(x, y, radius, startAngle);
  const end = polarToCartesian(x, y, radius, endAngle);
  let diff = endAngle - startAngle;
  if (diff < 0) diff += 360;
  const largeArcFlag = diff <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

const formatValue = (value: number): string => {
  return `${value.toFixed(props.decimals)}${props.unit || ''}`;
};

// ─── DRAG EVENT HANDLERS ───

function onMouseDown(e: MouseEvent) {
  e.preventDefault(); // Prevent default text selection
  startX.value = e.clientX;
  startY.value = e.clientY;
  startValue.value = props.modelValue;
  pendingDrag.value = true;
  // Add a class to disable text selection on the knob element only.
  knobRef.value?.classList.add('no-select');
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  const dx = e.clientX - startX.value;
  const dy = e.clientY - startY.value;
  const distance = Math.sqrt(dx * dx + dy * dy);
  // Begin dragging after a small movement threshold.
  if (pendingDrag.value && distance > 3) {
    isDragging.value = true;
    pendingDrag.value = false;
  }
  if (isDragging.value) {
    const deltaY = startY.value - e.clientY;
    const sensitivity = props.dragSensitivity;
    const deltaValue = (deltaY * sensitivity * (props.max - props.min)) / 200;
    const newValue = startValue.value + deltaValue;
    const clampedValue = Math.min(
      props.max,
      Math.max(props.min, Number(newValue.toFixed(props.decimals))),
    );
    if (clampedValue !== props.modelValue) {
      emit('update:modelValue', clampedValue);
    }
  }
}

function onMouseUp(_e: MouseEvent) {
  // Remove the no-select class when dragging is complete.
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

/* Disable text selection on the knob element during dragging */
.no-select {
  user-select: none;
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
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
</style>
