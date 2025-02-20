<template>
  <div class="current-harmonics q-my-md">
    <div class="row items-center">
      <div
        class="vertical-sliders"
        style="flex: 1; overflow-x: auto; white-space: nowrap"
      >
        <div
          v-for="(harmonic, hIndex) in localHarmonics"
          :key="hIndex"
          style="
            display: inline-block;
            margin: 0 4px;
            text-align: center;
            vertical-align: top;
          "
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
            @update:model-value="
              (val) => updateHarmonic(hIndex, val, 'amplitude')
            "
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
            @update:model-value="(val) => updateHarmonic(hIndex, val, 'phase')"
          />
          <div style="font-size: 10px">H{{ hIndex + 1 }}</div>
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
      // Local copy to allow internal updates without mutating the prop
      localHarmonics: [],
    };
  },
  watch: {
    // When the parent's harmonics change (for example, due to resampling),
    // update the local copy and log the change.
    harmonics: {
      handler(newHarmonics) {
        // Clone the array to avoid accidental mutations
        this.localHarmonics = newHarmonics.map((h) => ({ ...h }));
      },
      deep: true,
      immediate: true,
    },
  },
  methods: {
    updateHarmonic(index, newValue, key) {
      // Update the specific harmonic in the local copy.
      const updated = { ...this.localHarmonics[index], [key]: newValue };
      // Ensure reactivity using Vue.set
      this.$set(this.localHarmonics, index, updated);

      // Emit the updated harmonics array to the parent.
      const emittedArray = this.localHarmonics.map((h) => ({ ...h }));

      this.$emit('update:harmonics', emittedArray);
    },
  },
};
</script>
