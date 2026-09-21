import { defineComponent, h, watch } from 'vue';

/**
 * A stand-in for `PatternCanvas` that records what the host hands it. The
 * real component's paint is pixels a jsdom run can not see; what a host owns
 * is the props it passes and how often the `tracks` prop (which the real one
 * repaints its static bitmap for) changes identity.
 */
export const stubLog = { trackChanges: 0 };

export const PatternCanvasStub = defineComponent({
  name: 'PatternCanvasStub',
  props: {
    tracks: { type: Array, default: () => [] },
    rows: { type: Number, default: 0 },
    selectedRow: { type: Number, default: -1 },
    playbackRow: { type: Number, default: -1 },
    activeTrack: { type: Number, default: -1 },
    activeColumn: { type: Number, default: -1 },
    activeMacroNibble: { type: Number, default: 0 },
    selectionRect: { type: Object, default: null },
    autoScroll: { type: Boolean, default: false },
    isPlaying: { type: Boolean, default: false },
    playbackMode: { type: String, default: 'pattern' },
    // The real component's default; a host that wants no trail must say so.
    showTrail: { type: Boolean, default: true },
    scrollTop: { type: Number, default: 0 },
    containerWidth: { type: Number, default: 0 },
    containerHeight: { type: Number, default: 0 },
    isMouseSelecting: { type: Boolean, default: false },
    showExtraEffectColumn: { type: Boolean, default: false },
    reserveSideGutter: { type: Boolean, default: false },
  },
  emits: ['rowSelected', 'cellSelected', 'scroll', 'rendererError'],
  setup(props) {
    watch(
      () => props.tracks,
      () => {
        stubLog.trackChanges++;
      },
    );
    return () => h('div', { 'data-testid': 'pattern-canvas-stub' });
  },
});
