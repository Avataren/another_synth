<template>
  <div class="meter" :class="{ clipped: clipLatched }">
    <div class="meter-body">
      <div class="meter-scale" aria-hidden="true">
        <div
          v-for="mark in SCALE_MARKS"
          :key="mark.db"
          class="scale-mark"
          :class="{ 'scale-mark--zero': mark.db === 0 }"
          :style="{ bottom: `${dbToPercent(mark.db)}%` }"
        >
          <span class="scale-label">{{ mark.label }}</span>
        </div>
      </div>

      <div class="meter-bars">
        <div v-for="(ch, i) in channels" :key="ch.label" class="meter-channel">
          <div class="meter-track">
            <div
              class="meter-fill"
              :style="{ clipPath: `inset(${100 - (fillPercent[i] ?? 0)}% 0 0 0)` }"
            ></div>
            <!-- Hidden at silence: a hold marker pinned to the floor reads as
                 a signal that is not there. -->
            <div
              v-if="(holdPercent[i] ?? 0) > 0.5"
              class="meter-peak"
              :style="{ bottom: `${holdPercent[i]}%` }"
            ></div>
          </div>
          <div class="meter-label">{{ ch.label }}</div>
        </div>
      </div>
    </div>

    <button
      type="button"
      class="clip-led"
      :class="{ lit: clipLatched }"
      :title="
        clipLatched
          ? `Clipped — peak ${peakLabel}. Click to reset.`
          : `Peak ${peakLabel}`
      "
      @click.stop="resetClip"
    >
      {{ clipLatched ? 'CLIP' : peakLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import {
  CLIP_AMPLITUDE,
  MIN_DB,
  amplitudeToDb,
  dbToPercent,
  decayTowards,
  formatPeakLabel,
  peakMagnitude,
} from './level-meter-math';

/**
 * Stereo peak meter for the master mix.
 *
 * Trackers do not limit -- FastTracker 2 sums into an accumulator and clamps,
 * and Paula just sums in analog -- so a busy multi-channel module really can
 * run past full scale, and the only honest fix is headroom. This exists to
 * make that visible: the scale is in dBFS with 0 dB marked, and anything above
 * it latches the clip indicator until it is clicked.
 */
interface Props {
  /** Master mix output to measure. */
  node: AudioNode | null;
  audioContext: AudioContext | null;
  isPlaying?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  audioContext: null,
  isPlaying: false,
});

const channels = [{ label: 'L' }, { label: 'R' }] as const;

const SCALE_MARKS = [
  { db: 6, label: '+6' },
  { db: 0, label: '0' },
  { db: -6, label: '-6' },
  { db: -12, label: '-12' },
  { db: -24, label: '-24' },
  { db: -48, label: '-48' },
];

/** How fast the peak-hold marker falls, in dB per second. */
const HOLD_FALL_DB_PER_SECOND = 24;
/** How fast the bar itself falls, so it reads as a meter rather than a strobe. */
const FILL_FALL_DB_PER_SECOND = 96;

const fillPercent = ref([0, 0]);
const holdPercent = ref([0, 0]);
const clipLatched = ref(false);
const peakLabel = ref('-inf');

interface ChannelMeter {
  analyser: AnalyserNode;
  samples: Float32Array;
  /** Displayed level and hold, in dB, so the fall rates are time-based. */
  levelDb: number;
  holdDb: number;
}

let splitter: ChannelSplitterNode | null = null;
let meters: ChannelMeter[] = [];
let connectedNode: AudioNode | null = null;
let unregister: (() => void) | null = null;
let lastFrameTime = 0;

function teardown() {
  if (unregister) {
    unregister();
    unregister = null;
  }
  if (connectedNode && splitter) {
    try {
      connectedNode.disconnect(splitter);
    } catch {
      // Already disconnected.
    }
  }
  connectedNode = null;
  for (const meter of meters) meter.analyser.disconnect();
  meters = [];
  if (splitter) {
    splitter.disconnect();
    splitter = null;
  }
}

function build() {
  const context = props.audioContext;
  const node = props.node;
  if (!context || !node) return;

  splitter = context.createChannelSplitter(2);
  meters = channels.map(() => {
    const analyser = context.createAnalyser();
    // Small window: this is a peak meter, so responsiveness matters more than
    // resolution, and no smoothing at all -- an over must not be averaged away.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    return {
      analyser,
      samples: new Float32Array(analyser.fftSize),
      levelDb: MIN_DB,
      holdDb: MIN_DB,
    };
  });

  node.connect(splitter);
  connectedNode = node;
  meters.forEach((meter, i) => splitter!.connect(meter.analyser, i));

  lastFrameTime = 0;
  unregister = registerAnimationCallback(tick);
}

