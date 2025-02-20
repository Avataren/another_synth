// WaveformPreview.vue
<template>
  <div class="waveform-preview q-my-md">
    <div class="text-subtitle2">Waveform Preview</div>
    <canvas
      ref="canvas"
      :width="width"
      :height="height"
      style="border: 1px solid #ccc; width: 100%"
    ></canvas>
  </div>
</template>

<script>
import { debounce } from 'lodash';

export default {
  name: 'WaveformPreview',
  props: {
    width: {
      type: Number,
      required: true,
    },
    height: {
      type: Number,
      required: true,
    },
    keyframes: {
      type: Array,
      required: true,
    },
    selectedKeyframe: {
      type: Number,
      required: true,
    },
    morphAmount: {
      type: Number,
      required: true,
    },
    waveWarpKeyframes: {
      type: Array,
      required: true,
    },
    selectedWaveWarpKeyframe: {
      type: Number,
      required: true,
    },
    warpMorphAmount: {
      type: Number,
      required: true,
    },
    removeDC: {
      type: Boolean,
      required: true,
    },
    normalize: {
      type: Boolean,
      required: true,
    },
  },

  data() {
    return {
      fftSize: 1024,
      isUpdating: false,
      rafId: null,
      lastDrawnState: null,
    };
  },

  created() {
    // Create debounced update function
    this.debouncedUpdate = debounce(this.performUpdate, 16); // ~60fps
  },
  mounted() {
    this.scheduleUpdate(); // Schedule initial waveform update
  },
  beforeUnmount() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
    window.removeEventListener('resize');
  },

  watch: {
    keyframes: {
      handler() {
        this.scheduleUpdate();
      },
      deep: true,
    },
    selectedKeyframe() {
      this.scheduleUpdate();
    },
    morphAmount() {
      this.scheduleUpdate();
    },
    waveWarpKeyframes: {
      handler() {
        this.scheduleUpdate();
      },
      deep: true,
    },
    selectedWaveWarpKeyframe() {
      this.scheduleUpdate();
    },
    warpMorphAmount() {
      this.scheduleUpdate();
    },
    removeDC() {
      this.scheduleUpdate();
    },
    normalize() {
      this.scheduleUpdate();
    },
  },

  methods: {
    scheduleUpdate() {
      this.debouncedUpdate();
    },

    performUpdate() {
      if (this.isUpdating || !this.keyframes.length) return;

      // Check if state has actually changed
      const currentState = this.getStateSnapshot();
      if (this.statesAreEqual(currentState, this.lastDrawnState)) {
        return;
      }

      this.isUpdating = true;
      this.rafId = requestAnimationFrame(() => {
        this.generateAndDrawWaveform();
        this.isUpdating = false;
        this.lastDrawnState = currentState;
      });
    },

    getStateSnapshot() {
      const currentKeyframe = this.keyframes[this.selectedKeyframe];
      return {
        harmonics: currentKeyframe?.harmonics.map((h) => ({ ...h })),
        morphAmount: this.morphAmount,
        warpParams: {
          ...this.waveWarpKeyframes[this.selectedWaveWarpKeyframe]?.params,
        },
        warpMorphAmount: this.warpMorphAmount,
        removeDC: this.removeDC,
        normalize: this.normalize,
      };
    },

    statesAreEqual(state1, state2) {
      if (!state1 || !state2) return false;
      return JSON.stringify(state1) === JSON.stringify(state2);
    },

    generateAndDrawWaveform() {
      if (!this.keyframes.length || !this.waveWarpKeyframes.length) return;

      const currentKeyframe = this.keyframes[this.selectedKeyframe];
      let interpolatedHarmonics = [...currentKeyframe.harmonics];

      // Interpolate between harmonics keyframes
      if (
        this.morphAmount > 0 &&
        this.selectedKeyframe < this.keyframes.length - 1
      ) {
        const nextKeyframe = this.keyframes[this.selectedKeyframe + 1];
        interpolatedHarmonics = this.interpolateHarmonics(
          currentKeyframe.harmonics,
          nextKeyframe.harmonics,
          this.morphAmount,
        );
      }

      // Get current wave warp parameters
      const currentWarpKeyframe =
        this.waveWarpKeyframes[this.selectedWaveWarpKeyframe];
      let warpParams = { ...currentWarpKeyframe.params };

      // Interpolate between wave warp keyframes
      if (
        this.warpMorphAmount > 0 &&
        this.selectedWaveWarpKeyframe < this.waveWarpKeyframes.length - 1
      ) {
        const nextWarpKeyframe =
          this.waveWarpKeyframes[this.selectedWaveWarpKeyframe + 1];
        warpParams = this.interpolateWarpParams(
          currentWarpKeyframe.params,
          nextWarpKeyframe.params,
          this.warpMorphAmount,
        );
      }

      // Generate base waveform
      const baseWaveform = this.generateWaveform(interpolatedHarmonics);

      // Apply wave warping
      const warpedWaveform = this.applyWaveWarp(baseWaveform, warpParams);

      // Apply additional processing
      const processedWaveform = this.processWaveform(warpedWaveform);

      // Draw the result
      this.drawWaveform(processedWaveform);
    },

    interpolateHarmonics(current, next, amount) {
      return current.map((harmonic, index) => ({
        amplitude:
          harmonic.amplitude * (1 - amount) + next[index].amplitude * amount,
        phase: harmonic.phase * (1 - amount) + next[index].phase * amount,
      }));
    },

    generateWaveform(harmonics) {
      // Use TypedArrays for better performance
      const waveform = new Float64Array(this.fftSize);
      const twoPi = 2 * Math.PI;

      // Pre-calculate phase values
      const phaseMultipliers = new Float64Array(harmonics.length);
      for (let h = 0; h < harmonics.length; h++) {
        phaseMultipliers[h] = (twoPi * (h + 1)) / this.fftSize;
      }

      // Generate waveform
      for (let i = 0; i < this.fftSize; i++) {
        let sample = 0;
        for (let h = 0; h < harmonics.length; h++) {
          const { amplitude, phase } = harmonics[h];
          sample += amplitude * Math.sin(phaseMultipliers[h] * i + phase);
        }
        waveform[i] = sample;
      }

      return waveform;
    },

    interpolateWarpParams(current, next, amount) {
      return {
        xAmount: current.xAmount * (1 - amount) + next.xAmount * amount,
        yAmount: current.yAmount * (1 - amount) + next.yAmount * amount,
        asymmetric: amount < 0.5 ? current.asymmetric : next.asymmetric,
      };
    },

    applyWaveWarp(waveform, params) {
      if (params.xAmount === 0 && params.yAmount === 0) return waveform;

      const warped = new Float64Array(waveform.length);
      const N = waveform.length;
      const xExp = 1 + params.xAmount * 0.2;
      const yExp = 1 + params.yAmount * 0.2;

      for (let i = 0; i < N; i++) {
        const normalizedPos = (i / N) * 2 - 1;
        let xPos = normalizedPos;

        // Apply X warping
        if (params.xAmount !== 0) {
          if (params.asymmetric) {
            xPos =
              normalizedPos >= 0
                ? Math.pow(normalizedPos, xExp)
                : -Math.pow(-normalizedPos, xExp);
          } else {
            xPos =
              Math.sign(normalizedPos) *
              Math.pow(Math.abs(normalizedPos), xExp);
          }
        }

        // Convert back to sample position
        const samplePos = (xPos + 1) * 0.5 * (N - 1);
        const index1 = Math.floor(samplePos);
        const index2 = Math.min(index1 + 1, N - 1);
        const frac = samplePos - index1;

        // Linear interpolation
        let sample = waveform[index1] * (1 - frac) + waveform[index2] * frac;

        // Apply Y warping
        if (params.yAmount !== 0) {
          if (params.asymmetric) {
            sample =
              sample >= 0 ? Math.pow(sample, yExp) : -Math.pow(-sample, yExp);
          } else {
            sample = Math.sign(sample) * Math.pow(Math.abs(sample), yExp);
          }
        }

        warped[i] = sample;
      }

      return warped;
    },

    processWaveform(waveform) {
      const processed = new Float64Array(waveform);

      if (this.removeDC || this.normalize) {
        let sum = 0,
          max = 0;

        // Single pass for both operations
        for (let i = 0; i < processed.length; i++) {
          const sample = processed[i];
          if (this.removeDC) sum += sample;
          if (this.normalize) {
            const absVal = Math.abs(sample);
            if (absVal > max) max = absVal;
          }
        }

        if (this.removeDC) {
          const mean = sum / processed.length;
          for (let i = 0; i < processed.length; i++) {
            processed[i] -= mean;
          }
        }

        if (this.normalize && max > 0) {
          const scale = 1 / max;
          for (let i = 0; i < processed.length; i++) {
            processed[i] *= scale;
          }
        }
      }

      return processed;
    },

    drawWaveform(waveform) {
      const canvas = this.$refs.canvas;
      if (!canvas) return;

      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      const scale = height / 2;

      ctx.clearRect(0, 0, width, height);

      // Draw center line
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Draw waveform
      ctx.beginPath();
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;

      // Calculate step size for smoother rendering
      const step = Math.max(1, Math.floor(waveform.length / width));

      for (let i = 0; i < waveform.length; i += step) {
        const x = (i / waveform.length) * width;
        const y = height / 2 - waveform[i] * scale;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      ctx.stroke();
    },
  },
};
</script>
