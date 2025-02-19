<template>
  <div class="q-pa-md">
    <q-btn
      label="Open Wavetable Editor"
      color="primary"
      @click="showEditor = true"
    />

    <q-dialog
      v-model="showEditor"
      persistent
      transition-show="fade"
      @transition-end="handleTransitionEnd"
    >
      <q-card style="min-width: 1250px; max-height: 90vh; overflow-y: auto">
        <q-card-section>
          <div class="text-h6">Wavetable Editor</div>

          <!-- Harmonics Editor Component -->
          <HarmonicsEditor
            v-if="keyframes[selectedKeyframe]"
            :harmonics="keyframes[selectedKeyframe].harmonics"
            :phase-min="phaseMin"
            :phase-max="phaseMax"
            @update:harmonics="updateHarmonics"
          />

          <!-- Preset Selector Component -->
          <PresetSelector
            v-model="selectedPreset"
            :options="presetOptions"
            @update:preset="handlePresetChange"
          />

          <!-- Waveform Preview Component -->
          <WaveformPreview
            ref="waveformPreview"
            :width="1024"
            :height="200"
            :keyframes="keyframes"
            :selected-keyframe="selectedKeyframe"
            :morph-amount="morphAmount"
            :wave-warp-keyframes="waveWarpKeyframes"
            :selected-wave-warp-keyframe="selectedWaveWarpKeyframe"
            :warp-morph-amount="warpMorphAmount"
            :removeDC="removeDC"
            :normalize="normalize"
          />

          <!-- Timeline Component -->
          <WavetableTimeline
            :keyframes="keyframes"
            :selected-keyframe="selectedKeyframe"
            :scrub-position="scrubPosition"
            @update:selected="selectKeyframe"
            @update:scrub="updateScrubPosition"
            @update:morph="updateMorphAmount"
            @add-keyframe="addKeyframe"
            @remove-keyframe="removeKeyframe"
          />

          <!-- Wave Warp Timeline Component -->
          <WaveWarpTimeline
            :keyframes="waveWarpKeyframes"
            :selected-keyframe="selectedWaveWarpKeyframe"
            :scrub-position="scrubPosition"
            :warp-types="waveWarpTypes"
            @update:selected="selectWaveWarpKeyframe"
            @update:keyframes="updateWaveWarpKeyframes"
            @update:morph="updateWarpMorphAmount"
          />

          <!-- DSP Controls Component -->
          <DSPControls
            v-model:remove-dc="removeDC"
            v-model:normalize="normalize"
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancel" @click="cancel" />
          <q-btn flat label="Apply" color="primary" @click="apply" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script>
import HarmonicsEditor from './HarmonicsEditor.vue';
import PresetSelector from './PresetSelector.vue';
import WaveformPreview from './WaveformPreview.vue';
import WavetableTimeline from './WavetableTimeline.vue';
import WaveWarpTimeline from './WaveWarpTimeline.vue';
import DSPControls from './DSPControls.vue';

