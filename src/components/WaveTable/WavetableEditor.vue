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
          <!-- Header row with title and new dropdown for numHarmonics -->
          <div class="row items-center q-gutter-md">
            <div class="col-auto">
              <div class="text-h4">Wavetable Editor</div>
            </div>
            <div class="col-auto">
              <q-select
                filled
                v-model="selectedNumHarmonics"
                :options="numHarmonicsOptions"
                label="Number of Harmonics"
                emit-value
                map-options
              />
            </div>
          </div>

          <!-- Harmonics Editor Component -->
          <HarmonicsEditor
            :key="currentKeyframe.harmonics.length"
            :harmonics="currentKeyframe.harmonics"
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
      selectedNumHarmonics: this.numHarmonics,
      numHarmonicsOptions: [
        { label: '16', value: 16 },
        { label: '32', value: 32 },
        { label: '64', value: 64 },
        { label: '128', value: 128 },
        { label: '256', value: 256 },
        { label: '512', value: 512 },
        { label: '1024', value: 1024 },
        { label: '2048', value: 2048 },
      ],
      showEditor: false,
      keyframes: [] as Keyframe[],
      waveWarpKeyframes: [] as WaveWarpKeyframe[],
      selectedKeyframe: 0,
      selectedPreset: 'custom',
      presetOptions: [
        { label: 'Sine', value: 'sine' },
        { label: 'Harmonic Series', value: 'harmonicSeries' },
        { label: 'Square Wave', value: 'square' },
        { label: 'Sawtooth Wave', value: 'sawtooth' },
        { label: 'Triangle Wave', value: 'triangle' },
        { label: 'Bright Brass', value: 'brightBrass' },
        { label: 'Warm Pad', value: 'warmPad' },
        { label: 'Vocal Formant', value: 'vocalFormant' },
        { label: 'Metallic Bell', value: 'metallicBell' },
        { label: 'Evolving Texture', value: 'evolvingTexture' },
      ],
      removeDC: true,
      normalize: true,
      phaseMin: -Math.PI,
      phaseMax: Math.PI,
      scrubPosition: 0,
      morphAmount: 0,
      selectedWaveWarpKeyframe: 0,
      warpMorphAmount: 0,
      waveWarpTypes: ['pow', 'sine', 'asym', 'bend'],
      generationProgress: 0,
      isGenerating: false,
      rafScheduled: false,
    };
  },
  ref() {
    return {
      waveformPreview: null as typeof WaveformPreview | null,
      wavetableTimeline: null as typeof WavetableTimeline | null,
      waveWarpTimeline: null as typeof WaveWarpTimeline | null,
    };
  },
  computed: {
    currentKeyframe(): Keyframe {
      return this.keyframes[this.selectedKeyframe]!;
    },
  },
  mounted() {
    // Initialize keyframes with a sine wave
    this.resetToSinewave();
    this.selectedWaveWarpKeyframe = 0;

    // Give time for child components to mount
    this.$nextTick(() => {
      const refs = this.$refs as unknown as ComponentRefs;
      if (refs.waveformPreview) {
        refs.waveformPreview.scheduleUpdate();
      }
    });
  },
  emits: ['update:wavetable'],
  watch: {
    selectedNumHarmonics(newVal: number) {
      this.resampleKeyframes(newVal);
      this.$nextTick(() => {
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
        }
      });
    },
    showEditor: {
      immediate: true,
      handler(newVal) {
        if (newVal) {
          // Optionally trigger waveform generation here
        }
      },
    },
    selectedKeyframe: {
      handler(newVal) {
        if (newVal >= 0 && newVal < this.keyframes.length) {
          const currentKeyframe = this.keyframes[newVal]!;
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
    // Resample each keyframe's harmonics array with a plain loop for better performance.
    resampleKeyframes(newLengthRaw: number | string) {
      const newLength = Number(newLengthRaw);
      this.keyframes = this.keyframes.map((kf, idx) => {
        const oldHarmonics = Array.isArray(kf.harmonics) ? kf.harmonics : [];
        const oldLength = oldHarmonics.length;
        if (oldLength === 0) {
          console.warn(
            '[Parent] Keyframe at index ' +
              idx +
              ' is empty. Re-initializing...',
          );
          const newHarmonics = new Array(newLength);
          for (let i = 0; i < newLength; i++) {
            newHarmonics[i] = { amplitude: i === 0 ? 1 : 0, phase: 0 };
          }
          return { time: kf.time ?? 0, harmonics: newHarmonics };
        }
        if (oldLength === newLength) return kf;
        const newHarmonics = new Array(newLength);
        for (let i = 0; i < newLength; i++) {
          if (i < oldLength) {
            const oldH = oldHarmonics[i]!;
            newHarmonics[i] = {
              amplitude: oldH.amplitude ?? 0,
              phase: oldH.phase ?? 0,
            };
          } else {
            newHarmonics[i] = { amplitude: 0, phase: 0 };
          }
        }
        return { time: kf.time, harmonics: newHarmonics };
      });
    },
    resetToSinewave() {
      this.keyframes = [
        {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => ({
              amplitude: i === 0 ? 1 : 0,
              phase: 0,
            }),
          ),
        },
      ];
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
      this.scrubPosition = 0;
      this.morphAmount = 0;
      this.warpMorphAmount = 0;
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
      this.updateHarmonicMorph(newPosition);
      this.updateWarpMorph(newPosition);
    },
    // Use binary search for fast lookup during scrubbing
    updateHarmonicMorph(position: number) {
      let low = 0;
      let high = this.keyframes.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (this.keyframes[mid]!.time <= position) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const currentIndex = Math.max(0, high);
      if (currentIndex >= this.keyframes.length - 1) {
        this.selectedKeyframe = this.keyframes.length - 1;
        this.morphAmount = 0;
        return;
      }
      const current = this.keyframes[currentIndex]!;
      const next = this.keyframes[currentIndex + 1]!;
      const range = next.time - current.time;
      this.morphAmount = range === 0 ? 0 : (position - current.time) / range;
      this.selectedKeyframe = currentIndex;
    },
    updateWarpMorph(position: number) {
      let low = 0;
      let high = this.waveWarpKeyframes.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (this.waveWarpKeyframes[mid]!.time <= position) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const currentIndex = Math.max(0, high);
      if (currentIndex >= this.waveWarpKeyframes.length - 1) {
        this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.length - 1;
        this.warpMorphAmount = 0;
        return;
      }
      const current = this.waveWarpKeyframes[currentIndex]!;
      const next = this.waveWarpKeyframes[currentIndex + 1]!;
      const range = next.time - current.time;
      this.warpMorphAmount =
        range === 0 ? 0 : (position - current.time) / range;
      this.selectedWaveWarpKeyframe = currentIndex;
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
    handleTransitionEnd() {
      this.updateLayouts();
    },
    handlePresetChange(newVal: string) {
      if (newVal === 'sine') {
        this.keyframes = [
          {
            time: 0,
            harmonics: Array.from(
              { length: this.selectedNumHarmonics },
              (_, i) => ({
                amplitude: i === 0 ? 1 : 0,
                phase: 0,
              }),
            ),
          },
        ];
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'harmonicSeries') {
        const totalKeyframes = 8;
        const newKeyframes = [];
        for (let i = 0; i < totalKeyframes; i++) {
          const time = (i / (totalKeyframes - 1)) * 100;
          const harmonics = Array.from(
            { length: this.selectedNumHarmonics },
            () => ({
              amplitude: 0,
              phase: 0,
            }),
          );
          if (i < this.selectedNumHarmonics) {
            harmonics[i]!.amplitude = 1;
          }
          newKeyframes.push({ time, harmonics });
        }
        this.keyframes = newKeyframes;
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'square') {
        const keyframe = {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              const n = i + 1;
              return {
                amplitude: n % 2 === 1 ? 1 / n : 0,
                phase: 0,
              };
            },
          ),
        };
        this.keyframes = [keyframe];
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'sawtooth') {
        const keyframe = {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              const n = i + 1;
              return {
                amplitude: 1 / n,
                phase: n % 2 === 0 ? Math.PI : 0,
              };
            },
          ),
        };
        this.keyframes = [keyframe];
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'triangle') {
        const keyframe = {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              const n = i + 1;
              if (n % 2 === 1) {
                return {
                  amplitude: 1 / (n * n),
                  phase: n % 4 === 1 ? 0 : Math.PI,
                };
              } else {
                return { amplitude: 0, phase: 0 };
              }
            },
          ),
        };
        this.keyframes = [keyframe];
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'brightBrass') {
        const keyframe = {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              if (i === 0) {
                return { amplitude: 0.5, phase: 0 };
              } else if (i >= 1 && i <= 4) {
                return { amplitude: 1.0, phase: 0 };
              } else {
                return { amplitude: 0.5 / (i + 1), phase: 0 };
              }
            },
          ),
        };
        this.keyframes = [keyframe];
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'warmPad') {
        const totalKeyframes = 8;
        const newKeyframes = [];
        for (let i = 0; i < totalKeyframes; i++) {
          const time = (i / (totalKeyframes - 1)) * 100;
          const t = i / (totalKeyframes - 1);
          const harmonics = Array.from(
            { length: this.selectedNumHarmonics },
            (_, j) => {
              if (j === 0) {
                return { amplitude: 1, phase: 0 };
              } else {
                const target = 1 / (j + 1);
                return { amplitude: t * target, phase: 0 };
              }
            },
          );
          newKeyframes.push({ time, harmonics });
        }
        this.keyframes = newKeyframes;
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'vocalFormant') {
        const keyframes = [];
        keyframes.push({
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              if (i === 0 || i === 1) {
                return { amplitude: 1, phase: 0 };
              } else if (i === 2 || i === 3) {
                return { amplitude: 0.5, phase: 0 };
              } else {
                return { amplitude: 0, phase: 0 };
              }
            },
          ),
        });
        keyframes.push({
          time: 50,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              if (i === 1 || i === 2) {
                return { amplitude: 1, phase: 0 };
              } else if (i === 0 || i === 3) {
                return { amplitude: 0.5, phase: 0 };
              } else {
                return { amplitude: 0, phase: 0 };
              }
            },
          ),
        });
        keyframes.push({
          time: 100,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              if (i === 2 || i === 3) {
                return { amplitude: 1, phase: 0 };
              } else if (i === 1 || i === 4) {
                return { amplitude: 0.5, phase: 0 };
              } else {
                return { amplitude: 0, phase: 0 };
              }
            },
          ),
        });
        this.keyframes = keyframes;
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'metallicBell') {
        const keyframe = {
          time: 0,
          harmonics: Array.from(
            { length: this.selectedNumHarmonics },
            (_, i) => {
              const n = i + 1;
              return {
                amplitude: 1 / n,
                phase: Math.sin(i * 2.3) * 0.3,
              };
            },
          ),
        };
        this.keyframes = [keyframe];
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      } else if (newVal === 'evolvingTexture') {
        const totalKeyframes = 8;
        const newKeyframes = [];
        for (let i = 0; i < totalKeyframes; i++) {
          const time = (i / (totalKeyframes - 1)) * 100;
          const harmonics = Array.from(
            { length: this.selectedNumHarmonics },
            (_, j) => ({
              amplitude:
                0.5 +
                0.5 *
                  Math.sin(
                    2 *
                      Math.PI *
                      (i / totalKeyframes + j / this.selectedNumHarmonics),
                  ),
              phase: 0,
            }),
          );
          newKeyframes.push({ time, harmonics });
        }
        this.keyframes = newKeyframes;
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
        this.scrubPosition = 0;
        this.selectedKeyframe = 0;
      }
      // After applying a preset, update layouts and reset the preset selector.

      this.selectedPreset = 'custom';
    },
    updateHarmonics(newHarmonics: Keyframe['harmonics']): void {
      const updatedKeyframes = [...this.keyframes];
      if (this.selectedKeyframe >= 0) {
        const currentKeyframe = updatedKeyframes[this.selectedKeyframe]!;
        updatedKeyframes[this.selectedKeyframe] = {
          time: currentKeyframe.time!,
          harmonics: newHarmonics.map((h) => ({ ...h })),
        };
        this.keyframes = updatedKeyframes;
      }
    },
    selectKeyframe(index: number): void {
      this.selectedKeyframe = index;
      this.$nextTick(this.updatePreview);
    },
    updateScrubPosition(position: number): void {
      this.scrubPosition = position;
      this.$nextTick(this.updatePreview);
    },
    updateMorphAmount(amount: number): void {
      this.morphAmount = amount;
      this.$nextTick(this.updatePreview);
    },
    selectWaveWarpKeyframe(index: number) {
      this.selectedWaveWarpKeyframe = index;
    },
    updateWaveWarpKeyframes(newKeyframes: WaveWarpKeyframe[]): void {
      this.waveWarpKeyframes = newKeyframes;
    },
    updateWarpMorphAmount(amount: number) {
      this.warpMorphAmount = amount;
    },
    addKeyframe(targetTime: number) {
      const current = this.keyframes[this.selectedKeyframe]!;
      const newTime = targetTime || current.time!;
      const newKeyframe = {
        time: newTime,
        harmonics: new Array(this.selectedNumHarmonics),
      };
      for (let i = 0; i < this.selectedNumHarmonics; i++) {
        newKeyframe.harmonics[i] = {
          amplitude: current.harmonics[i]?.amplitude || 0,
          phase: current.harmonics[i]?.phase || 0,
        };
      }
      const updatedKeyframes = [...this.keyframes, newKeyframe].sort(
        (a, b) => a.time - b.time,
      );
      this.keyframes = updatedKeyframes;
      const newIndex = updatedKeyframes.findIndex((kf) => kf.time === newTime);
      this.selectedKeyframe = newIndex;
      this.morphAmount = 0;
      this.scrubPosition = newTime;
      this.$nextTick(this.updatePreview);
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
        const wavBuffer = await exportWavetableToWav(
          this.keyframes,
          this.waveWarpKeyframes,
          256,
          2048,
          this.removeDC,
          this.normalize,
          (progress) => {
            this.generationProgress = progress;
          },
        );
        const wavData = new Uint8Array(wavBuffer);
        this.$emit('update:wavetable', wavData);
      } catch (error) {
        console.error('Error generating wavetable:', error);
      } finally {
        this.isGenerating = false;
        this.generationProgress = 0;
      }
    },
    cancel() {
      this.showEditor = false;
    },
    // Throttle waveform preview updates using requestAnimationFrame.
    updatePreview() {
      if (this.rafScheduled) return;
      this.rafScheduled = true;
      requestAnimationFrame(() => {
        this.rafScheduled = false;
        const refs = this.$refs as unknown as ComponentRefs;
        if (refs.waveformPreview) {
          refs.waveformPreview.updateWaveformPreview();
        }
      });
    },
  },
};
</script>
