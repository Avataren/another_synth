// HarmonicsEditor.vue
<template>
  <div class="current-harmonics q-my-md">
    <div class="row items-center">
      <div class="vertical-sliders">
        <div
          v-for="(harmonic, index) in localHarmonics"
          :key="index"
          class="harmonic-container"
        >
          <!-- Amplitude slider -->
          <q-slider
            :model-value="harmonic.amplitude"
            vertical
            reverse
            :min="0"
            :max="1"
            :step="0.01"
            color="primary"
            class="harmonic-slider"
            @update:model-value="(val) => debouncedUpdateAmplitude(index, val)"
          />
          <!-- Phase slider -->
          <q-slider
            :model-value="harmonic.phase"
            vertical
            reverse
            :min="phaseMin"
            :max="phaseMax"
            :step="0.01"
            color="accent"
            class="harmonic-slider"
            @update:model-value="(val) => debouncedUpdatePhase(index, val)"
          />
          <div class="harmonic-label">H{{ index + 1 }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { debounce } from 'lodash';

export default {
  name: 'HarmonicsEditor',
  props: {
    harmonics: {
      type: Array,
      required: true,
    },
    phaseMin: {
      type: Number,
      required: true,
    },
    phaseMax: {
      type: Number,
      required: true,
    },
  },

  data() {
    return {
      localHarmonics: [],
      updateQueue: new Map(),
      isUpdating: false,
    };
  },

  created() {
    this.debouncedUpdateAmplitude = debounce(this.updateAmplitude, 16);
    this.debouncedUpdatePhase = debounce(this.updatePhase, 16);
    this.debouncedEmitUpdates = debounce(this.emitUpdates, 32);
  },

  watch: {
    harmonics: {
      handler(newHarmonics) {
        this.localHarmonics = newHarmonics.map((h) => ({ ...h }));
      },
      deep: true,
      immediate: true,
    },
  },

  methods: {
    updateAmplitude(index, value) {
      this.queueUpdate(index, 'amplitude', value);
    },

    updatePhase(index, value) {
      this.queueUpdate(index, 'phase', value);
    },

    queueUpdate(index, key, value) {
      const harmonicUpdates = this.updateQueue.get(index) || {};
      harmonicUpdates[key] = value;
      this.updateQueue.set(index, harmonicUpdates);

      // Schedule emission of updates
      this.debouncedEmitUpdates();
    },

    emitUpdates() {
      if (this.isUpdating) return;
      this.isUpdating = true;

      const updatedHarmonics = [...this.localHarmonics];

      for (const [index, updates] of this.updateQueue.entries()) {
        updatedHarmonics[index] = {
          ...updatedHarmonics[index],
          ...updates,
        };
      }

      this.updateQueue.clear();
      this.localHarmonics = updatedHarmonics;
      this.$emit(
        'update:harmonics',
        updatedHarmonics.map((h) => ({ ...h })),
      );

      this.isUpdating = false;
    },
  },
};
</script>

<style scoped>
.vertical-sliders {
  flex: 1;
  overflow-x: auto;
  white-space: nowrap;
  contain: content; /* CSS containment for better performance */
}

.harmonic-container {
  display: inline-block;
  margin: 0 4px;
  text-align: center;
  vertical-align: top;
  contain: content;
}

.harmonic-label {
  font-size: 10px;
}

/* Use hardware acceleration */
.harmonic-slider {
  transform: translateZ(0);
  will-change: transform;
}
</style>