function tick(time: number) {
  const deltaSeconds =
    lastFrameTime === 0 ? 0 : Math.min(0.25, (time - lastFrameTime) / 1000);
  lastFrameTime = time;

  const fills = [0, 0];
  const holds = [0, 0];
  let framePeak = 0;

  meters.forEach((meter, i) => {
    meter.analyser.getFloatTimeDomainData(meter.samples);

    const peak = peakMagnitude(meter.samples);
    if (peak > framePeak) framePeak = peak;
    if (peak >= CLIP_AMPLITUDE) clipLatched.value = true;

    const peakDb = amplitudeToDb(peak);
    meter.levelDb = decayTowards(
      meter.levelDb,
      peakDb,
      FILL_FALL_DB_PER_SECOND,
      deltaSeconds,
    );
    meter.holdDb = decayTowards(
      meter.holdDb,
      peakDb,
      HOLD_FALL_DB_PER_SECOND,
      deltaSeconds,
    );

    fills[i] = dbToPercent(meter.levelDb);
    holds[i] = dbToPercent(meter.holdDb);
  });

  fillPercent.value = fills;
  holdPercent.value = holds;

  peakLabel.value = formatPeakLabel(framePeak);
}

function resetClip() {
  clipLatched.value = false;
}

watch(
  () => [props.node, props.audioContext],
  () => {
    teardown();
    build();
  },
  { immediate: true },
);

onUnmounted(teardown);
</script>

<style scoped>
.meter {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 6px 4px;
  border-radius: 8px;
  background: linear-gradient(
    180deg,
    rgba(6, 9, 15, 0.95),
    rgba(12, 16, 24, 0.95)
  );
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    inset 0 -8px 18px rgba(0, 0, 0, 0.45);
  flex-shrink: 0;
}

.meter-body {
  display: flex;
  align-items: stretch;
  gap: 4px;
  flex: 1;
  min-height: 0;
}

.meter.clipped {
  border-color: rgba(255, 86, 86, 0.55);
}

/* Scale ---------------------------------------------------------------- */

.meter-scale {
  position: relative;
  width: 20px;
  /* Leave room for the L/R labels under the bars so the marks line up with
     the track itself rather than the whole column. */
  margin-bottom: 11px;
}

.scale-mark {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  display: flex;
  align-items: center;
  gap: 3px;
}

.scale-label {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 7px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.34);
}

.scale-mark--zero .scale-label {
  color: rgba(255, 206, 84, 0.85);
}

/* Bars ----------------------------------------------------------------- */

.meter-bars {
  display: flex;
  gap: 4px;
}

.meter-channel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.meter-track {
  position: relative;
  width: 12px;
  flex: 1;
  min-height: 60px;
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.62);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

/* The 0 dB line, so an over is visible against a fixed reference. */
.meter-track::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc((0 - -48) / (6 - -48) * 100%);
  height: 1px;
  background: rgba(255, 206, 84, 0.4);
}

/*
 * The gradient spans the whole track and is revealed by clipping, so a colour
 * always means the same level. Scaling a shorter element instead would slide
 * red down to whatever the current peak happens to be.
 *
 * Stops are in the scale's own dB space (-48 at the bottom, +6 at the top, so
 * 54 dB over 100%): red above 0 dB, amber from 0 down to -6, green below.
 */
.meter-fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    #ff4d4d 0%,
    #ff4d4d 11.1%,
    #ffb020 11.1%,
    #ffb020 22.2%,
    #9ada4a 33.3%,
    #35c46a 100%
  );
}

.meter-peak {
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 4px rgba(255, 255, 255, 0.4);
  pointer-events: none;
}

.meter-label {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 8px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 0.06em;
}

/* Clip readout --------------------------------------------------------- */

.clip-led {
  width: 100%;
  height: 13px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 255, 255, 0.5);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 7px;
  line-height: 1;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.clip-led.lit {
  background: #d83232;
  border-color: #ff6b6b;
  color: #fff;
  box-shadow: 0 0 8px rgba(255, 80, 80, 0.7);
}
</style>
