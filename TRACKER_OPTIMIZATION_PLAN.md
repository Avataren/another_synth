# Tracker Page Performance Optimization Plan

## Executive Summary

The tracker page has **18 identified performance bottlenecks** across 6 component files. The main issues fall into 5 categories:
1. Reactive data flow issues causing cascading re-renders
2. Inefficient list rendering with 512+ DOM entries
3. Canvas/visualization performance problems (multiple RAF loops)
4. Unoptimized watch handlers and event listeners
5. Expensive computed properties recalculated unnecessarily

---

## Phase 1: Critical Fixes (Immediate Impact)

### 1.1 Fix Deep Watch on `instrumentSlots`
**File:** `TrackerPage.vue` (Lines 1071-1083)
**Severity:** HIGH

**Current Problem:**
```typescript
watch(
  () => instrumentSlots.value,
  async () => {
    await songBank.ensureAudioContextRunning();
    await syncSongBankFromSlots();
    updateTrackAudioNodes();
    void initializePlayback(playbackMode.value);
    void measureVisualizerLayout();
  },
  { deep: true }  // ❌ Triggers on ANY nested change
);
```

**Solution:**
```typescript
// Watch only the properties that matter for audio sync
const slotSignatures = computed(() =>
  instrumentSlots.value.map(s => `${s.slot}:${s.patchId ?? ''}:${s.bankId ?? ''}`).join('|')
);

watch(slotSignatures, async () => {
  await songBank.ensureAudioContextRunning();
  await syncSongBankFromSlots();
  updateTrackAudioNodes();
  void initializePlayback(playbackMode.value);
  void measureVisualizerLayout();
});
```

**Impact:** Prevents unnecessary audio system rebuilds when editing instrument names.

---

### 1.2 Cache Theme Colors in Spectrum Analyzer
**File:** `TrackerSpectrumAnalyzer.vue` (Line 106)
**Severity:** HIGH

**Current Problem:**
```typescript
const draw = () => {
  // ...
  const colors = getThemeColors(); // ❌ Calls getComputedStyle 60+ times/sec
  // ...
};
```

**Solution:**
```typescript
// Cache colors outside animation loop
let cachedColors = getThemeColors();

// Update only when theme changes
const themeObserver = new MutationObserver(() => {
  cachedColors = getThemeColors();
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['style']
});

const draw = () => {
  // ...
  const colors = cachedColors; // ✅ Use cached colors
  // ...
};

onUnmounted(() => themeObserver.disconnect());
```

**Impact:** Eliminates 60+ `getComputedStyle()` calls per second during playback.

---

### 1.3 Fix Entry Lookup Recreation in TrackerTrack
**File:** `TrackerTrack.vue` (Lines 53-61)
**Severity:** HIGH

**Current Problem:**
```typescript
const entryLookup = computed<Record<number, TrackerEntryData | undefined>>(() => {
  const lookup: Record<number, TrackerEntryData | undefined> = {};
  for (const entry of props.track.entries) {
    lookup[entry.row] = entry;
  }
  return lookup; // ❌ New object every time
});
```

**Solution:**
```typescript
// Use a stable Map that updates incrementally
const entryLookup = shallowRef(new Map<number, TrackerEntryData>());

watch(
  () => props.track.entries,
  (entries) => {
    const newLookup = new Map<number, TrackerEntryData>();
    for (const entry of entries) {
      if (entry.row >= 0 && entry.row < props.rowCount) {
        newLookup.set(entry.row, entry);
      }
    }
    entryLookup.value = newLookup;
  },
  { immediate: true }
);
```

**Impact:** Prevents 512+ object recreations per render.

---

## Phase 2: List Rendering Optimization

### 2.1 Implement Virtual Scrolling for Pattern Grid
**Files:** `TrackerPattern.vue`, `TrackerTrack.vue`
**Severity:** HIGH

**Current Problem:**
- All 64-256 rows rendered simultaneously
- Each row has 8+ tracks = 512-2048 TrackerEntry components in DOM
- No virtualization despite scrollable container

**Solution Options:**

**Option A: Use vue-virtual-scroller**
```typescript
import { RecycleScroller } from 'vue-virtual-scroller';

<RecycleScroller
  :items="rowsList"
  :item-size="rowHeightPx + rowGapPx"
  key-field="id"
  v-slot="{ item: rowIndex }"
>
  <div class="tracker-row">
    <TrackerEntry v-for="track in tracks" ... />
  </div>
</RecycleScroller>
```

**Option B: Custom Virtual Scroll (lighter weight)**
```typescript
const visibleRange = computed(() => {
  const scrollTop = scrollPosition.value;
  const viewportHeight = containerHeight.value;
  const rowHeight = rowHeightPx + rowGapPx;

  const startRow = Math.floor(scrollTop / rowHeight);
  const endRow = Math.min(
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + 1,
    props.rows
  );

  return { startRow, endRow };
});

const visibleRows = computed(() =>
  rowsList.value.slice(visibleRange.value.startRow, visibleRange.value.endRow)
);
```

