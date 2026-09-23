import { computed, nextTick, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';
import {
  canvasVisualizerPadding,
  domVisualizerPadding,
  trackScrollMaxima,
} from 'src/components/tracker/visualizer-alignment';

/** The TrackerPattern instance as this composable reads it at runtime. */
interface TrackerPatternLike {
  tracksWrapperRef?: HTMLElement | null;
  $el?: unknown;
}

export interface TrackerScrollSyncOptions {
  trackerPatternRef: Ref<TrackerPatternLike | null>;
  /** PatternCanvas instance; its exposed elements are read via runtime shape. */
  patternCanvasRef: Ref<unknown>;
  patternTracksWrapper: Ref<HTMLElement | null>;
  patternAreaWrapperRef: Ref<HTMLElement | null>;
  visualizerRowRef: Ref<HTMLElement | null>;
  visualizerTracksRef: Ref<HTMLElement | null>;
  trackScrollbarRef: Ref<HTMLElement | null>;
  trackScrollbarWidth: Ref<number>;
  trackScrollbarInset: Ref<{ left: number; right: number }>;
  visualizerPadding: Ref<{ left: number; right: number }>;
  canvasRenderer: Readonly<Ref<boolean>>;
  canvasRendererFailed: Readonly<Ref<boolean>>;
  patternAreaScrollLeft: Readonly<Ref<number>>;
  waveformVisualizersVisible: Readonly<Ref<boolean>>;
}

/**
 * Keeps every horizontal view of the tracker tracks -- the pattern (DOM grid
 * or canvas), the waveform strip above it and the proxy scrollbar below -- on
 * one scroll position, and aligns the waveform strip with the pattern.
 *
 * Owns its DOM listeners and ResizeObserver, and tears them down on unmount.
 */
export function useTrackerScrollSync(options: TrackerScrollSyncOptions) {
  const {
    trackerPatternRef,
    patternCanvasRef,
    patternTracksWrapper,
    patternAreaWrapperRef,
    visualizerRowRef,
    visualizerTracksRef,
    trackScrollbarRef,
    trackScrollbarWidth,
    trackScrollbarInset,
    visualizerPadding,
    canvasRenderer,
    canvasRendererFailed,
    patternAreaScrollLeft,
    waveformVisualizersVisible,
  } = options;

  let teardownTrackScrollSync: (() => void) | null = null;
  let isSyncingTrackScroll = false;
  let trackScrollbarObserver: ResizeObserver | null = null;

  function resolvePatternTracksWrapper(): HTMLElement | null {
    // tracksWrapperRef is already unwrapped when exposed from child component
    return trackerPatternRef.value?.tracksWrapperRef ?? patternTracksWrapper.value ?? null;
  }

  // -----------------------------------------------------------------
  // Canvas renderer's exposed elements
  //
  // defineExpose unwraps refs at runtime, but the generated instance type
  // does not say so; these accessors speak the runtime shape directly.
  // -----------------------------------------------------------------

  function canvasScrollerEl(): HTMLElement | null {
    const exposed = patternCanvasRef.value as unknown as
      | { scrollerRef?: HTMLElement | null }
      | null;
    return exposed?.scrollerRef ?? null;
  }

  function canvasHScrollEl(): HTMLElement | null {
    const exposed = patternCanvasRef.value as unknown as
      | { hscrollRef?: HTMLElement | null }
      | null;
    return exposed?.hscrollRef ?? null;
  }

  /**
   * Element whose box is the bitmap's horizontal viewport, for waveform-row
   * measurement: the canvas's own hscroll proxy when it is shown (its width
   * accounts for the scroller's vertical scrollbar, so extents match), else
   * the scroller itself (pattern fits — nothing scrolls either way).
   */
  function canvasViewportEl(): HTMLElement | null {
    const hscroll = canvasHScrollEl();
    if (hscroll && hscroll.getBoundingClientRect().width > 0) return hscroll;
    return canvasScrollerEl();
  }

  function updateVisualizerPadding() {
    const rowEl = visualizerRowRef.value;
    if (!rowEl) return;

    const rowRect = rowEl.getBoundingClientRect();
    if (rowRect.width === 0) return;

    if (canvasRendererActive.value) {
      // The canvas renderer exposes its viewport element; its left edge is the
      // bitmap's row-number gutter and the tracks start GUTTER_WIDTH_PX into
      // the bitmap (see visualizer-alignment.ts for the arithmetic, shared
      // with its tests).
      const viewport = canvasViewportEl();
      if (!viewport) return;
      const viewportLeft = viewport.getBoundingClientRect().left;
      visualizerPadding.value = canvasVisualizerPadding(
        rowRect,
        viewportLeft,
        viewport.clientWidth,
      );
      return;
    }

    // DOM grid: measure against the DOM panel's border box, as before.
    const patternEl = (trackerPatternRef.value?.$el as HTMLElement | undefined) ?? null;
    if (!patternEl) return;
    const patternRect = patternEl.getBoundingClientRect();
    visualizerPadding.value = domVisualizerPadding(rowRect, patternRect);
  }

  /**
   * Measure the proxy scrollbar against the real one.
   *
   * Width 0 means the tracks fit and the bar hides itself; anything else is the
   * scroll width it has to reproduce. The insets put it under the tracks rather
   * than under the whole pattern panel, so it lines up with what it scrolls.
   */
  function measureTrackScrollbar() {
    const wrapper = resolvePatternTracksWrapper();
    const host = patternAreaWrapperRef.value;
    if (!wrapper || !host) {
      trackScrollbarWidth.value = 0;
      return;
    }

    // Sub-pixel layout leaves a fraction of overflow on exact fits.
    const overflows = wrapper.scrollWidth - wrapper.clientWidth > 1;
    trackScrollbarWidth.value = overflows ? wrapper.scrollWidth : 0;
    if (!overflows) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    trackScrollbarInset.value = {
      left: Math.max(0, wrapperRect.left - hostRect.left),
      right: Math.max(0, hostRect.right - wrapperRect.right),
    };
  }

  /**
   * Drive every horizontal view of the tracks from one scroll position: the real
   * scroller, the waveform strip above it, and the proxy scrollbar below.
   *
   * The guard is what keeps this from ringing -- assigning scrollLeft fires
   * `scroll` on the element assigned to, which would call straight back in.
   */
  function syncTrackScroll(scrollLeft: number) {
    const patternWrapper = resolvePatternTracksWrapper();
    // The canvas renderer has no DOM tracks wrapper -- it paints the tracks
    // into a bitmap and drives horizontal position from its own hscroll proxy.
    // Requiring the wrapper here made this whole function a no-op under the
    // canvas, so the waveform strip never followed a horizontal scroll.
    const canvasHScroll = canvasRendererActive.value ? canvasHScrollEl() : null;
    const maxScroll = trackScrollMaxima(patternWrapper, canvasHScroll);
    if (maxScroll === null) return;

    patternTracksWrapper.value = patternWrapper;
    const clamped = Math.min(scrollLeft, maxScroll);

    if (isSyncingTrackScroll) return;
    isSyncingTrackScroll = true;

    if (patternWrapper && patternWrapper.scrollLeft !== clamped) {
      patternWrapper.scrollLeft = clamped;
    }

    // Writing this back matters only when the value was clamped; the guard
    // above absorbs the scroll event it fires.
    if (canvasHScroll && canvasHScroll.scrollLeft !== clamped) {
      canvasHScroll.scrollLeft = clamped;
    }

    const visualizer = visualizerTracksRef.value;
    if (visualizer && visualizer.scrollLeft !== clamped) {
      visualizer.scrollLeft = clamped;
    }

    const scrollbar = trackScrollbarRef.value;
    if (scrollbar && scrollbar.scrollLeft !== clamped) {
      scrollbar.scrollLeft = clamped;
    }

    requestAnimationFrame(() => {
      isSyncingTrackScroll = false;
    });
  }

  /** Canvas renderer mounted (and not in its failed-to-DOM-fallback state). */
  const canvasRendererActive = computed(
    () => canvasRenderer.value && !canvasRendererFailed.value,
  );

  function refreshVisualizerAlignment() {
    if (!waveformVisualizersVisible.value) {
      visualizerPadding.value = { left: 18, right: 18 };
      // Re-wire rather than tear down: the waveform strip is gone but the proxy
      // scrollbar is not, and it shares this sync.
      void nextTick(() => setupTrackScrollSync());
      return;
    }
    void nextTick(() => {
      updateVisualizerPadding();
      setupTrackScrollSync();
    });
  }

  function setupTrackScrollSync() {
    teardownTrackScrollSync?.();

    const patternWrapper = resolvePatternTracksWrapper();
    const visualizer = visualizerTracksRef.value;
    const scrollbar = trackScrollbarRef.value;
    patternTracksWrapper.value = patternWrapper;

    if (canvasRendererActive.value) {
      // The canvas owns horizontal scrolling through its hscroll proxy (or is
      // unscrollable when the pattern fits). Sync the waveform strip and the
      // proxy bar from the canvas's reported scroll position.
      const source = canvasHScrollEl();
      const handleCanvasScroll = () => {
        const el = canvasHScrollEl();
        if (el) syncTrackScroll(el.scrollLeft);
      };
      if (source) {
        source.addEventListener('scroll', handleCanvasScroll, { passive: true });
      }
      teardownTrackScrollSync = () => {
        source?.removeEventListener('scroll', handleCanvasScroll);
        trackScrollbarObserver?.disconnect();
        trackScrollbarObserver = null;
      };
      syncTrackScroll(patternAreaScrollLeft.value);
      return;
    }

    if (!patternWrapper) return;

    const handlePatternScroll = () => syncTrackScroll(patternWrapper.scrollLeft);
    const handleVisualizerScroll = () =>
      syncTrackScroll(visualizer!.scrollLeft);
    const handleScrollbarScroll = () => syncTrackScroll(scrollbar!.scrollLeft);

    patternWrapper.addEventListener('scroll', handlePatternScroll, {
      passive: true,
    });
    visualizer?.addEventListener('scroll', handleVisualizerScroll, {
      passive: true,
    });
    scrollbar?.addEventListener('scroll', handleScrollbarScroll, {
      passive: true,
    });

    // The tracks change width with the channel count and the window, and neither
    // fires a scroll event, so the bar has to be re-measured on resize.
    trackScrollbarObserver?.disconnect();
    trackScrollbarObserver = new ResizeObserver(() => measureTrackScrollbar());
    trackScrollbarObserver.observe(patternWrapper);

    teardownTrackScrollSync = () => {
      patternWrapper.removeEventListener('scroll', handlePatternScroll);
      visualizer?.removeEventListener('scroll', handleVisualizerScroll);
      scrollbar?.removeEventListener('scroll', handleScrollbarScroll);
      trackScrollbarObserver?.disconnect();
      trackScrollbarObserver = null;
    };

    measureTrackScrollbar();
    syncTrackScroll(patternWrapper.scrollLeft);
  }

  onBeforeUnmount(() => {
    teardownTrackScrollSync?.();
  });

  return {
    canvasRendererActive,
    resolvePatternTracksWrapper,
    syncTrackScroll,
    refreshVisualizerAlignment,
  };
}
