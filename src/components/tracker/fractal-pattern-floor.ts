import type { TrackerEntryData } from 'src/components/tracker/tracker-types';
import { formatEntryCells } from 'src/components/tracker/pattern-canvas/format-entry-cells';

/**
 * The playing pattern, drawn on the Fractal view's floor: every channel across,
 * the rows running toward the camera, the playing row at z = 0. The pattern is
 * drawn into a 2D canvas (a window of rows around the playhead), uploaded as a
 * mipmapped texture, and sampled by `floorColor` in fractal-shader.ts.
 */

/** Rows in the window: the playhead's row, and half of this many on either side. */
export const FLOOR_WINDOW_ROWS = 48;
/** Characters per channel: `C-4 01 40 000` and a gap. */
const CHARS_PER_CELL = 13;
const MAX_TEXTURE_WIDTH = 4096;
const MIN_GLYPH_WIDTH = 6;
const MAX_GLYPH_WIDTH = 12;
/** World width the pattern aims to fill (squares of the checkerboard are 1 across), and the widest a glyph is made (a square of the checkerboard is 1). */
const TARGET_WIDTH = 20;
const MAX_GLYPH_WORLD = 0.24;
/** The playhead may jump this far before the scroll snaps instead of gliding. */
const SNAP_ROWS = 3;
/** How often the texture is redrawn without the row moving, so edits show up. */
const REFRESH_MS = 500;

const COLOR_NOTE = '#e8f4ff';
const COLOR_INSTRUMENT = '#ffd166';
const COLOR_VOLUME = '#6ee7a0';
const COLOR_EFFECT = '#ff7ad9';
const COLOR_EMPTY = '#1f2a44';
const COLOR_EMPTY_BEAT = '#34436c';

export interface PatternFloorView {
  tracks: ReadonlyArray<{ entries: ReadonlyArray<TrackerEntryData> }>;
  /** The playing row. */
  row: number;
  /** The pattern's length in rows. */
  rows: number;
}

export interface PatternFloorLayout {
  /** Channels drawn (the rest are clipped). */
  tracks: number;
  /** Texture pixels per character, across and down. */
  glyphWidth: number;
  glyphHeight: number;
  textureWidth: number;
  textureHeight: number;
  /** World size of the pattern: half its width, and one row's depth. */
  halfWidth: number;
  rowHeight: number;
}

/** How a pattern of `trackCount` channels is laid out on the texture and on the floor. */
export function floorPatternLayout(trackCount: number): PatternFloorLayout {
  const total = Math.max(1, trackCount);
  const fit = Math.floor(MAX_TEXTURE_WIDTH / (total * CHARS_PER_CELL) / 2) * 2;
  const glyphWidth = Math.max(MIN_GLYPH_WIDTH, Math.min(MAX_GLYPH_WIDTH, fit));
  const tracks = Math.max(
    1,
    Math.min(total, Math.floor(MAX_TEXTURE_WIDTH / (glyphWidth * CHARS_PER_CELL))),
  );
  const chars = tracks * CHARS_PER_CELL;
  const glyphWorld = Math.min(MAX_GLYPH_WORLD, TARGET_WIDTH / chars);
  return {
    tracks,
    glyphWidth,
    glyphHeight: glyphWidth * 2,
    textureWidth: chars * glyphWidth,
    textureHeight: FLOOR_WINDOW_ROWS * glyphWidth * 2,
    halfWidth: (chars * glyphWorld) / 2,
    rowHeight: glyphWorld * 2,
  };
}

/** The first row of the window that is centred on `row`. */
export function windowBase(row: number): number {
  return Math.floor(row) - FLOOR_WINDOW_ROWS / 2;
}

function hasEntry(entry: TrackerEntryData): boolean {
  return Boolean(
    entry.note || entry.instrument || entry.volume || entry.macro,
  );
}