**Impact:** Reduces DOM nodes from 512+ to ~50-80 (visible rows only).

---

### 2.2 Optimize TrackerEntry Computed Properties
**File:** `TrackerEntry.vue` (Lines 86-129)
**Severity:** MEDIUM

**Current Problem:**
```typescript
// Creates new objects on every render
const entryClasses = computed(() => {
  const classes: Record<string, boolean> = { ... };
  // Modulo operations for row styling
  return classes;
});

const cells = computed(() => {
  // String operations: trim, uppercase, split, slice
  return { ... };
});
```

**Solution:**
```typescript
// Pre-compute row type based on index (stable)
const rowType = computed(() => {
  const idx = props.rowIndex;
  if (idx % 16 === 0) return 'bar';
  if (idx % 4 === 0) return 'beat';
  if (idx % 2 === 0) return 'sub';
  return 'normal';
});

// Simpler class binding
const entryClasses = computed(() => ({
  active: props.active,
  filled: !!props.entry,
  selected: props.selected,
  [`row-${rowType.value}`]: !props.active && !props.selected
}));

// Memoize cell processing
const cells = computed(() => {
  if (!props.entry) return DEFAULT_CELLS;
  return processCells(props.entry); // Extract to pure function
});
```

**Impact:** Reduces computation per entry by ~60%.

---

## Phase 3: Canvas/Visualization Optimization

### 3.1 Consolidate Waveform Animation Loops
**File:** `TrackWaveform.vue`
**Severity:** MEDIUM-HIGH

**Current Problem:**
- Each TrackWaveform has its own `requestAnimationFrame` loop
- 8 tracks = 8 independent RAF callbacks
- Each calls `getBoundingClientRect()` every frame

**Solution: Shared Animation Controller**
```typescript
// Create shared animation manager (new file: useAnimationLoop.ts)
const animationCallbacks = new Set<(time: number) => void>();
let animationId: number | null = null;

function startLoop() {
  if (animationId !== null) return;

  const loop = (time: number) => {
    for (const callback of animationCallbacks) {
      callback(time);
    }
    animationId = requestAnimationFrame(loop);
  };
  animationId = requestAnimationFrame(loop);
}

export function useAnimationLoop(callback: (time: number) => void) {
  onMounted(() => {
    animationCallbacks.add(callback);
    startLoop();
  });

  onUnmounted(() => {
    animationCallbacks.delete(callback);
    if (animationCallbacks.size === 0 && animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
  });
}
```

**Impact:** Reduces RAF callbacks from 8+ to 1.

---

### 3.2 Throttle Canvas Resize Checks
**Files:** `TrackWaveform.vue`, `TrackerSpectrumAnalyzer.vue`
**Severity:** MEDIUM

**Current Problem:**
```typescript
const draw = () => {
  const rect = canvas.getBoundingClientRect(); // ❌ Every frame
  if (canvas.width !== rect.width) { ... }
};
```

**Solution:**
```typescript
// Check resize only on window resize events
let canvasWidth = 0;
let canvasHeight = 0;

const updateCanvasSize = () => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width !== canvasWidth || rect.height !== canvasHeight) {
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
  }
};

// Throttled resize handler
const handleResize = throttle(updateCanvasSize, 100);
window.addEventListener('resize', handleResize);

const draw = () => {
  // Use cached dimensions
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  // ...
};
```

**Impact:** Eliminates `getBoundingClientRect()` calls during animation (480+ per second → 0).

---

### 3.3 Pre-calculate Spectrum Analyzer Gradients
**File:** `TrackerSpectrumAnalyzer.vue` (Lines 136-148)
**Severity:** MEDIUM

**Current Problem:**
```typescript
for (let i = 0; i < numBars; i++) {
  const gradient = ctx.createLinearGradient(...); // ❌ 128 gradients per frame
  gradient.addColorStop(0, ...);
  gradient.addColorStop(0.4, ...);
  gradient.addColorStop(1, ...);
}
```

**Solution:**
```typescript
// Pre-calculate gradient colors for each bar position
const barColors = computed(() => {
  const colors = cachedColors;
  return Array.from({ length: 128 }, (_, i) => {
    const t = i / 128;
    const r = Math.round(colors.primary.r * (1 - t) + colors.secondary.r * t);
    const g = Math.round(colors.primary.g * (1 - t) + colors.secondary.g * t);
    const b = Math.round(colors.primary.b * (1 - t) + colors.secondary.b * t);
    return { r, g, b };
  });
});

// In draw loop - use solid colors or cached gradients
const draw = () => {
  for (let i = 0; i < numBars; i++) {
    const { r, g, b } = barColors.value[i];
    const opacity = 0.15 + localSmoothed[i] * 0.35;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
    ctx.fillRect(x, y, barWidth, barHeight);
  }
};
```

**Impact:** Eliminates 7,680 gradient creations per second.

---

## Phase 4: Watch Handler Optimization

### 4.1 Debounce BPM Input
**File:** `TrackerPage.vue` (Lines 1048-1052)
**Severity:** MEDIUM

