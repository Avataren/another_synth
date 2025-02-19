<!-- MasterTimeline.vue -->
<template>
  <div class="master-timeline q-my-md">
    <div class="text-subtitle2">Master Timeline</div>
    <div class="timeline" ref="timeline" @mousedown="handleTimelineMouseDown">
      <div class="timeline-bar"></div>
      <div
        class="timeline-scrubber"
        :style="{ left: scrubberPosition }"
        @mousedown.stop="startScrubbing"
      ></div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'MasterTimeline',
  props: {
    scrubPosition: {
      type: Number,
      required: true,
    },
  },

  emits: ['update:scrub-position'],

  data() {
    return {
      timelineRect: null,
      isScrubbing: false,
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
    window.addEventListener('resize', this.handleResize);
  },

  beforeUnmount() {
    window.removeEventListener('resize', this.handleResize);
  },

  methods: {
    updateTimelineLayout() {
      if (!this.$refs.timeline) return;
      this.timelineRect = this.$refs.timeline.getBoundingClientRect();
    },

    handleResize() {
      requestAnimationFrame(() => {
        this.updateTimelineLayout();
      });
    },

    handleTimelineMouseDown(event) {
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

      this.$emit('update:scrub-position', newPosition);
    },
  },
};
</script>

<style scoped>
.timeline {
  position: relative;
  height: 50px;
  background: #2d2d2d;
  margin: 20px;
  padding: 0 20px;
  cursor: pointer;
  border: 1px solid #444;
  border-radius: 4px;
  box-sizing: border-box;
}

.timeline-bar {
  position: absolute;
  top: 50%;
  left: 20px;
  right: 20px;
  height: 4px;
  background: #444;
  transform: translateY(-50%);
}

.timeline-scrubber {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #fff;
  transform: translateX(-50%);
  z-index: 2;
}
</style>
