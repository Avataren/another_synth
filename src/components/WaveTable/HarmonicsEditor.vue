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
            @update:model-value="(val) => updateAmplitude(index, val)"
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
            @update:model-value="(val) => updatePhase(index, val)"
          />
          <div class="harmonic-label">H{{ index + 1 }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
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
      // Local copy to allow internal updates without mutating the prop.
      localHarmonics: [],
    };
  },
  watch: {
    // When the parent's harmonics change, clone the array to avoid accidental mutations.
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
      this.updateHarmonic(index, value, 'amplitude');
    },
    updatePhase(index, value) {
      this.updateHarmonic(index, value, 'phase');
    },
    updateHarmonic(index, newValue, key) {
      // Create a new harmonic object to preserve immutability.
      const updated = { ...this.localHarmonics[index], [key]: newValue };
      // Use Vue.set to ensure reactivity (required in Vue 2).
      this.$set(this.localHarmonics, index, updated);
      // Emit a new cloned harmonics array to the parent.
      this.$emit(
        'update:harmonics',
        this.localHarmonics.map((h) => ({ ...h })),
      );
    },
  },
};
</script>

<style scoped>
.vertical-sliders {
  flex: 1;
  overflow-x: auto;
  white-space: nowrap;
}

.harmonic-container {
  display: inline-block;
  margin: 0 4px;
  text-align: center;
  vertical-align: top;
}

.harmonic-label {
  font-size: 10px;
}
</style>
