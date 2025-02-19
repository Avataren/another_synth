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
            :harmonics="keyframes[selectedKeyframe]!.harmonics"
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
          <MasterTimeline
            :scrub-position="scrubPosition"
            @update:scrub-position="updateMasterScrubPosition"
          />
          <!-- Timeline Component -->
          <WavetableTimeline
            :keyframes="keyframes"
            :selected-keyframe="selectedKeyframe"
            :scrub-position="scrubPosition"
            @update:selected="selectKeyframe"
            @update:keyframes="updateKeyframes"
            @add-keyframe="addKeyframe"
            @remove-keyframe="removeKeyframe"
            :read-only="true"
          />

          <!-- Wave Warp Timeline Component -->
          <WaveWarpTimeline
            :keyframes="waveWarpKeyframes"
            :selected-keyframe="selectedWaveWarpKeyframe"
            :scrub-position="scrubPosition"
            :warp-types="waveWarpTypes"
            @update:selected="selectWaveWarpKeyframe"
            @update:keyframes="updateWaveWarpKeyframes"
            :read-only="true"
          />

          <!-- DSP Controls Component -->
          <DSPControls
            v-model:remove-dc="removeDC"
            v-model:normalize="normalize"
          />
        </q-card-section>

        <q-card-actions align="right" class="q-px-md">
          <div class="row full-width items-center q-gutter-md">
            <div class="col">
              <q-linear-progress
                :value="generationProgress"
                color="primary"
                class="q-mt-md"
                style="height: 4px"
              >
                <div class="absolute-full flex flex-center">
                  <q-badge color="primary" text-color="white">
                    {{ Math.round(generationProgress * 100) }}%
                  </q-badge>
                </div>
              </q-linear-progress>
            </div>
            <div class="col-auto">
              <q-btn
                flat
                label="Reset"
                color="warning"
                @click="resetToSinewave"
                :disable="isGenerating"
              />
              <q-btn
                flat
                label="Close"
                @click="cancel"
                :disable="isGenerating"
              />
              <q-btn
                flat
                label="Apply"
                color="primary"
                @click="apply"
                :loading="isGenerating"
                :disable="isGenerating"
              />
            </div>
          </div>
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script lang="ts">
import MasterTimeline from './MasterTimeline.vue';
import HarmonicsEditor from './HarmonicsEditor.vue';
import PresetSelector from './PresetSelector.vue';
import WaveformPreview from './WaveformPreview.vue';
import WavetableTimeline from './WavetableTimeline.vue';
import WaveWarpTimeline from './WaveWarpTimeline.vue';
import DSPControls from './DSPControls.vue';
import {
  exportWavetableToWav,
  generateWavetable,
  type Keyframe,
  type WaveWarpKeyframe,
} from './WavetableUtils';

interface ComponentRefs {
  waveformPreview: typeof WaveformPreview | null;
  wavetableTimeline: typeof WavetableTimeline | null;
  waveWarpTimeline: typeof WaveWarpTimeline | null;
}

