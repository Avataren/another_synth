<template>
  <div class="preview-scopes" :data-testid="`${testidPrefix}-analyzer-row`">
    <figure class="preview-scopes__slot preview-scopes__slot--wave" :data-testid="`${testidPrefix}-analyzer-oscilloscope`">
      <TrackWaveform
        :audio-node="props.audioNode"
        :audio-context="props.audioContext"
        :scope-source="props.scopeSource"
        :analyser-full-scale="props.analyserFullScale"
        :scope-gain="props.scopeGain"
      />
      <figcaption :data-testid="`${testidPrefix}-analyzer-caption-wave`">Wave</figcaption>
    </figure>
    <figure class="preview-scopes__slot preview-scopes__slot--spectrum">
      <FrequencyAnalyzerComponent :node="spectrumNode" :data-testid="`${testidPrefix}-analyzer-frequency`" />
      <figcaption :data-testid="`${testidPrefix}-analyzer-caption-spectrum`">Spectrum</figcaption>
    </figure>
    <span v-if="!spectrumNode" class="preview-scopes__idle" :data-testid="`${testidPrefix}-analyzer-idle`"
      >Play a note to see it here.</span
    >
  </div>
</template>

<script setup lang="ts">
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';

/**
 * An instrument editor's view of its keyboard preview voice: the tracker's
 * own per-track scope (`TrackWaveform`, triggered and scaled as the tracker
 * draws that format's voices) beside a spectrum of the voice's output.
 */
interface Props {
  /** `ahx` or `sid`: the testids are `<prefix>-analyzer-*`. */
  testidPrefix: string;
  /** The preview voice's output: the spectrum's input, and while null the idle hint shows. */
  spectrumNode: AudioNode | null;
  /** The scope's input on the analyser path (SID); see `TrackWaveform`. */
  audioNode?: AudioNode | null;
  audioContext?: AudioContext | null;
  /** The scope's input on the snapshot path (AHX); see `TrackWaveform`. */
  scopeSource?: ((channel: number) => Int16Array | null) | null;
  analyserFullScale?: (() => number | null) | null;
  scopeGain?: number;
}

const props = withDefaults(defineProps<Props>(), {
  audioNode: null,
  audioContext: null,
  scopeSource: null,
  analyserFullScale: null,
  scopeGain: 1,
});
</script>

<style scoped>
.preview-scopes {
  position: relative;
  display: flex;
  gap: 10px;
  min-width: 0;
}

.preview-scopes__slot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin: 0;
}

/* The scope gets the room: a waveform wants width, a spectrum of one voice does not. */
.preview-scopes__slot--wave {
  flex: 3 1 240px;
}

.preview-scopes__slot--spectrum {
  flex: 1 1 140px;
}

.preview-scopes__slot figcaption {
  font-size: 0.7rem;
  text-align: center;
  opacity: 0.65;
}

/* One height for both: the tracker scope's own is 56px, the spectrum inherits 100% of nothing. */
.preview-scopes__slot > :first-child {
  height: 64px;
}

.preview-scopes__slot :deep(.track-waveform) {
  height: 64px;
}

.preview-scopes__slot :deep(.q-card__section) {
  padding: 0;
}

/* Over the two boxes until the first note makes the preview voice (and its output) exist. */
.preview-scopes__idle {
  position: absolute;
  inset: 0 0 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  opacity: 0.65;
  pointer-events: none;
}
</style>
