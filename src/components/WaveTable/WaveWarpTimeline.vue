<template>
  <div class="q-my-md">
    <div class="text-subtitle2">Wave Warp Timeline</div>
    <div
      class="timeline wave-warp-timeline"
      ref="timeline"
      @mousedown="handleTimelineMouseDown"
      @contextmenu.prevent="showContextMenu"
    >
      <div class="timeline-bar"></div>

      <div
        class="timeline-scrubber"
        :style="{ left: scrubberPosition }"
        @mousedown.stop="startScrubbing"
      ></div>

      <div
        v-for="(keyframe, index) in keyframes"
        :key="'warp-' + index"
        class="keyframe-marker"
        :class="{ selected: index === selectedKeyframe }"
        :style="{ left: getKeyframePosition(keyframe.time) }"
        @mousedown.stop="startDrag($event, index)"
        @click.stop="selectKeyframe(index)"
        @contextmenu.prevent.stop="showKeyframeMenu($event, index)"
      >
        <q-icon
          name="fiber_manual_record"
          size="24px"
          :color="index === selectedKeyframe ? 'purple' : 'blue'"
        />
      </div>
    </div>

    <div class="q-my-md" v-if="keyframes[selectedKeyframe]">
      <WaveWarpParameters
        :params="keyframes[selectedKeyframe].params"
        :warp-types="warpTypes"
        @update:params="updateParams"
      />
    </div>

    <q-menu v-model="showMenu" :position="menuPosition" context-menu>
      <q-list dense>
        <q-item clickable v-close-popup @click="addKeyframe">
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
  </div>
</template>

<script>
import WaveWarpParameters from './WaveWarpParameters.vue';

