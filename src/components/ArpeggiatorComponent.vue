<template>
  <q-card class="arpeggiator-card">
    <!-- Header -->
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Arpeggiator {{ props.nodeId }}</div>
    </q-card-section>

    <q-separator />

    <!-- Main Section -->
    <q-card-section>
      <!-- Global Controls -->
      <div class="global-controls q-gutter-sm">
        <q-input
          filled
          v-model.number="stepDuration"
          label="Step Duration (ms)"
          type="number"
          @blur="handleStepDurationChange"
        />
        <q-input
          filled
          v-model.number="stepCount"
          label="Number of Steps"
          type="number"
          @change="handleStepCountChange"
        />
      </div>

      <!-- Steps: Vertical Bars in a Flex-Wrap Container -->
      <div class="steps-grid">
        <div v-for="(step, index) in pattern" :key="index" class="step-column">
          <!-- Active Toggle -->
          <q-toggle
            size="sm"
            v-model="step.active"
            @update:modelValue="
              (val: boolean) => handleStepActiveChange(index, val)
            "
          />

          <!-- Vertical Slider (Bar) with reverse -->
          <q-slider
            v-model.number="step.value"
            vertical
            reverse
            thumb-label
            track-size="10px"
            track-color="blue"
            inner-track-color="light-blue"
            :min="-12"
            :max="12"
            :step="1"
            style="height: 120px; margin: 0.5rem 0"
            @update:modelValue="
              (val: number | null) => {
                if (val !== null) handleStepValueChange(index, val);
              }
            "
          />

          <!-- Step Number Label -->
          <div class="step-label">{{ index + 1 }}</div>
          <!-- Display only the number -->
          <div class="step-semitones">{{ step.value }}</div>
        </div>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { useInstrumentStore } from 'src/stores/instrument-store';

interface PatternStep {
  value: number;
  active: boolean;
}

interface Props {
  nodeId: string;
}

const props = withDefaults(defineProps<Props>(), { nodeId: '' });
const store = useInstrumentStore();

// Global arpeggiator controls
const stepDuration = ref<number>(100); // in milliseconds
const stepCount = ref<number>(8);

// Pattern array: each step has a 'value' and 'active' state
const pattern = reactive<PatternStep[]>([]);

// Helper to return a plain version of the pattern (no proxies)
function getPlainPattern(): PatternStep[] {
  return pattern.map((step) => ({ value: step.value, active: step.active }));
}

// On mount, initialize pattern with 'stepCount.value' steps
initializePattern(stepCount.value);

function initializePattern(count: number) {
  pattern.splice(0, pattern.length);
  for (let i = 0; i < count; i++) {
    pattern.push({ value: 0, active: true });
  }
}

// Called when the user finishes editing the step duration
function handleStepDurationChange() {
  if (store.currentInstrument) {
    store.currentInstrument.updateArpeggiatorStepDuration(
      props.nodeId,
      stepDuration.value,
    );
  }
}

// Called when the user changes the number of steps
function handleStepCountChange() {
  if (stepCount.value > pattern.length) {
    const diff = stepCount.value - pattern.length;
    for (let i = 0; i < diff; i++) {
      pattern.push({ value: 0, active: true });
    }
  } else if (stepCount.value < pattern.length) {
    pattern.splice(stepCount.value);
  }

  if (store.currentInstrument) {
    store.currentInstrument.updateArpeggiatorPattern(
      props.nodeId,
      getPlainPattern(),
    );
  }
}

// When a step's value changes: force reactivity update by splicing in a new object
function handleStepValueChange(index: number, val: number) {
  pattern.splice(index, 1, { ...pattern[index]!, value: val });
  if (store.currentInstrument) {
    store.currentInstrument.updateArpeggiatorPattern(
      props.nodeId,
      getPlainPattern(),
    );
  }
}

// When a step's active state changes
function handleStepActiveChange(index: number, val: boolean) {
  pattern[index]!.active = val;
  if (store.currentInstrument) {
    store.currentInstrument.updateArpeggiatorPattern(
      props.nodeId,
      getPlainPattern(),
    );
  }
}

// Watch for pattern changes and update immediately (using _newVal for unused parameter)
watch(
  pattern,
  (_newVal) => {
    if (store.currentInstrument) {
      store.currentInstrument.updateArpeggiatorPattern(
        props.nodeId,
        getPlainPattern(),
      );
    }
  },
  { deep: true },
);
</script>

<style scoped>
.arpeggiator-card {
  /* Fixed width so it doesn't expand horizontally */
  width: 500px;
  margin: 1rem auto;
}

.global-controls {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}

/* Use flex layout to allow wrapping to new rows */
.steps-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1rem;
  justify-content: center;
}

/* Fixed width for each step to control layout */
.step-column {
  width: 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}

.step-label {
  margin-top: 0.25rem;
  font-size: 0.75rem;
}

.step-semitones {
  font-size: 0.7rem;
  color: #555;
}
</style>