/** The 2D canvas, its GL texture, and the scroll that goes with them. */
export class FloorPatternTexture {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: WebGLTexture | null;
  private layout: PatternFloorLayout = floorPatternLayout(1);
  private allocatedWidth = 0;
  private allocatedHeight = 0;
  private drawnBase = Number.NaN;
  private drawnTracks: PatternFloorView['tracks'] | null = null;
  private drawnAt = -Infinity;
  private shown = 0;
  private lastMs = 0;
  private active = false;
  private anisotropy: EXT_texture_filter_anisotropic | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = gl.createTexture();
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
  }

  /** World half-width (0 when there is nothing to show) and row depth, for the shader. */
  get halfWidth(): number {
    return this.active ? this.layout.halfWidth : 0;
  }

  get rowHeight(): number {
    return this.layout.rowHeight;
  }

  /** Where the playhead sits in the window, in rows from its top, plus a half (rows are centred on their texels). */
  get offset(): number {
    return this.shown - windowBase(this.shown) + 0.5;
  }

  /**
   * Eases the scroll to the playhead, and redraws and uploads the window when it
   * has moved to a new row (or the pattern changed, or a moment has passed).
   */
  update(
    gl: WebGL2RenderingContext,
    view: PatternFloorView | null | undefined,
    timeMs: number,
  ): void {
    const dt = Math.min(0.1, Math.max(0, (timeMs - this.lastMs) / 1000));
    this.lastMs = timeMs;
    if (!view || !this.ctx || !this.texture || view.tracks.length === 0) {
      this.active = false;
      return;
    }
    const changed = view.tracks !== this.drawnTracks;
    if (!this.active || changed || Math.abs(view.row - this.shown) > SNAP_ROWS) {
      this.shown = view.row;
    } else {
      this.shown += (view.row - this.shown) * (1 - Math.exp(-dt * 20));
    }
    this.active = true;
    const base = windowBase(this.shown);
    if (
      base === this.drawnBase &&
      !changed &&
      timeMs - this.drawnAt < REFRESH_MS
    )
      return;
    this.draw(view, base);
    this.upload(gl);
    this.drawnBase = base;
    this.drawnTracks = view.tracks;
    this.drawnAt = timeMs;
  }

  bind(gl: WebGL2RenderingContext, unit: number): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture) gl.deleteTexture(this.texture);
  }

  private draw(view: PatternFloorView, base: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const layout = floorPatternLayout(view.tracks.length);
    this.layout = layout;
    const { glyphWidth: gw, glyphHeight: gh } = layout;
    if (
      this.canvas.width !== layout.textureWidth ||
      this.canvas.height !== layout.textureHeight
    ) {
      this.canvas.width = layout.textureWidth;
      this.canvas.height = layout.textureHeight;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // A monospace font sized so one character advances exactly one glyph cell.
    ctx.font = '700 100px monospace';
    const advance = ctx.measureText('M').width / 100;
    ctx.font = `700 ${gw / Math.max(advance, 0.1)}px monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const text = (s: string, col: number, y: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.fillText(s, col * gw, y);
    };
    const byRow = new Map<number, TrackerEntryData>();
    for (let t = 0; t < layout.tracks; t++) {
      const x0 = t * CHARS_PER_CELL;
      byRow.clear();
      for (const entry of view.tracks[t]?.entries ?? []) {
        if (entry.row >= base && entry.row < base + FLOOR_WINDOW_ROWS)
          byRow.set(entry.row, entry);
      }
      for (let i = 0; i < FLOOR_WINDOW_ROWS; i++) {
        const row = base + i;
        if (row < 0 || row >= view.rows) continue;
        const y = (i + 0.5) * gh;
        const entry = byRow.get(row);
        if (!entry || !hasEntry(entry)) {
          text(
            '--- .. .. ...',
            x0,
            y,
            row % 4 === 0 ? COLOR_EMPTY_BEAT : COLOR_EMPTY,
          );
          continue;
        }
        const cells = formatEntryCells(entry);
        text(cells.note.display, x0, y, COLOR_NOTE);
        text(cells.instrument.display, x0 + 4, y, COLOR_INSTRUMENT);
        text(cells.volumeHi.display + cells.volumeLo.display, x0 + 7, y, COLOR_VOLUME);
        text(cells.macroDigits.join(''), x0 + 10, y, COLOR_EFFECT);
      }
    }
  }

  private upload(gl: WebGL2RenderingContext): void {
    const { texture } = this;
    if (!texture) return;
    const { width, height } = this.canvas;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (width !== this.allocatedWidth || height !== this.allocatedHeight) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.canvas,
      );
      this.allocatedWidth = width;
      this.allocatedHeight = height;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.anisotropy) {
        const max = gl.getParameter(
          this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
        ) as number;
        gl.texParameterf(
          gl.TEXTURE_2D,
          this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, max),
        );
      }
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
  }
}