export default {
  name: 'WavetableEditor',
  components: {
    HarmonicsEditor,
    PresetSelector,
    WaveformPreview,
    WavetableTimeline,
    WaveWarpTimeline,
    DSPControls,
  },
  props: {
    numHarmonics: {
      type: Number,
      default: 64,
    },
  },
  data() {
    return {
      showEditor: false,
      keyframes: [],
      selectedKeyframe: 0,
      // Preset selection
      selectedPreset: 'custom',
      presetOptions: [
        { label: 'Custom', value: 'custom' },
        { label: 'Harmonic Series', value: 'harmonicSeries' },
      ],
      // DSP controls
      removeDC: false,
      normalize: true,
      phaseMin: -Math.PI,
      phaseMax: Math.PI,
      // Timeline state
      scrubPosition: 0,
      morphAmount: 0,
      // Wave Warp state
      waveWarpKeyframes: [],
      selectedWaveWarpKeyframe: 0,
      warpMorphAmount: 0,
      // Wave Warp types - Added this
      waveWarpTypes: ['pow', 'sine', 'asym', 'bend'],
    };
  },
  mounted() {
    // Initial keyframe setup
    this.keyframes = [
      {
        time: 0,
        harmonics: Array.from({ length: this.numHarmonics }, (_, i) => ({
          amplitude: i === 0 ? 1 : 0,
          phase: 0,
        })),
      },
    ];

    // Initial wave warp keyframe setup
    this.waveWarpKeyframes = [
      {
        time: 0,
        params: {
          amount: 0,
          type: 'pow',
        },
      },
    ];

    this.selectedKeyframe = 0;
    this.selectedWaveWarpKeyframe = 0;
  },
  watch: {
    selectedKeyframe: {
      handler(newVal) {
        if (newVal >= 0 && newVal < this.keyframes.length) {
          // Force a reactive update of the harmonics data
          const currentKeyframe = this.keyframes[newVal];
          if (currentKeyframe) {
            this.keyframes = this.keyframes.map((kf, index) => {
              if (index === newVal) {
                return { ...kf, harmonics: [...kf.harmonics] };
              }
              return kf;
            });
          }
        }
      },
      immediate: true,
    },
  },
  methods: {
    handleTransitionEnd() {
      // Dialog is fully visible and transition is complete
      this.updateLayouts();
    },
    updateLayouts() {
      if (this.$refs.wavetableTimeline) {
        this.$refs.wavetableTimeline.updateTimelineLayout();
      }
      if (this.$refs.waveWarpTimeline) {
        this.$refs.waveWarpTimeline.updateTimelineLayout();
      }
    },
    handlePresetChange(newVal) {
      if (newVal === 'harmonicSeries') {
        const totalKeyframes = 8;
        const newKeyframes = [];

        for (let i = 0; i < totalKeyframes; i++) {
          const time = (i / (totalKeyframes - 1)) * 100;
          const harmonics = Array.from({ length: this.numHarmonics }, () => ({
            amplitude: 0,
            phase: 0,
          }));
          if (i < this.numHarmonics) {
            harmonics[i].amplitude = 1;
          }
          newKeyframes.push({ time, harmonics });
        }

        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
        this.keyframes = newKeyframes;
        this.selectedPreset = 'custom';

        // Update layout after Vue has updated the DOM
        this.$nextTick(this.updateLayouts);
      }
    },
    updateHarmonics(newHarmonics) {
      // Create new references to trigger reactivity
      this.keyframes = this.keyframes.map((kf, index) => {
        if (index === this.selectedKeyframe) {
          return {
            ...kf,
            harmonics: newHarmonics,
          };
        }
        return kf;
      });

      // Ensure the waveform preview updates
      this.$nextTick(() => {
        if (this.$refs.waveformPreview) {
          this.$refs.waveformPreview.updateWaveformPreview();
        }
      });
    },

    selectKeyframe(index) {
      this.selectedKeyframe = index;
      this.$nextTick(() => {
        if (this.$refs.waveformPreview) {
          this.$refs.waveformPreview.updateWaveformPreview();
        }
      });
    },

    updateScrubPosition(position) {
      this.scrubPosition = position;
      this.$nextTick(() => {
        if (this.$refs.waveformPreview) {
          this.$refs.waveformPreview.updateWaveformPreview();
        }
      });
    },
    updateMorphAmount(amount) {
      this.morphAmount = amount;
      this.$nextTick(() => {
        if (this.$refs.waveformPreview) {
          this.$refs.waveformPreview.updateWaveformPreview();
        }
      });
    },

    selectWaveWarpKeyframe(index) {
      this.selectedWaveWarpKeyframe = index;
    },

    updateWaveWarpKeyframes(newKeyframes) {
      this.waveWarpKeyframes = newKeyframes;
    },

    updateWarpMorphAmount(amount) {
      this.warpMorphAmount = amount;
    },

    addKeyframe(targetTime) {
      const current = this.keyframes[this.selectedKeyframe];
      let newTime = targetTime ?? current.time;

      // Create new keyframe with proper harmonics data
      const newKeyframe = {
        time: newTime,
        harmonics: Array.from({ length: this.numHarmonics }, (_, i) => ({
          amplitude: current.harmonics[i]?.amplitude || 0,
          phase: current.harmonics[i]?.phase || 0,
        })),
      };

      // Create a new array reference to trigger reactivity
      const updatedKeyframes = [...this.keyframes, newKeyframe].sort(
        (a, b) => a.time - b.time,
      );

      this.keyframes = updatedKeyframes;

      // Find and set the new keyframe index after sorting
      const newIndex = updatedKeyframes.findIndex((kf) => kf.time === newTime);
      this.selectedKeyframe = newIndex;

      // Reset morph amount and scrub position to the new keyframe's time
      this.morphAmount = 0;
      this.scrubPosition = newTime;

      // Ensure the waveform preview updates
      this.$nextTick(() => {
        if (this.$refs.waveformPreview) {
          this.$refs.waveformPreview.updateWaveformPreview();
        }
      });
    },

    removeKeyframe() {
      if (this.keyframes.length > 1 && this.selectedKeyframe !== null) {
        this.keyframes.splice(this.selectedKeyframe, 1);
        if (this.selectedKeyframe >= this.keyframes.length) {
          this.selectedKeyframe = this.keyframes.length - 1;
        }
      }
    },

    sortKeyframes() {
      this.keyframes.sort((a, b) => a.time - b.time);
    },

    cancel() {
      this.showEditor = false;
    },

    apply() {
      this.$emit('update:keyframes', this.keyframes);
      this.$emit('update:wave-warp-keyframes', this.waveWarpKeyframes);
      this.showEditor = false;
    },
  },
};
</script>
