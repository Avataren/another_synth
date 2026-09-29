<template>
  <div class="tracker-font-preview">
    <canvas
      ref="canvasRef"
      class="tracker-font-preview-canvas"
      role="img"
      :aria-label="`Tracker pattern preview in ${fontId}`"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  drawActiveRowBar,
  drawCursorCell,
  drawRowNumbers,
  drawStaticGrid,
} from 'src/components/tracker/pattern-canvas/pattern-draw';
import {
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowY,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import {
  resolveVars,
  type PatternTheme,
} from 'src/components/tracker/pattern-canvas/pattern-theme';
import {
  PREVIEW_CURSOR,
  PREVIEW_LAYOUT,
  PREVIEW_PLAYBACK_ROW,
  PREVIEW_TRACKS,
} from './tracker-font-preview-data';

interface Props {
  /** Font family name, as `--font-tracker` would carry it. */
  fontId: string;
}

const props = defineProps<Props>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

/** Everything left of the tracks (the row-number gutter) plus the tracks. */
const CONTENT_WIDTH_PX =
  GUTTER_WIDTH_PX + totalTracksWidth(PREVIEW_LAYOUT.trackCount, PREVIEW_LAYOUT.columns);
/** Room for the playback bar's 3px border beyond the last row. */
const EDGE_PX = 2;
const CONTENT_HEIGHT_PX = rowY(PREVIEW_LAYOUT.rowCount - 1) + rowHeightPx;

/**
 * The live theme's palette with the font under preview swapped in. Read fresh
 * on every paint: the preview is shown while the user is choosing, so a theme
 * change in the section above has to show up here without a reload.
 */
function previewTheme(): PatternTheme {
  return { ...resolveVars(), fontTracker: `'${props.fontId}', monospace` };
}

function paint(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = CONTENT_WIDTH_PX + EDGE_PX * 2;
  const height = CONTENT_HEIGHT_PX + EDGE_PX * 2;
  const bitmapWidth = Math.round(width * dpr);
  const bitmapHeight = Math.round(height * dpr);
  // Resizing clears the canvas; only do it when the density actually changed.
  if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
    canvas.width = bitmapWidth;
    canvas.height = bitmapHeight;
  }
  canvas.style.aspectRatio = `${width} / ${height}`;
  canvas.style.maxWidth = `${width}px`;

  const theme = previewTheme();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.panelBackground;
  ctx.fillRect(0, 0, width, height);

  // Gutter, then the tracks shifted right of it: the draw ops place tracks at
  // x = 0, exactly as PatternCanvas's own bitmap does.
  ctx.save();
  ctx.translate(EDGE_PX, EDGE_PX);
  drawRowNumbers(ctx, PREVIEW_LAYOUT, theme);
  ctx.translate(GUTTER_WIDTH_PX, 0);
  drawStaticGrid(ctx, PREVIEW_LAYOUT, theme, { tracks: PREVIEW_TRACKS });
  drawActiveRowBar(ctx, PREVIEW_LAYOUT, theme, {
    playbackRow: PREVIEW_PLAYBACK_ROW,
    mode: 'pattern',
  });
  drawCursorCell(ctx, PREVIEW_LAYOUT, PREVIEW_TRACKS, theme, PREVIEW_CURSOR);
  ctx.restore();
}

/**
 * A canvas can only draw a font that has already loaded (it does not wait, and
 * does not redraw when one arrives), so ask for both weights the pattern uses
 * and repaint once they are in. The immediate paint keeps the preview from
 * flashing empty; it is redrawn in the real face a moment later.
 */
let requestedFont = '';
async function paintWhenFontReady(): Promise<void> {
  paint();
  const fontId = props.fontId;
  requestedFont = fontId;
  if (!document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`12px '${fontId}'`),
      document.fonts.load(`700 12px '${fontId}'`),
    ]);
  } catch {
    return; // Offline: the fallback stack is what will be used.
  }
  if (requestedFont === fontId) paint();
}

let themeObserver: MutationObserver | null = null;

/**
 * The font's stylesheet arrives after the first `load()` above can see it (the
 * face is not registered until the CSS is parsed), so `load()` may resolve
 * with nothing. The picker cards and header use the same face, which makes the
 * browser fetch it; repaint when any font finishes.
 */
function onFontsLoaded(): void {
  paint();
}

onMounted(() => {
  void paintWhenFontReady();
  document.fonts?.addEventListener('loadingdone', onFontsLoaded);
  // Theme flips rewrite CSS custom properties on <html>.
  themeObserver = new MutationObserver(() => paint());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
});

onBeforeUnmount(() => {
  document.fonts?.removeEventListener('loadingdone', onFontsLoaded);
  themeObserver?.disconnect();
  themeObserver = null;
});

watch(
  () => props.fontId,
  () => void paintWhenFontReady(),
);
</script>

<style scoped>
.tracker-font-preview {
  display: flex;
  justify-content: center;
  padding: 14px;
  background: var(--panel-background, #0a0e16);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  overflow: hidden;
}

.tracker-font-preview-canvas {
  display: block;
  width: 100%;
  height: auto;
}
</style>