export default {
  name: 'WavetableEditor',
  components: {
    HarmonicsEditor,
    PresetSelector,
    WaveformPreview,
    WavetableTimeline,
    WaveWarpTimeline,
    DSPControls,
    MasterTimeline,
  },
  props: {
    numHarmonics: {
      type: Number,
      default: 32,
    },
  },
  data() {
    return {
      showEditor: false,
      keyframes: [] as Keyframe[],
      waveWarpKeyframes: [] as WaveWarpKeyframe[],
      selectedKeyframe: 0,
      // Preset selection
      selectedPreset: 'custom',
      presetOptions: [
        { label: 'Custom', value: 'custom' },
        { label: 'Harmonic Series', value: 'harmonicSeries' },
      ],
      // DSP controls
      removeDC: true,
      normalize: true,
      phaseMin: -Math.PI,
      phaseMax: Math.PI,
      // Timeline state
      scrubPosition: 0,
      morphAmount: 0,
      // Wave Warp state
      selectedWaveWarpKeyframe: 0,
      warpMorphAmount: 0,
      // Wave Warp types - Added this
      waveWarpTypes: ['pow', 'sine', 'asym', 'bend'],
      generationProgress: 0,
      isGenerating: false,
    };
  },
  ref() {
    return {
      waveformPreview: null as typeof WaveformPreview | null,
      wavetableTimeline: null as typeof WavetableTimeline | null,
      waveWarpTimeline: null as typeof WaveWarpTimeline | null,
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
          xAmount: 0,
          yAmount: 0,
          asymmetric: false,
        },
      },
    ];

    this.selectedKeyframe = 0;
    this.selectedWaveWarpKeyframe = 0;
  },
  emits: ['update:wavetable'],
  watch: {
    // keyframes: {
    //   deep: true,
    //   handler() {
    //     this.generateAndEmitWavetable();
    //   },
    // },
    // waveWarpKeyframes: {
    //   deep: true,
    //   handler() {
    //     this.generateAndEmitWavetable();
    //   },
    // },
    showEditor: {
      immediate: true,
      handler(newVal) {
        if (newVal) {
          // this.$nextTick(() => {
          //   this.generateAndEmitWavetable();
          // });
        }
      },
    },
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
    resetToSinewave() {
      // Reset to initial single keyframe with pure sine
      this.keyframes = [
        {
          time: 0,
          harmonics: Array.from({ length: this.numHarmonics }, (_, i) => ({
            amplitude: i === 0 ? 1 : 0,
            phase: 0,
          })),
        },
      ];

      // Reset wave warp to initial state
      this.waveWarpKeyframes = [
        {
          time: 0,
          params: {
            xAmount: 0,
            yAmount: 0,
            asymmetric: false,
          },
        },
      ];

      // Reset selection and position states
      this.selectedKeyframe = 0;
      this.selectedWaveWarpKeyframe = 0;
      this.scrubPosition = 0;
      this.morphAmount = 0;
      this.warpMorphAmount = 0;

      // Reset DSP controls
      this.removeDC = false;
      this.normalize = true;
    },
    generateAndEmitWavetable(): void {
      try {
        const wavetable = generateWavetable(
          this.keyframes,
          this.waveWarpKeyframes,
        );
        this.$emit('update:wavetable', wavetable);
      } catch (error) {
        console.error('Error generating wavetable:', error);
      }
    },
    updateMasterScrubPosition(newPosition: number) {
      this.scrubPosition = newPosition;

      // Calculate morphs for both timelines
      this.updateHarmonicMorph(newPosition);
      this.updateWarpMorph(newPosition);
    },
    updateHarmonicMorph(position: number) {
      // Find appropriate keyframe indices and calculate morph
      let currentIndex = 0;
      while (
        currentIndex < this.keyframes.length - 1 &&
        this.keyframes[currentIndex + 1]!.time <= position
      ) {
        currentIndex++;
      }

      if (currentIndex >= this.keyframes.length - 1) {
        this.selectedKeyframe = this.keyframes.length - 1;
        this.morphAmount = 0;
        return;
      }

      const current = this.keyframes[currentIndex];
      const next = this.keyframes[currentIndex + 1];
      const range = next!.time - current!.time;

      if (range === 0) {
        this.morphAmount = 0;
      } else {
        this.morphAmount = (position - current!.time) / range;
      }

      this.selectedKeyframe = currentIndex;
    },
    updateWarpMorph(position: number) {
      // Similar logic for wave warp keyframes
      let currentIndex = 0;
      while (
        currentIndex < this.waveWarpKeyframes.length - 1 &&
        this.waveWarpKeyframes[currentIndex + 1]!.time <= position
      ) {
        currentIndex++;
      }

      if (currentIndex >= this.waveWarpKeyframes.length - 1) {
        this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.length - 1;
        this.warpMorphAmount = 0;
        return;
      }

      const current = this.waveWarpKeyframes[currentIndex];
      const next = this.waveWarpKeyframes[currentIndex + 1];
      const range = next!.time - current!.time;

      if (range === 0) {
        this.warpMorphAmount = 0;
      } else {
        this.warpMorphAmount = (position - current!.time) / range;
      }

      this.selectedWaveWarpKeyframe = currentIndex;
    },
    handleTransitionEnd() {
      // Dialog is fully visible and transition is complete
      this.updateLayouts();
    },
    updateLayouts(): void {
      const refs = this.$refs as unknown as ComponentRefs;
      if (refs.wavetableTimeline) {
        refs.wavetableTimeline.updateTimelineLayout();
      }
      if (refs.waveWarpTimeline) {
        refs.waveWarpTimeline.updateTimelineLayout();
      }
    },
    handlePresetChange(newVal: string) {
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
            harmonics[i]!.amplitude = 1;
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
    updateHarmonics(newHarmonics: Keyframe['harmonics']): void {
      const updatedKeyframes = [...this.keyframes];
      if (this.selectedKeyframe >= 0) {
        updatedKeyframes[this.selectedKeyframe] = {
          ...updatedKeyframes[this.selectedKeyframe]!,
          harmonics: newHarmonics.map((h) => ({ ...h })),
        };
        this.keyframes = updatedKeyframes;
        // this.generateAndEmitWavetable();
      }
    },

    selectKeyframe(index: number): void {
      this.selectedKeyframe = index;
      this.$nextTick(() => {
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
        }
      });
    },
    updateScrubPosition(position: number): void {
      this.scrubPosition = position;
      this.$nextTick(() => {
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
        }
      });
    },
    updateMorphAmount(amount: number): void {
      this.morphAmount = amount;
      this.$nextTick(() => {
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
        }
      });
    },

    selectWaveWarpKeyframe(index: number) {
      this.selectedWaveWarpKeyframe = index;
    },

    updateWaveWarpKeyframes(newKeyframes: WaveWarpKeyframe[]): void {
      this.waveWarpKeyframes = newKeyframes;
      // this.generateAndEmitWavetable();
    },

    updateWarpMorphAmount(amount: number) {
      this.warpMorphAmount = amount;
    },

    addKeyframe(targetTime: number) {
      const current = this.keyframes[this.selectedKeyframe];
      let newTime = targetTime ?? current!.time;

      // Create new keyframe with proper harmonics data
      const newKeyframe = {
        time: newTime,
        harmonics: Array.from({ length: this.numHarmonics }, (_, i) => ({
          amplitude: current!.harmonics[i]?.amplitude || 0,
          phase: current!.harmonics[i]?.phase || 0,
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
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
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
    updateKeyframes(newKeyframes: Keyframe[]): void {
      this.keyframes = newKeyframes;
    },
    sortKeyframes() {
      this.keyframes.sort((a, b) => a.time - b.time);
    },

    async apply() {
      this.isGenerating = true;
      this.generationProgress = 0;

      try {
        // Generate WAV file as ArrayBuffer with progress updates
        const wavBuffer = await exportWavetableToWav(
          this.keyframes,
          this.waveWarpKeyframes,
          256, // numWaveforms
          2048, // sampleLength
          (progress) => {
            console.log('progress', progress);
            this.generationProgress = progress;
          },
        );

        // Convert ArrayBuffer to Uint8Array
        const wavData = new Uint8Array(wavBuffer);

        // Emit the WAV data
        this.$emit('update:wavetable', wavData);
      } catch (error) {
        console.error('Error generating wavetable:', error);
      } finally {
        this.isGenerating = false;
        this.generationProgress = 0;
      }
    },

    cancel() {
      // Just close without generating wavetable
      this.showEditor = false;
    },
  },
};
</script>
