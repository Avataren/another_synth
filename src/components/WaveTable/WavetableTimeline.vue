<template>
  <div
    class="timeline"
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
      :key="index"
      class="keyframe-marker"
      :class="{ selected: index === selectedKeyframe }"
      :style="{ left: getKeyframePosition(keyframe.time) }"
      @mousedown.stop="startDrag($event, index)"
      @click.stop="handleKeyframeClick($event, index)"
      @contextmenu.prevent.stop="showKeyframeMenu($event, index)"
    >
      <q-icon
        name="fiber_manual_record"
        size="24px"
        :color="index === selectedKeyframe ? 'red' : 'blue'"
      />
    </div>

    <q-menu v-model="showMenu" :position="menuPosition" context-menu>
      <q-list dense>
        <q-item clickable v-close-popup @click="addKeyframeAtPosition">
          <q-item-section>Add Keyframe</q-item-section>
        </q-item>
        <q-item
          clickable
          v-close-popup
          @click="handleRemoveKeyframe"
          :disable="keyframes.length <= 1"
        >
          <q-item-section>Remove Keyframe</q-item-section>
        </q-item>
      </q-list>
    </q-menu>
  </div>
</template>

<script>
export default {
  name: 'WavetableTimeline',
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
  },
  emits: [
    'update:scrub',
    'update:selected',
    'update:keyframes',
    'update:morph',
    'add-keyframe',
    'remove-keyframe',
  ],

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
    handleTimelineMouseDown(event) {
      const isKeyframeClick = event.target.closest('.keyframe-marker');
      if (isKeyframeClick) return;

      event.preventDefault();
      this.isScrubbing = true;
      this.updateScrubPosition(event);

      document.addEventListener('mousemove', this.onScrub);
      document.addEventListener('mouseup', this.stopScrubbing);
    },

    showContextMenu(event) {
      if (!this.timelineRect) {
        this.updateTimelineLayout();
      }
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
      this.handleKeyframeClick(event, index);
      this.menuPosition = {
        left: event.clientX + 'px',
        top: event.clientY + 'px',
      };
      this.showMenu = true;
    },

    handleKeyframeClick(event, index) {
      if (!this.isDragging) {
        this.$emit('update:selected', index);
      }
    },

    addKeyframeAtPosition() {
      if (this.keyframes.length === 0) {
        this.$emit('add-keyframe', 0);
        return;
      }

      this.$emit('add-keyframe', this.contextMenuTargetTime);
    },

    handleRemoveKeyframe() {
      if (this.keyframes.length <= 1) return;
      this.$emit('remove-keyframe');
    },

    updateTimelineLayout() {
      if (!this.$refs.timeline) return;
      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
    },

    handleResize() {
      requestAnimationFrame(() => {
        this.updateTimelineLayout();
      });
    },

    getKeyframePosition(time) {
      if (!this.timelineRect || this.timelineRect.width === 0) {
        requestAnimationFrame(() => {
          this.updateTimelineLayout();
        });
        return '0px';
      }
      const availableWidth = this.timelineRect.width - 40;
      return `${(time / 100) * availableWidth + 20}px`;
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

      // Calculate morph amount based on position
      const morphAmount = this.calculateMorphAmount(newPosition);

      this.$emit('update:scrub', newPosition);
      this.$emit('update:morph', morphAmount);
    },

    calculateMorphAmount(position) {
      if (this.keyframes.length < 2) return 0;

      // Find the appropriate keyframe indices based on position
      let currentIndex = 0;
      for (let i = 0; i < this.keyframes.length - 1; i++) {
        if (
          position >= this.keyframes[i].time &&
          position <= this.keyframes[i + 1].time
        ) {
          currentIndex = i;
          break;
        }
      }

      // Handle edge cases
      if (position >= this.keyframes[this.keyframes.length - 1].time) {
        this.$emit('update:selected', this.keyframes.length - 1);
        return 0;
      }

      if (position <= this.keyframes[0].time) {
        this.$emit('update:selected', 0);
        return 0;
      }

      const current = this.keyframes[currentIndex];
      const next = this.keyframes[currentIndex + 1];

      const range = next.time - current.time;
      if (range === 0) return 0;

      const amount = (position - current.time) / range;

      if (this.selectedKeyframe !== currentIndex) {
        this.$emit('update:selected', currentIndex);
      }

      return Math.max(0, Math.min(1, amount));
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

      // Create a copy of the keyframes array
      const updatedKeyframes = [...this.keyframes];

      // Update the dragged keyframe's time
      const draggedKeyframe = {
        ...updatedKeyframes[this.dragIndex],
        time: newTime,
      };

      // Remove the keyframe from its current position
      updatedKeyframes.splice(this.dragIndex, 1);

      // Find the correct position to insert the keyframe
      let insertIndex = 0;
      while (
        insertIndex < updatedKeyframes.length &&
        updatedKeyframes[insertIndex].time < newTime
      ) {
        insertIndex++;
      }

      // Insert the keyframe at its new position
      updatedKeyframes.splice(insertIndex, 0, draggedKeyframe);

      // Emit the updates
      this.$emit('update:keyframes', updatedKeyframes);
      this.$emit('update:selected', insertIndex);
    },

    stopDrag() {
      this.isDragging = false;
      this.dragIndex = null;
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
  width: calc(100% - 40px);
}

.timeline-bar {
  position: absolute;
  top: 50%;
  left: 20px;
  right: 20px;
  height: 4px;
  background: #ccc;
  transform: translateY(-50%);
  width: calc(100% - 40px);
}

.timeline-scrubber {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: red;
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