export default {
  name: 'WaveWarpTimeline',
  components: {
    WaveWarpParameters,
  },
  props: {
    keyframes: {
      type: Array,
      required: true,
    },
    selectedKeyframe: {
      type: Number,
      required: true,
    },
    scrubPosition: {
      type: Number,
      required: true,
    },
    warpTypes: {
      type: Array,
      required: true,
    },
  },

  emits: ['update:selected', 'update:keyframes', 'update:morph'],

  data() {
    return {
      timelineRect: null,
      isDragging: false,
      dragIndex: null,
      dragStartX: 0,
      initialKeyframeTime: 0,
      isScrubbing: false,
      showMenu: false,
      menuPosition: { left: '0px', top: '0px' },
      contextMenuTargetTime: 0,
    };
  },

  computed: {
    scrubberPosition() {
      if (!this.timelineRect) return '0%';
      const availableWidth = this.timelineRect.width - 40;
      return `${(this.scrubPosition / 100) * availableWidth + 20}px`;
    },
  },

  mounted() {
    this.updateTimelineLayout();
    window.addEventListener('mousemove', this.onDrag);
    window.addEventListener('mouseup', this.stopDrag);
    window.addEventListener('resize', this.handleResize);
  },

  beforeUnmount() {
    window.removeEventListener('mousemove', this.onDrag);
    window.removeEventListener('mouseup', this.stopDrag);
    window.removeEventListener('resize', this.handleResize);
  },

  methods: {
    updateTimelineLayout() {
      if (!this.$refs.timeline) return;
      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
    },

    handleResize() {
      this.updateTimelineLayout();
    },

    getKeyframePosition(time) {
      if (!this.timelineRect) return '0%';
      const availableWidth = this.timelineRect.width - 40;
      return `${(time / 100) * availableWidth + 20}px`;
    },

    handleTimelineMouseDown(event) {
      const isKeyframeClick = event.target.closest('.keyframe-marker');
      if (isKeyframeClick) return;

      event.preventDefault();
      this.isScrubbing = true;
      this.updateScrubPosition(event);

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

    updateScrubPosition(event) {
      if (!this.timelineRect) {
        this.updateTimelineLayout();
      }
      const availableWidth = this.timelineRect.width - 40;
      let x = event.clientX - this.timelineRect.left;
      x = Math.max(20, Math.min(x, this.timelineRect.width - 20));
      const newPosition = ((x - 20) / availableWidth) * 100;

      // Find the appropriate keyframe indices based on position
      let currentIndex = 0;
      while (
        currentIndex < this.keyframes.length - 1 &&
        this.keyframes[currentIndex + 1].time <= newPosition
      ) {
        currentIndex++;
      }

      // Update selected keyframe
      if (this.selectedKeyframe !== currentIndex) {
        this.$emit('update:selected', currentIndex);
      }

      // Calculate morph amount
      let morphAmount = 0;
      if (currentIndex < this.keyframes.length - 1) {
        const current = this.keyframes[currentIndex];
        const next = this.keyframes[currentIndex + 1];
        const range = next.time - current.time;
        if (range > 0) {
          morphAmount = (newPosition - current.time) / range;
          morphAmount = Math.max(0, Math.min(1, morphAmount));
        }
      }

      this.$emit('update:morph', morphAmount);
    },

    calculateMorphAmount(position) {
      if (this.keyframes.length < 2) return 0;

      let currentIndex = 0;
      while (
        currentIndex < this.keyframes.length - 1 &&
        this.keyframes[currentIndex + 1].time <= position
      ) {
        currentIndex++;
      }

      if (currentIndex >= this.keyframes.length - 1) {
        this.$emit('update:selected', this.keyframes.length - 1);
        return 0;
      }

      const current = this.keyframes[currentIndex];
      const next = this.keyframes[currentIndex + 1];
      const range = next.time - current.time;

      if (range === 0) return 0;

      const amount = (position - current.time) / range;
      const morphAmount = Math.max(0, Math.min(1, amount));

      if (this.selectedKeyframe !== currentIndex) {
        this.$emit('update:selected', currentIndex);
      }

      return morphAmount;
    },

    showContextMenu(event) {
      const availableWidth = this.timelineRect.width - 40;
      let x = event.clientX - this.timelineRect.left;
      x = Math.max(20, Math.min(x, this.timelineRect.width - 20));
      this.contextMenuTargetTime = ((x - 20) / availableWidth) * 100;

      this.menuPosition = {
        left: event.clientX + 'px',
        top: event.clientY + 'px',
      };
      this.showMenu = true;
    },

    showKeyframeMenu(event, index) {
      this.selectKeyframe(index);
      this.menuPosition = {
        left: event.clientX + 'px',
        top: event.clientY + 'px',
      };
      this.showMenu = true;
    },

    addKeyframe() {
      let newTime = this.contextMenuTargetTime;
      const current = this.keyframes[this.selectedKeyframe];
      const newKeyframe = {
        time: newTime,
        params: {
          xAmount: current.params.xAmount || 0,
          yAmount: current.params.yAmount || 0,
          asymmetric: current.params.asymmetric || false,
        },
      };

      const updatedKeyframes = [...this.keyframes, newKeyframe];
      this.sortKeyframes(updatedKeyframes);
      this.$emit('update:keyframes', updatedKeyframes);
    },

    removeKeyframe() {
      if (this.keyframes.length <= 1) return;

      const updatedKeyframes = this.keyframes.filter(
        (_, index) => index !== this.selectedKeyframe,
      );
      this.$emit('update:keyframes', updatedKeyframes);

      if (this.selectedKeyframe >= updatedKeyframes.length) {
        this.$emit('update:selected', updatedKeyframes.length - 1);
      }
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
      this.$emit('update:selected', index);
    },

    onDrag(event) {
      if (!this.isDragging || this.dragIndex === null || !this.timelineRect)
        return;

      const availableWidth = this.timelineRect.width - 40;
      const deltaX = event.clientX - this.dragStartX;
      const deltaTime = (deltaX / availableWidth) * 100;
      let newTime = this.initialKeyframeTime + deltaTime;
      newTime = Math.max(0, Math.min(100, newTime));

      const updatedKeyframes = [...this.keyframes];
      updatedKeyframes[this.dragIndex] = {
        ...updatedKeyframes[this.dragIndex],
        time: newTime,
      };

      this.sortKeyframes(updatedKeyframes);
      this.$emit('update:keyframes', updatedKeyframes);
    },

    stopDrag() {
      this.isDragging = false;
      this.dragIndex = null;
    },

    selectKeyframe(index) {
      if (!this.isDragging) {
        this.$emit('update:selected', index);
      }
    },

    updateParams(newParams) {
      const updatedKeyframes = [...this.keyframes];
      updatedKeyframes[this.selectedKeyframe] = {
        ...updatedKeyframes[this.selectedKeyframe],
        params: newParams,
      };
      this.$emit('update:keyframes', updatedKeyframes);
    },

    sortKeyframes(keyframes) {
      return keyframes.sort((a, b) => a.time - b.time);
    },
  },
};
</script>

<style scoped>
.timeline {
  position: relative;
  height: 50px;
  background: #f0e0f0;
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
  bottom: 0;
  width: 2px;
  background: purple;
  transform: translateX(-50%);
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
</style>
