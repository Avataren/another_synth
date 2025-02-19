<template>
  <div class="q-pa-md">
    <!-- Button to open the wavetable editor -->
    <q-btn
      label="Open Wavetable Editor"
      color="primary"
      @click="showEditor = true"
    />

    <q-dialog v-model="showEditor" persistent>
      <q-card style="min-width: 1250px; max-height: 90vh; overflow-y: auto">
        <q-card-section>
          <div class="text-h6">Wavetable Editor</div>
          <div class="text-subtitle2 q-mb-md">
            Adjust amplitude &amp; phase for each harmonic. Morph between
            keyframes, remove DC, normalize, etc.
          </div>

          <!-- Harmonic sliders (Amplitude & Phase) -->
          <div
            v-if="keyframes[selectedKeyframe]"
            class="current-harmonics q-my-md"
          >
            <div class="row items-center">
              <div class="text-subtitle2" style="width: 120px">
                Time: {{ keyframes[selectedKeyframe].time.toFixed(1) }}%
              </div>
              <div
                class="vertical-sliders"
                style="flex: 1; overflow-x: auto; white-space: nowrap"
              >
                <div
                  v-for="(harmonic, hIndex) in keyframes[selectedKeyframe]
                    .harmonics"
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
                    v-model="harmonic.amplitude"
                    vertical
                    reverse
                    :min="0"
                    :max="1"
                    :step="0.01"
                    color="primary"
                    style="height: 60px"
                  />
                  <!-- Phase slider -->
                  <q-slider
                    v-model="harmonic.phase"
                    vertical
                    reverse
                    :min="phaseMin"
                    :max="phaseMax"
                    :step="0.01"
                    color="accent"
                    style="height: 60px"
                  />
                  <div style="font-size: 10px">H{{ hIndex + 1 }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Preset Selection -->
          <div class="q-my-md">
            <q-select
              v-model="selectedPreset"
              label="Preset"
              :options="presetOptions"
              option-value="value"
              option-label="label"
              emit-value
              @update:model-value="handlePresetChange"
              clearable
            />
          </div>

          <!-- Waveform preview -->
          <div class="waveform-preview q-my-md">
            <div class="text-subtitle2">Waveform Preview</div>
            <canvas
              ref="waveformCanvas"
              :width="canvasWidth"
              :height="canvasHeight"
              style="border: 1px solid #ccc; width: 100%"
            ></canvas>
          </div>

          <!-- Keyframe management buttons -->
          <div class="q-my-md row items-center justify-between">
            <div>
              <q-btn
                label="Add Keyframe"
                color="primary"
                flat
                @click="addKeyframe"
              />
              <q-btn
                label="Remove Keyframe"
                color="negative"
                flat
                @click="removeKeyframe"
                :disable="keyframes.length <= 1"
              />
            </div>

            <!-- Example DSP toggles & button -->
            <div class="row items-center">
              <q-toggle v-model="removeDC" label="Remove DC" class="q-mr-md" />
              <q-toggle v-model="normalize" label="Normalize" class="q-mr-md" />
              <q-btn
                label="Add Asymm"
                color="secondary"
                flat
                @click="addAsymm"
              />
            </div>
          </div>

          <!-- Morph slider -->
          <div class="q-my-md">
            <div class="text-subtitle2">
              Morph (between current &amp; next keyframe)
            </div>
            <q-slider
              v-model="morphPosition"
              :min="0"
              :max="1"
              :step="0.01"
              style="width: 300px"
              label-always
            />
          </div>

          <!-- Timeline -->
          <div class="timeline" ref="timeline" @click="onTimelineClick($event)">
            <div class="timeline-bar"></div>
            <div
              v-for="(keyframe, index) in keyframes"
              :key="index"
              class="keyframe-marker"
              :class="{ selected: index === selectedKeyframe }"
              :style="getMarkerStyle(keyframe.time)"
              @mousedown.stop="startDrag($event, index)"
              @click.stop="selectKeyframe(index)"
            >
              <q-icon
                name="fiber_manual_record"
                size="24px"
                :color="index === selectedKeyframe ? 'red' : 'blue'"
              />
            </div>
          </div>
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
export default {
  name: 'WavetableEditor',
  props: {
    numHarmonics: {
      type: Number,
      default: 32,
    },
  },
  data() {
    return {
      showEditor: false,
      keyframes: [],
      selectedKeyframe: 0,
      isDragging: false,
      dragIndex: null,
      timelineRect: null,
      // For preview
      fftSize: 1024,
      canvasWidth: 1024,
      canvasHeight: 200,
      // Preset selection
      selectedPreset: 'custom',
      presetOptions: [
        { label: 'Custom', value: 'custom' },
        { label: 'Harmonic Series', value: 'harmonicSeries' },
      ],
      // Extra DSP / advanced controls
      morphPosition: 0, // 0..1 morph between current and next keyframe
      removeDC: false,
      normalize: false,
      phaseMin: -Math.PI,
      phaseMax: Math.PI,
    };
  },
  mounted() {
    // Start with a single keyframe at time 0
    // Each harmonic has amplitude & phase
    this.keyframes = [
      {
        time: 0,
        harmonics: Array.from({ length: this.numHarmonics }, (_, i) => ({
          amplitude: i === 0 ? 1 : 0,
          phase: 0,
        })),
      },
    ];
    this.selectedKeyframe = 0;
  },
  watch: {
    showEditor(newVal) {
      if (newVal) {
        this.$nextTick(() => {
          if (this.$refs.timeline) {
            this.timelineRect = this.$refs.timeline.getBoundingClientRect();
          }
          this.updateWaveformPreview();
        });
      }
    },
    keyframes: {
      handler() {
        this.updateWaveformPreview();
      },
      deep: true,
    },
    selectedKeyframe() {
      this.updateWaveformPreview();
      // Reset morphPosition whenever we select a new keyframe
      this.morphPosition = 0;
    },
    morphPosition() {
      this.updateWaveformPreview();
    },
    removeDC() {
      this.updateWaveformPreview();
    },
    normalize() {
      this.updateWaveformPreview();
    },
    selectedPreset(newVal) {
      if (newVal === 'harmonicSeries') {
        this.applyHarmonicSeriesPreset();
        this.selectedPreset = 'custom';
      }
    },
  },
  methods: {
    handlePresetChange(_newPreset) {
      // Called by QSelect; logic is handled in the watcher
    },

    /**
     * Updated: Only the nth harmonic is active for each successive keyframe.
     * With 8 total keyframes, keyframe 0 -> partial #1, keyframe 1 -> partial #2, etc.
     */
    applyHarmonicSeriesPreset() {
      const totalKeyframes = 8;
      const newKeyframes = [];

      for (let i = 0; i < totalKeyframes; i++) {
        const time = (i / (totalKeyframes - 1)) * 100;
        // Initialize all partials to 0 amplitude
        const harmonics = Array.from({ length: this.numHarmonics }, () => ({
          amplitude: 0,
          phase: 0,
        }));
        // Turn on just the i-th partial (if within bounds)
        if (i < this.numHarmonics) {
          harmonics[i].amplitude = 1;
        }
        newKeyframes.push({ time, harmonics });
      }

      this.keyframes = newKeyframes;
      this.selectedKeyframe = 0;
      this.updateWaveformPreview();
    },

    cancel() {
      this.showEditor = false;
    },
    apply() {
      console.log('Applied Keyframes:', this.keyframes);
      this.showEditor = false;
    },
    selectKeyframe(index) {
      this.selectedKeyframe = index;
    },
    addKeyframe() {
      const current = this.keyframes[this.selectedKeyframe];
      let newTime = current.time;
      if (this.selectedKeyframe < this.keyframes.length - 1) {
        const next = this.keyframes[this.selectedKeyframe + 1];
        newTime = (current.time + next.time) / 2;
      }
      const newKeyframe = {
        time: newTime,
        harmonics: current.harmonics.map((h) => ({
          amplitude: h.amplitude,
          phase: h.phase,
        })),
      };
      this.keyframes.push(newKeyframe);
      this.sortKeyframes();
      this.selectedKeyframe = this.keyframes.findIndex(
        (kf) => kf === newKeyframe,
      );
    },
    removeKeyframe() {
      if (this.keyframes.length > 1 && this.selectedKeyframe !== null) {
        this.keyframes.splice(this.selectedKeyframe, 1);
        if (this.selectedKeyframe >= this.keyframes.length) {
          this.selectedKeyframe = this.keyframes.length - 1;
        }
      }
    },
    onTimelineClick(event) {
      if (!this.$refs.timeline) return;
      const rect = this.$refs.timeline.getBoundingClientRect();
      this.timelineRect = rect;
      const clickX = event.clientX - rect.left;
      const availableWidth = rect.width - 40; // account for padding
      let percentage = ((clickX - 20) / availableWidth) * 100;
      percentage = Math.max(0, Math.min(percentage, 100));
      // Clone the current keyframe's harmonics
      const newKeyframe = {
        time: percentage,
        harmonics: this.keyframes[this.selectedKeyframe].harmonics.map((h) => ({
          amplitude: h.amplitude,
          phase: h.phase,
        })),
      };
      this.keyframes.push(newKeyframe);
      this.sortKeyframes();
      this.selectedKeyframe = this.keyframes.findIndex(
        (kf) => kf === newKeyframe,
      );
    },
    startDrag(event, index) {
      this.isDragging = true;
      this.dragIndex = index;
      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
      document.addEventListener('mousemove', this.onDrag);
      document.addEventListener('mouseup', this.stopDrag);
    },
    onDrag(event) {
      if (!this.isDragging || this.dragIndex === null || !this.timelineRect)
        return;
      const availableWidth = this.timelineRect.width - 40;
      let x = event.clientX - this.timelineRect.left;
      x = Math.max(20, Math.min(x, this.timelineRect.width - 20));
      let percentage = ((x - 20) / availableWidth) * 100;
      const draggedKeyframe = this.keyframes[this.dragIndex];
      draggedKeyframe.time = percentage;
      this.sortKeyframes();
      this.selectedKeyframe = this.keyframes.findIndex(
        (kf) => kf === draggedKeyframe,
      );
    },
    stopDrag() {
      this.isDragging = false;
      this.dragIndex = null;
      document.removeEventListener('mousemove', this.onDrag);
      document.removeEventListener('mouseup', this.stopDrag);
    },
    sortKeyframes() {
      this.keyframes.sort((a, b) => a.time - b.time);
    },
    getMarkerStyle(time) {
      if (!this.timelineRect) return { left: time + '%' };
      const availableWidth = this.timelineRect.width - 40;
      let leftPx = (time / 100) * availableWidth + 20;
      return { left: leftPx + 'px' };
    },

    // Example "Add Asymm" function: shifts phase of each harmonic
    addAsymm() {
      const current = this.keyframes[this.selectedKeyframe];
      if (!current) return;
      current.harmonics.forEach((h, i) => {
        // Shift phase by a function of i (example)
        h.phase += i * 0.1;
      });
      this.updateWaveformPreview();
    },

    updateWaveformPreview() {
      // Guard: Ensure we have at least one keyframe and a valid selected index
      if (
        !this.keyframes.length ||
        this.selectedKeyframe < 0 ||
        this.selectedKeyframe >= this.keyframes.length
      ) {
        console.warn(
          'updateWaveformPreview: Invalid selectedKeyframe index:',
          this.selectedKeyframe,
        );
        return;
      }

      // Determine the "morphed" harmonics
      let currentHarmonics = this.keyframes[this.selectedKeyframe].harmonics;
      if (
        this.selectedKeyframe < this.keyframes.length - 1 &&
        this.morphPosition > 0
      ) {
        // Interpolate between current keyframe and the next
        const nextHarmonics =
          this.keyframes[this.selectedKeyframe + 1].harmonics;
        currentHarmonics = currentHarmonics.map((h, i) => {
          const amp =
            h.amplitude * (1 - this.morphPosition) +
            nextHarmonics[i].amplitude * this.morphPosition;
          const ph =
            h.phase * (1 - this.morphPosition) +
            nextHarmonics[i].phase * this.morphPosition;
          return { amplitude: amp, phase: ph };
        });
      }

      // Sum partials into a buffer
      const N = this.fftSize;
      const waveform = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let sample = 0;
        // k in [1..numHarmonics] matches array indices [0..numHarmonics-1]
        for (let k = 1; k <= currentHarmonics.length; k++) {
          const { amplitude, phase } = currentHarmonics[k - 1];
          sample += amplitude * Math.cos((2 * Math.PI * k * i) / N + phase);
        }
        waveform[i] = sample;
      }

      // Optionally remove DC offset
      if (this.removeDC) {
        this.removeDCOffset(waveform);
      }
      // Optionally normalize
      if (this.normalize) {
        this.normalizeWaveform(waveform);
      }

      // Draw the waveform
      this.drawWaveform(waveform);
    },

    removeDCOffset(waveform) {
      const avg = waveform.reduce((sum, val) => sum + val, 0) / waveform.length;
      for (let i = 0; i < waveform.length; i++) {
        waveform[i] -= avg;
      }
    },
    normalizeWaveform(waveform) {
      let maxVal = 0;
      for (let i = 0; i < waveform.length; i++) {
        const absVal = Math.abs(waveform[i]);
        if (absVal > maxVal) maxVal = absVal;
      }
      if (maxVal > 0) {
        for (let i = 0; i < waveform.length; i++) {
          waveform[i] /= maxVal;
        }
      }
    },

    drawWaveform(waveform) {
      const canvas = this.$refs.waveformCanvas;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);
      ctx.beginPath();
      const scale = height / 2;

      for (let i = 0; i < waveform.length; i++) {
        const x = (i / (waveform.length - 1)) * width;
        const y = height / 2 - waveform[i] * scale;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.stroke();
    },
  },
};
</script>

<style scoped>
.timeline {
  position: relative;
  height: 50px;
  background: #e0e0e0;
  margin: 20px;
  padding: 0 20px;
  cursor: pointer;
  border: 1px solid #ccc;
  border-radius: 4px;
  box-sizing: border-box;
}
.timeline-bar {
  position: absolute;
  top: 50%;
  left: 20px;
  right: 20px;
  height: 4px;
  background: #ccc;
  transform: translateY(-50%);
}
.keyframe-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
}
.keyframe-marker.selected {
  /* Additional styling for the selected marker if desired */
}
</style>
