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
            Adjust amplitude & phase for each harmonic.
          </div>

          <!-- Harmonic sliders (Amplitude & Phase) -->
          <div
            v-if="keyframes[selectedKeyframe]"
            class="current-harmonics q-my-md"
          >
            <div class="row items-center">
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
                    class="harmonic-slider"
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
                    class="harmonic-slider"
                  />
                  <div style="font-size: 10px">H{{ hIndex + 1 }}</div>
                </div>
              </div>
            </div>
            <div class="text-subtitle2" style="width: 120px">
              Time: {{ keyframes[selectedKeyframe].time.toFixed(1) }}%
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
          </div>
          <div class="row items-center">
            <q-toggle v-model="removeDC" label="Remove DC" class="q-mr-md" />
            <q-toggle v-model="normalize" label="Normalize" class="q-mr-md" />
          </div>
          <!-- Timeline -->
          <div
            class="timeline"
            ref="timeline"
            @mousedown="handleTimelineMouseDown"
            @contextmenu.prevent="showTimelineContextMenu"
          >
            <q-menu v-model="showContextMenu" context-menu>
              <q-list dense>
                <q-item clickable v-close-popup @click="addKeyframeAtPosition">
                  <q-item-section>Add Keyframe</q-item-section>
                </q-item>
                <q-item
                  clickable
                  v-close-popup
                  @click="removeKeyframe"
                  :disable="keyframes.length <= 1"
                >
                  <q-item-section>Remove Keyframe</q-item-section>
                </q-item>
              </q-list>
            </q-menu>

            <div class="timeline-bar"></div>

            <!-- Scrubber -->
            <div
              class="timeline-scrubber"
              :style="{
                left: timelineRect
                  ? (scrubPosition / 100) * (timelineRect.width - 40) +
                    20 +
                    'px'
                  : scrubPosition + '%',
              }"
              @mousedown.stop="startScrubbing"
            ></div>

            <!-- Keyframe markers -->
            <div
              v-for="(keyframe, index) in keyframes"
              :key="index"
              class="keyframe-marker"
              :class="{ selected: index === selectedKeyframe }"
              :style="{
                left: timelineRect
                  ? (keyframe.time / 100) * (timelineRect.width - 40) +
                    20 +
                    'px'
                  : keyframe.time + '%',
              }"
              @mousedown.stop="startDrag($event, index)"
              @click.stop="handleKeyframeClick($event, index)"
            >
              <q-icon
                name="fiber_manual_record"
                size="24px"
                :color="index === selectedKeyframe ? 'red' : 'blue'"
              />
            </div>
          </div>

          <!-- Wave Warp Timeline -->
          <div class="q-my-md">
            <div class="text-subtitle2">Wave Warp Timeline</div>
            <div class="timeline wave-warp-timeline" ref="waveWarpTimeline">
              <div class="timeline-bar"></div>

              <!-- Wave Warp Keyframe markers -->
              <div
                v-for="(keyframe, index) in waveWarpKeyframes"
                :key="'warp-' + index"
                class="keyframe-marker"
                :class="{ selected: index === selectedWaveWarpKeyframe }"
                :style="{
                  left: timelineRect
                    ? (keyframe.time / 100) * (timelineRect.width - 40) +
                      20 +
                      'px'
                    : keyframe.time + '%',
                }"
                @mousedown.stop="startWaveWarpDrag($event, index)"
                @click.stop="selectWaveWarpKeyframe(index)"
              >
                <q-icon
                  name="fiber_manual_record"
                  size="24px"
                  :color="
                    index === selectedWaveWarpKeyframe ? 'purple' : 'blue'
                  "
                />
              </div>
            </div>
          </div>

          <!-- Wave Warp Parameters -->
          <div
            class="q-my-md"
            v-if="waveWarpKeyframes[selectedWaveWarpKeyframe]"
          >
            <div class="row q-gutter-md">
              <div class="col">
                <q-input
                  v-model="
                    waveWarpKeyframes[selectedWaveWarpKeyframe].params.amount
                  "
                  type="number"
                  label="Amount"
                  :min="-1"
                  :max="1"
                  :step="0.01"
                  style="max-width: 150px"
                />
              </div>
              <div class="col">
                <q-select
                  v-model="
                    waveWarpKeyframes[selectedWaveWarpKeyframe].params.type
                  "
                  label="Warp Type"
                  :options="waveWarpTypes"
                  style="max-width: 150px"
                />
              </div>
              <div class="col">
                <q-btn
                  flat
                  color="primary"
                  label="Add Keyframe"
                  @click="addWaveWarpKeyframe"
                />
                <q-btn
                  flat
                  color="negative"
                  label="Remove Keyframe"
                  @click="removeWaveWarpKeyframe"
                  :disable="waveWarpKeyframes.length <= 1"
                />
              </div>
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
      default: 64,
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
      removeDC: false,
      normalize: true,
      phaseMin: -Math.PI,
      phaseMax: Math.PI,
      // Scrubbing
      scrubPosition: 0,
      isScrubbing: false,
      showContextMenu: false,
      contextMenuPosition: {
        left: 0,
        top: 0,
      },
      // Wave Warp system
      waveWarpKeyframes: [],
      selectedWaveWarpKeyframe: 0,
      isDraggingWaveWarp: false,
      dragWarpIndex: null,
      dragWarpStartX: 0,
      initialWarpTime: 0,
      warpMorphAmount: 0,
      waveWarpTypes: ['pow', 'sine', 'asym', 'bend'],
      contextMenuClickPosition: null,
      // Drag tracking
      dragStartX: 0,
      initialKeyframeTime: 0,
      morphAmount: 0,
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

    this.$nextTick(() => {
      if (this.$refs.timeline) {
        this.updateTimelineLayout();
      }
    });

    // Add window event listeners for dragging
    window.addEventListener('mousemove', this.onDrag);
    window.addEventListener('mouseup', this.stopDrag);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('mousemove', this.onWaveWarpDrag);
    window.addEventListener('mouseup', this.stopWaveWarpDrag);
  },
  beforeUnmount() {
    // Clean up event listeners
    window.removeEventListener('mouseup', this.stopWaveWarpDrag);
    window.removeEventListener('mousemove', this.onWaveWarpDrag);
    window.removeEventListener('mousemove', this.onDrag);
    window.removeEventListener('mouseup', this.stopDrag);
    window.removeEventListener('resize', this.handleResize);
  },
  watch: {
    'waveWarp.amount'() {
      this.updateWaveformPreview();
    },
    'waveWarp.type'() {
      this.updateWaveformPreview();
    },
    showEditor: {
      immediate: true,
      handler(newVal) {
        if (newVal) {
          // Clear any existing timeouts
          if (this.initTimeout) {
            clearTimeout(this.initTimeout);
          }

          // Wait for dialog transition (250ms is typical for Quasar transitions)
          this.initTimeout = setTimeout(() => {
            if (this.$refs.timeline) {
              // Force a layout reflow
              void this.$refs.timeline.offsetWidth;
              this.timelineRect = this.$refs.timeline.getBoundingClientRect();
              this.updateTimelineLayout();

              // Double-check measurements after a brief delay
              setTimeout(() => {
                if (this.$refs.timeline) {
                  const newRect = this.$refs.timeline.getBoundingClientRect();
                  if (newRect.width !== this.timelineRect.width) {
                    this.timelineRect = newRect;
                    this.updateTimelineLayout();
                  }
                }
              }, 50);
            }
          }, 300);
        }
      },
    },
    keyframes: {
      handler() {
        this.$nextTick(() => {
          if (this.$refs.timeline) {
            this.timelineRect = this.$refs.timeline.getBoundingClientRect();
          }
          this.updateWaveformPreview();
        });
      },
      deep: true,
    },
    selectedKeyframe() {
      this.updateWaveformPreview();
    },
    removeDC() {
      this.updateWaveformPreview();
    },
    normalize() {
      this.updateWaveformPreview();
    },
  },
  methods: {
    startWaveWarpDrag(event, index) {
      event.stopPropagation();
      this.isDraggingWaveWarp = true;
      this.dragWarpIndex = index;

      if (!this.timelineRect) {
        this.timelineRect = this.$refs.waveWarpTimeline.getBoundingClientRect();
      }

      this.dragWarpStartX = event.clientX;
      this.initialWarpTime = this.waveWarpKeyframes[index].time;
      this.selectedWaveWarpKeyframe = index;
    },

    onWaveWarpDrag(event) {
      if (
        !this.isDraggingWaveWarp ||
        this.dragWarpIndex === null ||
        !this.timelineRect
      )
        return;

      const availableWidth = this.timelineRect.width - 40;
      const deltaX = event.clientX - this.dragWarpStartX;
      const deltaTime = (deltaX / availableWidth) * 100;
      let newTime = this.initialWarpTime + deltaTime;
      newTime = Math.max(0, Math.min(100, newTime));

      this.waveWarpKeyframes[this.dragWarpIndex].time = newTime;
      this.sortWaveWarpKeyframes();
      this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.findIndex(
        (kf) => kf.time === newTime,
      );
      this.updateWaveformPreview();
    },

    stopWaveWarpDrag() {
      this.isDraggingWaveWarp = false;
      this.dragWarpIndex = null;
    },

    addWaveWarpKeyframe() {
      const current = this.waveWarpKeyframes[this.selectedWaveWarpKeyframe];
      let newTime = current.time;

      if (this.selectedWaveWarpKeyframe < this.waveWarpKeyframes.length - 1) {
        const next = this.waveWarpKeyframes[this.selectedWaveWarpKeyframe + 1];
        newTime = (current.time + next.time) / 2;
      }

      const newKeyframe = {
        time: newTime,
        params: { ...current.params },
      };

      this.waveWarpKeyframes.push(newKeyframe);
      this.sortWaveWarpKeyframes();
      this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.findIndex(
        (kf) => kf === newKeyframe,
      );
    },

    removeWaveWarpKeyframe() {
      if (
        this.waveWarpKeyframes.length > 1 &&
        this.selectedWaveWarpKeyframe !== null
      ) {
        this.waveWarpKeyframes.splice(this.selectedWaveWarpKeyframe, 1);
        if (this.selectedWaveWarpKeyframe >= this.waveWarpKeyframes.length) {
          this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.length - 1;
        }
      }
    },

    sortWaveWarpKeyframes() {
      this.waveWarpKeyframes.sort((a, b) => a.time - b.time);
    },
    updateTimelineLayout() {
      if (!this.$refs.timeline) return;

      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
      // Force a re-render of keyframe positions
      this.keyframes = [...this.keyframes];
    },
    handleResize() {
      if (this.showEditor) {
        this.updateTimelineLayout();
      }
    },
    handlePresetChange(newVal) {
      if (newVal === 'harmonicSeries') {
        // Clear existing keyframes first
        this.keyframes = [
          {
            time: 0,
            harmonics: Array.from({ length: this.numHarmonics }, () => ({
              amplitude: 0,
              phase: 0,
            })),
          },
        ];

        // Apply new preset in next tick
        this.$nextTick(() => {
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

          // Force timeline and waveform updates
          this.$nextTick(() => {
            if (this.$refs.timeline) {
              this.timelineRect = this.$refs.timeline.getBoundingClientRect();
            }
            this.updateWaveformPreview();
            this.selectedPreset = 'custom';
          });
        });
      }
    },
    applyWaveWarp(waveform, params) {
      if (params.amount === 0) return waveform;

      const warped = new Float64Array(waveform.length);
      const normalizedAmount = params.amount;

      for (let i = 0; i < waveform.length; i++) {
        const phase = i / waveform.length;
        let warpedPhase = phase;

        switch (params.type) {
          case 'pow':
            if (normalizedAmount > 0) {
              warpedPhase = Math.pow(phase, 1 + normalizedAmount * 3);
            } else {
              warpedPhase = 1 - Math.pow(1 - phase, 1 - normalizedAmount * 3);
            }
            break;
          case 'sine':
            warpedPhase =
              phase +
              (normalizedAmount * Math.sin(2 * Math.PI * phase)) /
                (2 * Math.PI);
            break;
          case 'asym':
            const asymAmount = Math.abs(normalizedAmount);
            if (phase < 0.5) {
              warpedPhase = phase * (1 - asymAmount);
            } else {
              warpedPhase = phase * (1 + asymAmount) - asymAmount;
            }
            break;
          case 'bend':
            warpedPhase = phase + normalizedAmount * (phase * (1 - phase));
            break;
        }

        warpedPhase = Math.max(0, Math.min(1, warpedPhase));
        const indexFloat = warpedPhase * (waveform.length - 1);
        const index1 = Math.floor(indexFloat);
        const index2 = Math.min(index1 + 1, waveform.length - 1);
        const frac = indexFloat - index1;

        warped[i] = waveform[index1] * (1 - frac) + waveform[index2] * frac;
      }

      return warped;
    },
    updateWaveformAtScrubPosition() {
      // Find surrounding keyframes for interpolation
      let prevKeyframe = null;
      let nextKeyframe = null;

      // Find the surrounding keyframes
      for (let i = 0; i < this.keyframes.length - 1; i++) {
        if (
          this.scrubPosition >= this.keyframes[i].time &&
          this.scrubPosition <= this.keyframes[i + 1].time
        ) {
          prevKeyframe = this.keyframes[i];
          nextKeyframe = this.keyframes[i + 1];
          break;
        }
      }

      // Handle edge cases
      if (!prevKeyframe || !nextKeyframe) {
        if (this.scrubPosition <= this.keyframes[0].time) {
          // Before first keyframe
          this.selectedKeyframe = 0;
          this.morphAmount = 0;
        } else {
          // After last keyframe
          this.selectedKeyframe = this.keyframes.length - 1;
          this.morphAmount = 0;
        }
      } else {
        // Calculate interpolation amount
        const t =
          (this.scrubPosition - prevKeyframe.time) /
          (nextKeyframe.time - prevKeyframe.time);

        this.selectedKeyframe = this.keyframes.indexOf(prevKeyframe);
        this.morphAmount = t;
      }

      // Update the waveform with the new interpolation
      this.updateWaveformPreview();
    },

    updateScrubPosition(event) {
      if (!this.timelineRect) {
        this.timelineRect = this.$refs.timeline.getBoundingClientRect();
      }
      const availableWidth = this.timelineRect.width - 40;
      let x = event.clientX - this.timelineRect.left;

      // Constrain x to the timeline bounds
      x = Math.max(20, Math.min(x, this.timelineRect.width - 20));

      // Calculate scrub position as percentage
      this.scrubPosition = ((x - 20) / availableWidth) * 100;

      // Find surrounding keyframes for interpolation
      let prevKeyframe = null;
      let nextKeyframe = null;

      for (let i = 0; i < this.keyframes.length - 1; i++) {
        if (
          this.scrubPosition >= this.keyframes[i].time &&
          this.scrubPosition <= this.keyframes[i + 1].time
        ) {
          prevKeyframe = this.keyframes[i];
          nextKeyframe = this.keyframes[i + 1];
          break;
        }
      }

      // Handle edge cases
      if (!prevKeyframe || !nextKeyframe) {
        if (this.scrubPosition <= this.keyframes[0].time) {
          this.selectedKeyframe = 0;
          this.morphAmount = 0;
        } else {
          this.selectedKeyframe = this.keyframes.length - 1;
          this.morphAmount = 0;
        }
      } else {
        // Calculate interpolation amount
        const t =
          (this.scrubPosition - prevKeyframe.time) /
          (nextKeyframe.time - prevKeyframe.time);

        this.selectedKeyframe = this.keyframes.indexOf(prevKeyframe);
        this.morphAmount = t;
      }

      // Update waveform with new interpolation
      this.updateWaveformPreview();
    },
    updateWaveWarpAtScrubPosition() {
      let prevKeyframe = null;
      let nextKeyframe = null;

      for (let i = 0; i < this.waveWarpKeyframes.length - 1; i++) {
        if (
          this.scrubPosition >= this.waveWarpKeyframes[i].time &&
          this.scrubPosition <= this.waveWarpKeyframes[i + 1].time
        ) {
          prevKeyframe = this.waveWarpKeyframes[i];
          nextKeyframe = this.waveWarpKeyframes[i + 1];
          break;
        }
      }

      if (!prevKeyframe || !nextKeyframe) {
        if (this.scrubPosition <= this.waveWarpKeyframes[0].time) {
          this.selectedWaveWarpKeyframe = 0;
          this.warpMorphAmount = 0;
        } else {
          this.selectedWaveWarpKeyframe = this.waveWarpKeyframes.length - 1;
          this.warpMorphAmount = 0;
        }
      } else {
        const t =
          (this.scrubPosition - prevKeyframe.time) /
          (nextKeyframe.time - prevKeyframe.time);

        this.selectedWaveWarpKeyframe =
          this.waveWarpKeyframes.indexOf(prevKeyframe);
        this.warpMorphAmount = t;
      }
    },
    updateHarmonicsAtScrubPosition() {
      let prevKeyframe = null;
      let nextKeyframe = null;

      for (let i = 0; i < this.keyframes.length - 1; i++) {
        if (
          this.scrubPosition >= this.keyframes[i].time &&
          this.scrubPosition <= this.keyframes[i + 1].time
        ) {
          prevKeyframe = this.keyframes[i];
          nextKeyframe = this.keyframes[i + 1];
          break;
        }
      }

      if (!prevKeyframe || !nextKeyframe) {
        if (this.scrubPosition <= this.keyframes[0].time) {
          this.selectedKeyframe = 0;
          this.morphAmount = 0;
        } else {
          this.selectedKeyframe = this.keyframes.length - 1;
          this.morphAmount = 0;
        }
      } else {
        const t =
          (this.scrubPosition - prevKeyframe.time) /
          (nextKeyframe.time - prevKeyframe.time);

        this.selectedKeyframe = this.keyframes.indexOf(prevKeyframe);
        this.morphAmount = t;
      }
    },

    handleTimelineMouseDown(event) {
      // Check if we clicked directly on a keyframe marker
      const target = event.target;
      const isKeyframeClick = target.closest('.keyframe-marker');

      if (isKeyframeClick) {
        // Let the keyframe click handler manage this interaction
        return;
      }

      // Prevent context menu from showing during drag
      event.preventDefault();

      // Start scrubbing immediately
      this.isScrubbing = true;
      this.updateScrubPosition(event);

      // Add document-level event listeners
      document.addEventListener('mousemove', this.onScrub);
      document.addEventListener('mouseup', this.stopScrubbing);
    },

    startScrubbing(event) {
      this.isScrubbing = true;
      this.updateScrubPosition(event);
      document.addEventListener('mousemove', this.onScrub);
      document.addEventListener('mouseup', this.stopScrubbing);
    },

    onScrub(event) {
      if (!this.isScrubbing) return;
      this.updateScrubPosition(event);
    },

    stopScrubbing() {
      this.isScrubbing = false;
      document.removeEventListener('mousemove', this.onScrub);
      document.removeEventListener('mouseup', this.stopScrubbing);
    },
    handleKeyframeClick(event, index) {
      event.stopPropagation(); // Prevent timeline click
      if (!this.isDragging) {
        this.selectKeyframe(index);
      }
    },
    showTimelineContextMenu(event) {
      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
      const timelinePadding = 20;
      const effectiveWidth = this.timelineRect.width - timelinePadding * 2;
      const clickX = event.clientX - this.timelineRect.left - timelinePadding;
      const percentagePosition = Math.max(
        0,
        Math.min(100, (clickX / effectiveWidth) * 100),
      );

      this.contextMenuClickPosition = percentagePosition;
      this.showContextMenu = true;
      this.contextMenuPosition = {
        left: event.clientX,
        top: event.clientY,
      };
    },

    addKeyframeAtPosition() {
      if (this.contextMenuClickPosition === null) return;

      const existingKeyframeIndex = this.keyframes.findIndex(
        (kf) => Math.abs(kf.time - this.contextMenuClickPosition) < 0.1,
      );

      if (existingKeyframeIndex !== -1) {
        this.selectedKeyframe = existingKeyframeIndex;
        this.contextMenuClickPosition = null;
        return;
      }

      const newKeyframe = {
        time: this.contextMenuClickPosition,
        harmonics: this.keyframes[this.selectedKeyframe].harmonics.map((h) => ({
          amplitude: h.amplitude,
          phase: h.phase,
        })),
      };

      this.keyframes.push(newKeyframe);
      this.sortKeyframes();
      this.selectedKeyframe = this.keyframes.findIndex(
        (kf) => Math.abs(kf.time - this.contextMenuClickPosition) < 0.1,
      );
      this.contextMenuClickPosition = null;
    },

    startDrag(event, index) {
      event.stopPropagation();
      this.isDragging = true;
      this.dragIndex = index;

      if (!this.timelineRect) {
        this.timelineRect = this.$refs.timeline.getBoundingClientRect();
      }

      this.dragStartX = event.clientX;
      this.initialKeyframeTime = this.keyframes[index].time;
      this.selectedKeyframe = index;
    },

    onDrag(event) {
      if (!this.isDragging || this.dragIndex === null || !this.timelineRect)
        return;

      const availableWidth = this.timelineRect.width - 40;
      const deltaX = event.clientX - this.dragStartX;
      const deltaTime = (deltaX / availableWidth) * 100;
      let newTime = this.initialKeyframeTime + deltaTime;
      newTime = Math.max(0, Math.min(100, newTime));

      this.keyframes[this.dragIndex].time = newTime;
      this.sortKeyframes();
      this.selectedKeyframe = this.keyframes.findIndex(
        (kf) => kf.time === newTime,
      );
      this.updateWaveformPreview();
    },

    stopDrag() {
      this.isDragging = false;
      this.dragIndex = null;
    },

    applyHarmonicSeriesPreset() {
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

      // Reset all state before applying new keyframes
      this.scrubPosition = 0;
      this.keyframes = newKeyframes;
      this.selectedKeyframe = 0;

      // Force a fresh update of the waveform
      this.$nextTick(() => {
        this.updateWaveformPreview();
      });
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

    sortKeyframes() {
      this.keyframes.sort((a, b) => a.time - b.time);
    },

    updateWaveformPreview() {
      if (
        !this.keyframes.length ||
        this.selectedKeyframe < 0 ||
        this.selectedKeyframe >= this.keyframes.length
      ) {
        return;
      }

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
    },
    removeDCOffset(waveform) {
      const avg = waveform.reduce((sum, val) => sum + val, 0) / waveform.length;
      for (let i = 0; i < waveform.length; i++) {
        waveform[i] -= avg;
      }
    },

    /*************  ✨ Codeium Command ⭐  *************/
    /**
     * Normalize a waveform by scaling all samples by the absolute maximum value.
     * This is useful for avoiding clipping when the waveform is played back.
     * @param {Float64Array} waveform The waveform to normalize.
     */
    /******  88462a26-43b5-4af4-958b-7a71e443fc3a  *******/
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

.timeline-scrubber {
  position: absolute;
  top: 0;
  width: 2px;
  height: 100%;
  background: #ff0000;
  cursor: ew-resize;
  z-index: 2;
}

.keyframe-marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
  z-index: 3;
}

.keyframe-marker.selected {
  z-index: 4;
}

.vertical-sliders {
  height: 200px;
}

.harmonic-slider {
  margin-top: 10px;
  height: 140px;
}

.wave-warp-timeline {
  background: #f0e0f0;
  cursor: default;
}
</style>
