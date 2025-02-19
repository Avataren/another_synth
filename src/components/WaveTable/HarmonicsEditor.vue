<template>
  <div class="current-harmonics q-my-md">
    <div class="row items-center">
      <div
        class="vertical-sliders"
        style="flex: 1; overflow-x: auto; white-space: nowrap"
      >
        <div
          v-for="(harmonic, hIndex) in harmonics"
          :key="hIndex"
          style="
            display: inline-block;
            margin: 0 4px;
            text-align: center;
            vertical-align: top;
          "
        >
          <q-slider
            v-model="harmonic.amplitude"
            vertical
            reverse
            :min="0"
            :max="1"
            :step="0.01"
            color="primary"
            class="harmonic-slider"
            @update:model-value="updateHarmonic(hIndex)"
          />
          <q-slider
            v-model="harmonic.phase"
            vertical
            reverse
            :min="phaseMin"
            :max="phaseMax"
            :step="0.01"
            color="accent"
            class="harmonic-slider"
            @update:model-value="updateHarmonic(hIndex)"
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
  methods: {
    updateHarmonic(_index) {
      this.$emit('update:harmonics', [...this.harmonics]);
    },
  },
};
</script>
