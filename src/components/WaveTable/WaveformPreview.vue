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
    };
  },

  watch: {
    keyframes: {
      handler() {
        this.updateWaveformPreview();
      },
      deep: true,
      immediate: true,
    },
    selectedKeyframe() {
      this.updateWaveformPreview();
    },
    morphAmount: {
      handler() {
        this.updateWaveformPreview();
      },
      immediate: true,
    },
    waveWarpKeyframes: {
      handler() {
        this.updateWaveformPreview();
      },
      deep: true,
    },
    selectedWaveWarpKeyframe() {
      this.updateWaveformPreview();
    },
    warpMorphAmount: {
      handler() {
        this.updateWaveformPreview();
      },
      immediate: true,
    },
    removeDC() {
      this.updateWaveformPreview();
    },
    normalize() {
      this.updateWaveformPreview();
    },
    scrubPosition: {
      handler() {
        this.updateWaveformPreview();
      },
      immediate: true,
    },
  },

  mounted() {
    this.updateWaveformPreview();
  },

  methods: {
    updateWaveformPreview() {
      if (
        !this.keyframes.length ||
        this.selectedKeyframe < 0 ||
        this.selectedKeyframe >= this.keyframes.length
      ) {
        return;
      }

      requestAnimationFrame(() => {
        const currentKeyframe = this.keyframes[this.selectedKeyframe];
        let interpolatedHarmonics = [...currentKeyframe.harmonics];

        // Interpolate between keyframes if we're between two keyframes
        if (
          this.morphAmount > 0 &&
          this.selectedKeyframe < this.keyframes.length - 1
        ) {
          const nextKeyframe = this.keyframes[this.selectedKeyframe + 1];

          interpolatedHarmonics = currentKeyframe.harmonics.map(
            (harmonic, index) => ({
              amplitude:
                harmonic.amplitude * (1 - this.morphAmount) +
                nextKeyframe.harmonics[index].amplitude * this.morphAmount,
              phase:
                harmonic.phase * (1 - this.morphAmount) +
                nextKeyframe.harmonics[index].phase * this.morphAmount,
            }),
          );
        }

        // Generate waveform using interpolated harmonics
        const N = this.fftSize;
        const waveform = new Float64Array(N);

        for (let i = 0; i < N; i++) {
          let sample = 0;
          for (let h = 0; h < interpolatedHarmonics.length; h++) {
            const { amplitude, phase } = interpolatedHarmonics[h];
            const harmonicNumber = h + 1;
            sample +=
              amplitude *
              Math.sin((2 * Math.PI * harmonicNumber * i) / N + phase);
          }
          waveform[i] = sample;
        }

        // Apply wave warping if needed
        let currentWarpParams = {
          ...this.waveWarpKeyframes[this.selectedWaveWarpKeyframe].params,
        };

        if (
          this.warpMorphAmount > 0 &&
          this.selectedWaveWarpKeyframe < this.waveWarpKeyframes.length - 1
        ) {
          const nextParams =
            this.waveWarpKeyframes[this.selectedWaveWarpKeyframe + 1].params;
          currentWarpParams = {
            amount:
              currentWarpParams.amount * (1 - this.warpMorphAmount) +
              nextParams.amount * this.warpMorphAmount,
            type:
              this.warpMorphAmount < 0.5
                ? currentWarpParams.type
                : nextParams.type,
          };
        }

        // Apply modifiers
        let processedWaveform = waveform;

        if (currentWarpParams.amount !== 0) {
          processedWaveform = this.applyWaveWarp(
            processedWaveform,
            currentWarpParams,
          );
        }

        if (this.removeDC) {
          this.removeDCOffset(processedWaveform);
        }

        if (this.normalize) {
          this.normalizeWaveform(processedWaveform);
        }

        this.drawWaveform(processedWaveform);
      });
    },

    applyWaveWarp(waveform, params) {
      if (params.xAmount === 0 && params.yAmount === 0) return waveform;

      const warped = new Float64Array(waveform.length);
      const N = waveform.length;

      for (let i = 0; i < N; i++) {
        // Normalize position to [-1, 1] range
        const normalizedPos = (i / N) * 2 - 1;

        // Apply X warping
        let xPos = normalizedPos;
        if (params.xAmount !== 0) {
          if (params.asymmetric) {
            // Asymmetric warping
            if (normalizedPos >= 0) {
              xPos = Math.pow(normalizedPos, 1 + params.xAmount * 0.2);
            } else {
              xPos = -Math.pow(-normalizedPos, 1 + params.xAmount * 0.2);
            }
          } else {
            // Symmetric warping
            const sign = Math.sign(normalizedPos);
            const absPos = Math.abs(normalizedPos);
            xPos = sign * Math.pow(absPos, 1 + params.xAmount * 0.2);
          }
        }

        // Convert back to [0, 1] range for interpolation
        const samplePos = (xPos + 1) * 0.5 * (N - 1);
        const index1 = Math.floor(samplePos);
        const index2 = Math.min(index1 + 1, N - 1);
        const frac = samplePos - index1;

        // Linear interpolation
        let sample = waveform[index1] * (1 - frac) + waveform[index2] * frac;

        // Apply Y warping
        if (params.yAmount !== 0) {
          if (params.asymmetric) {
            // Asymmetric Y warping
            if (sample >= 0) {
              sample = Math.pow(sample, 1 + params.yAmount * 0.2);
            } else {
              sample = -Math.pow(-sample, 1 + params.yAmount * 0.2);
            }
          } else {
            // Symmetric Y warping
            const sign = Math.sign(sample);
            const absSample = Math.abs(sample);
            sample = sign * Math.pow(absSample, 1 + params.yAmount * 0.2);
          }
        }

        warped[i] = sample;
      }

      return warped;
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
      const canvas = this.$refs.canvas;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);
      ctx.beginPath();
      const scale = height / 2;

      // Draw center line
      ctx.strokeStyle = '#cccccc';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      // Draw waveform
      ctx.beginPath();
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