**Solution:**
```typescript
import { watchDebounced } from '@vueuse/core';

watchDebounced(
  () => currentSong.value.bpm,
  (bpm) => playbackEngine.setBpm(bpm),
  { debounce: 150, immediate: true }
);
```

---

### 4.2 Consolidate Scroll Watchers
**File:** `TrackerPattern.vue` (Lines 156-176)
**Severity:** MEDIUM

**Current Problem:** Two separate watchers for `playbackRow` and `selectedRow`

**Solution:**
```typescript
const scrollTarget = computed(() => {
  if (!props.autoScroll) return null;
  if (props.isPlaying) return props.playbackRow;
  return props.selectedRow;
});

watch(scrollTarget, (row) => {
  if (row === null || row === lastScrolledRow) return;
  lastScrolledRow = row;
  scrollToRow(row);
});
```

---

### 4.3 Convert isRowSelected to Computed Set
**File:** `TrackerTrack.vue` (Lines 71-75)
**Severity:** MEDIUM

**Current Problem:**
```typescript
function isRowSelected(row: number) {
  // Called 64+ times per track per render
  if (!props.selectionRect) return false;
  const { rowStart, rowEnd, trackStart, trackEnd } = props.selectionRect;
  return props.index >= trackStart && props.index <= trackEnd &&
         row >= rowStart && row <= rowEnd;
}
```

**Solution:**
```typescript
const selectedRows = computed(() => {
  if (!props.selectionRect) return new Set<number>();
  const { rowStart, rowEnd, trackStart, trackEnd } = props.selectionRect;

  if (props.index < trackStart || props.index > trackEnd) {
    return new Set<number>();
  }

  const rows = new Set<number>();
  for (let r = rowStart; r <= rowEnd; r++) {
    rows.add(r);
  }
  return rows;
});

// Usage: selectedRows.value.has(row) - O(1) lookup
```

**Impact:** Reduces 500+ function calls per render to 1 computed property.

---

## Phase 5: Event Handler Optimization

### 5.1 Throttle Keyboard Navigation
**File:** `TrackerPage.vue` (Line 8)
**Severity:** MEDIUM

**Solution:**
```typescript
import { throttle } from 'lodash-es';

const throttledKeyDown = throttle(onKeyDown, 50, { leading: true, trailing: true });

// In template
@keydown="throttledKeyDown"
```

---

### 5.2 Event Delegation for TrackerEntry Cells
**File:** `TrackerEntry.vue`
**Severity:** LOW-MEDIUM

**Current Problem:** 5 click handlers per entry × 512 entries = 2,560 listeners

**Solution:**
```typescript
// Single handler with data attributes
<div class="tracker-entry" @click="handleCellClick">
  <span data-cell="0">{{ cells.note.display }}</span>
  <span data-cell="1">{{ cells.instrument.display }}</span>
  ...
</div>

function handleCellClick(event: MouseEvent) {
  const cell = (event.target as HTMLElement).dataset.cell;
  if (cell !== undefined) {
    onSelectCell(parseInt(cell, 10));
  }
}
```

**Impact:** Reduces event listeners by ~80%.

---

## Implementation Priority

| Priority | Phase | Task | Estimated Effort | Impact |
|----------|-------|------|------------------|--------|
| 1 | 1.1 | Fix instrumentSlots watch | 1 hour | HIGH |
| 2 | 1.2 | Cache theme colors | 1 hour | HIGH |
| 3 | 1.3 | Fix entryLookup | 1 hour | HIGH |
| 4 | 3.2 | Throttle canvas resize | 2 hours | MEDIUM-HIGH |
| 5 | 2.1 | Virtual scrolling | 4-8 hours | HIGH |
| 6 | 3.1 | Shared animation loop | 3 hours | MEDIUM |
| 7 | 2.2 | Optimize TrackerEntry | 2 hours | MEDIUM |
| 8 | 3.3 | Pre-calc gradients | 1 hour | MEDIUM |
| 9 | 4.1-4.3 | Watch optimizations | 2 hours | MEDIUM |
| 10 | 5.1-5.2 | Event optimizations | 2 hours | LOW-MEDIUM |

---

## Expected Performance Improvements

After implementing all phases:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| DOM Nodes | 512+ | ~80 | 84% reduction |
| RAF Callbacks | 8+ | 1 | 87% reduction |
| Object allocations/render | 1000+ | ~100 | 90% reduction |
| getComputedStyle calls/sec | 60+ | 0 | 100% reduction |
| Event listeners | 2,500+ | ~500 | 80% reduction |
| Watch handler cascades | Frequent | Rare | Significant |

---

## Testing Recommendations

1. **Performance profiling before/after** using Chrome DevTools Performance tab
2. **Test with maximum pattern size** (256 rows × 32 tracks)
3. **Test during playback** with all visualizers enabled
4. **Test rapid keyboard navigation** (holding arrow keys)
5. **Test instrument slot editing** during playback
6. **Memory profiling** for leak detection over extended sessions
