import {
  GLOW_INSTANCE_FLOATS,
  parseCssColor,
  shiftHue,
  writeIndependentSegments,
  writeSegmentInstances,
  type GlowCell,
} from 'src/components/tracker/glow-scope-geometry';
import {
  BloomChain,
  RenderTarget,
  linkProgram as link,
  uniformLocations as locations,
} from 'src/components/tracker/glow-gl';
import {
  CRT_FRAGMENT_SHADER,
  CRT_VERTEX_SHADER,
  GLOW_FRAGMENT_SHADER,
  GLOW_VERTEX_SHADER,
  NEEDLE_FRAGMENT_SHADER,
  BARS_FRAGMENT_SHADER,
} from 'src/components/tracker/glow-scope-shader';

/** Stroke half-width and halo reach, in CSS pixels. */
const CORE_HALF_WIDTH = 1.4;
const GLOW_RADIUS = 9;
const GLOW_STRENGTH = 0.28;
/** Corner radius of a cell's CRT screen, CSS pixels (the DOM cell's is 8). */
const SCREEN_CORNER = 8;
const FALLBACK_COLOR: readonly [number, number, number] = [254 / 255, 65 / 255, 116 / 255];

export type RenderStyle = 'trace' | 'needles' | 'bars';

export interface GlowRenderCell extends GlowCell {
  /** The trace as x,y pairs in the cell's own CSS pixels (`scopePolyline`). */
  polyline: ArrayLike<number>;
  /** Points in `polyline`, or segments when `segments` is set. */
  count: number;
  /** `polyline` holds independent x0,y0,x1,y1 segments (needles, LEDs), not a chain. */
  segments?: boolean | undefined;
  /** Per-segment brightness multipliers, for `segments`. */
  weights?: ArrayLike<number> | undefined;
  /** How this cell is drawn; the options' style when omitted. */
  style?: RenderStyle | undefined;
}

export interface GlowRenderOptions {
  /** Device pixels per CSS pixel: the polylines are scaled by it. */
  pixelRatio: number;
  /** Run the CRT pass over each cell (needs the offscreen texture). */
  crt: boolean;
  /** Run the bloom post-process instead: blurred copies of the trace added back. */
  bloom?: boolean | undefined;
  /** How the bloom is mixed in; the default suits a thin line. */
  bloomStrength?: number | undefined;
  /** `needles` draws tapered vertical segments (Spikes) in two colours. */
  style?: RenderStyle | undefined;
  /** Half the height of an LED (`bars`), CSS pixels. */
  barHalfHeight?: number | undefined;
  /** Animation time, milliseconds. */
  timeMs: number;
  /** Halo reach (CSS pixels) and brightness; the subtle defaults when omitted. */
  glow?: { radius: number; strength: number } | undefined;
}

/** Whether a WebGL2 context can be made here at all. */
export function webgl2Available(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return document.createElement('canvas').getContext('webgl2') != null;
  } catch {
    return false;
  }
}

/** The second colour of the Spikes gradient: the scope colour, hue-rotated. */
export function readScopeColor2(): [number, number, number] {
  return shiftHue(readScopeColor(), -70);
}

/** The theme's scope colour, read from the root element. */
export function readScopeColor(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--tracker-accent-complement')
    .trim();
  return raw ? parseCssColor(raw, FALLBACK_COLOR) : [...FALLBACK_COLOR];
}

const BLOOM_STRENGTH = 1.1;
/** The halo the sharp pass keeps under a bloom: the bloom supplies the rest. */
const BLOOM_SHARP_GLOW = { radius: 4, strength: 0.12 };

/**
 * Draws scope traces with a glow, for any number of cells, into a canvas the
 * caller sizes. All the cells go out in one instanced draw; with `crt` the
 * traces are drawn into a texture first and a second pass dresses each cell
 * as a small CRT screen.
 */
export class GlowScopeRenderer {
  color: [number, number, number] = [...FALLBACK_COLOR];
  color2: [number, number, number] = shiftHue(FALLBACK_COLOR, -70);
  /** True once the context is gone; `render` then does nothing. */
  lost = false;

  private gl: WebGL2RenderingContext | null = null;
  private glowProgram: WebGLProgram | null = null;
  private needleProgram: WebGLProgram | null = null;
  private needleUniforms: Record<string, WebGLUniformLocation | null> = {};
  private barsProgram: WebGLProgram | null = null;
  private barsUniforms: Record<string, WebGLUniformLocation | null> = {};
  private crtProgram: WebGLProgram | null = null;
  private glowUniforms: Record<string, WebGLUniformLocation | null> = {};
  private crtUniforms: Record<string, WebGLUniformLocation | null> = {};
  private glowVao: WebGLVertexArrayObject | null = null;
  private crtVao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private instanceBuffer: WebGLBuffer | null = null;
  private cellBuffer: WebGLBuffer | null = null;
  private scene: RenderTarget | null = null;
  private bloomChain: BloomChain | null = null;
  private instanceData = new Float32Array(0);
  private cellRects = new Float32Array(0);

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.lost = !this.init();
  }

  get ok(): boolean {
    return this.gl != null && !this.lost;
  }

  private onLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
  };

  private onRestored = (): void => {
    this.release();
    this.lost = !this.init();
  };

  private init(): boolean {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) return false;
    try {
      this.glowProgram = link(gl, GLOW_VERTEX_SHADER, GLOW_FRAGMENT_SHADER);
      this.needleProgram = link(gl, GLOW_VERTEX_SHADER, NEEDLE_FRAGMENT_SHADER);
      this.barsProgram = link(gl, GLOW_VERTEX_SHADER, BARS_FRAGMENT_SHADER);
      this.crtProgram = link(gl, CRT_VERTEX_SHADER, CRT_FRAGMENT_SHADER);
    } catch (error) {
      console.error(error);
      return false;
    }
    this.glowUniforms = locations(gl, this.glowProgram, [
      'uResolution',
      'uPad',
      'uColor',
      'uCoreHalfWidth',
      'uGlowRadius',
      'uGlowStrength',
    ]);
    this.needleUniforms = locations(gl, this.needleProgram, [
      'uResolution',
      'uPad',
      'uColor',
      'uColor2',
      'uCoreHalfWidth',
      'uGlowRadius',
      'uGlowStrength',
    ]);
    this.barsUniforms = locations(gl, this.barsProgram, [
      'uResolution',
      'uPad',
      'uColor',
      'uCoreHalfWidth',
      'uGlowRadius',
      'uGlowStrength',
    ]);
    this.crtUniforms = locations(gl, this.crtProgram, [
      'uScene',
      'uResolution',
      'uColor',
      'uTime',
      'uRatio',
      'uCorner',
    ]);

    const buffer = (data?: Float32Array): WebGLBuffer => {
      const b = gl.createBuffer();
      if (!b) throw new Error('createBuffer failed');
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.buffers.push(b);
      return b;
    };

    // Trace segments: a unit quad (along, across) times an instance per segment.
    this.glowVao = gl.createVertexArray();
    gl.bindVertexArray(this.glowVao);
    buffer(new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuffer = buffer();
    const stride = GLOW_INSTANCE_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);

    // CRT screens: a 0..1 quad per cell.
    this.crtVao = gl.createVertexArray();
    gl.bindVertexArray(this.crtVao);
    buffer(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.cellBuffer = buffer();
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);

    this.scene = new RenderTarget(gl);
    this.bloomChain = new BloomChain(gl);

    gl.clearColor(0, 0, 0, 0);
    this.gl = gl;
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      for (const b of this.buffers) gl.deleteBuffer(b);
      if (this.glowVao) gl.deleteVertexArray(this.glowVao);
      if (this.crtVao) gl.deleteVertexArray(this.crtVao);
      if (this.glowProgram) gl.deleteProgram(this.glowProgram);
      if (this.needleProgram) gl.deleteProgram(this.needleProgram);
      if (this.barsProgram) gl.deleteProgram(this.barsProgram);
      if (this.crtProgram) gl.deleteProgram(this.crtProgram);
      this.scene?.dispose(gl);
      this.bloomChain?.dispose(gl);
    }
    this.buffers = [];
    this.glowVao = this.crtVao = null;
    this.glowProgram = this.crtProgram = this.needleProgram = this.barsProgram = null;
    this.instanceBuffer = this.cellBuffer = null;
    this.scene = null;
    this.bloomChain = null;
    this.gl = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.release();
    this.lost = true;
  }

  /** Draws `cells` into the canvas, whose bitmap size the caller has set. */
  render(cells: readonly GlowRenderCell[], options: GlowRenderOptions): void {
    const gl = this.gl;
    if (!gl || !this.glowProgram || this.lost) return;
    const { pixelRatio, crt, timeMs } = options;
    const bloom = !crt && options.bloom === true;
    const glowRadius = (bloom ? BLOOM_SHARP_GLOW.radius : options.glow?.radius) ?? GLOW_RADIUS;
    const glowStrength = (bloom ? BLOOM_SHARP_GLOW.strength : options.glow?.strength) ?? GLOW_STRENGTH;
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Cells are drawn a style at a time; each style is its own program.
    const styleOf = (cell: GlowRenderCell): RenderStyle => cell.style ?? options.style ?? 'trace';
    let floats = 0;
    for (const cell of cells) {
      floats += (cell.segments ? cell.count : Math.max(0, cell.count - 1)) * GLOW_INSTANCE_FLOATS;
    }
    if (this.instanceData.length < floats) {
      this.instanceData = new Float32Array(Math.max(floats, this.instanceData.length * 2));
    }
    const groups: { style: RenderStyle; start: number; count: number }[] = [];
    let offset = 0;
    for (const style of ['bars', 'needles', 'trace'] as const) {
      const start = offset / GLOW_INSTANCE_FLOATS;
      for (const cell of cells) {
        if (styleOf(cell) !== style) continue;
        offset = cell.segments
          ? writeIndependentSegments(
              this.instanceData,
              offset,
              cell.polyline,
              cell.count,
              cell,
              pixelRatio,
              cell.weights,
            )
          : writeSegmentInstances(
              this.instanceData,
              offset,
              cell.polyline,
              cell.count,
              cell,
              pixelRatio,
            );
      }
      const count = offset / GLOW_INSTANCE_FLOATS - start;
      if (count > 0) groups.push({ style, start, count });
    }

    if (crt || bloom) {
      this.scene?.use(gl, width, height);
    } else {
      gl.viewport(0, 0, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (groups.length > 0) {
      gl.bindVertexArray(this.glowVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.subarray(0, offset), gl.DYNAMIC_DRAW);
    }
    const stride = GLOW_INSTANCE_FLOATS * 4;
    for (const group of groups) {
      const program =
        group.style === 'needles'
          ? this.needleProgram
          : group.style === 'bars'
            ? this.barsProgram
            : this.glowProgram;
      const u =
        group.style === 'needles'
          ? this.needleUniforms
          : group.style === 'bars'
            ? this.barsUniforms
            : this.glowUniforms;
      if (!program) continue;
      gl.useProgram(program);
      // Point the per-instance attributes at this group's slice of the buffer.
      const base = group.start * stride;
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, base);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, base + 16);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, base + 32);
      const halfWidth =
        group.style === 'bars' ? (options.barHalfHeight ?? 3) : CORE_HALF_WIDTH;
      gl.uniform2f(u.uResolution ?? null, width, height);
      gl.uniform1f(u.uPad ?? null, (glowRadius + 2) * pixelRatio);
      gl.uniform3f(u.uColor ?? null, this.color[0], this.color[1], this.color[2]);
      gl.uniform3f(u.uColor2 ?? null, this.color2[0], this.color2[1], this.color2[2]);
      gl.uniform1f(u.uCoreHalfWidth ?? null, halfWidth * pixelRatio);
      gl.uniform1f(u.uGlowRadius ?? null, glowRadius * pixelRatio);
      gl.uniform1f(u.uGlowStrength ?? null, glowStrength);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
    }
    // Leave the attributes at the start of the buffer for the next frame's setup.
    if (groups.length > 0) {
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    }

    if (bloom) {
      this.compositeBloom(gl, cells, width, height, options.bloomStrength ?? BLOOM_STRENGTH);
      return;
    }
    if (!crt || !this.crtProgram) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (cells.length === 0) return;
    if (this.cellRects.length < cells.length * 4) this.cellRects = new Float32Array(cells.length * 4);
    cells.forEach((cell, i) => {
      this.cellRects[i * 4] = cell.x;
      this.cellRects[i * 4 + 1] = cell.y;
      this.cellRects[i * 4 + 2] = cell.width;
      this.cellRects[i * 4 + 3] = cell.height;
    });
    gl.useProgram(this.crtProgram);
    gl.bindVertexArray(this.crtVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cellRects.subarray(0, cells.length * 4), gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scene?.texture ?? null);
    const c = this.crtUniforms;
    gl.uniform1i(c.uScene ?? null, 0);
    gl.uniform2f(c.uResolution ?? null, width, height);
    gl.uniform3f(c.uColor ?? null, this.color[0], this.color[1], this.color[2]);
    gl.uniform1f(c.uTime ?? null, (timeMs / 1000) % 1000);
    gl.uniform1f(c.uRatio ?? null, pixelRatio);
    gl.uniform1f(c.uCorner ?? null, SCREEN_CORNER * pixelRatio);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cells.length);
  }

  /** Blurs the scene and adds it back over each cell; see `BloomChain`. */
  private compositeBloom(
    gl: WebGL2RenderingContext,
    cells: readonly GlowRenderCell[],
    width: number,
    height: number,
    strength: number,
  ): void {
    const scene = this.scene;
    if (!scene || !this.bloomChain) return;
    if (this.cellRects.length < cells.length * 4) this.cellRects = new Float32Array(cells.length * 4);
    cells.forEach((cell, i) => {
      this.cellRects[i * 4] = cell.x;
      this.cellRects[i * 4 + 1] = cell.y;
      this.cellRects[i * 4 + 2] = cell.width;
      this.cellRects[i * 4 + 3] = cell.height;
    });
    this.bloomChain.apply(gl, scene, width, height, this.cellRects, cells.length, strength);
  }
}

let shared: { canvas: HTMLCanvasElement; renderer: GlowScopeRenderer } | null = null;
let sharedFailed = false;

/**
 * One renderer, on an offscreen canvas, for the small scopes that each own a
 * 2D canvas (the pattern view's channel row): a page can hold a dozen of them
 * and browsers allow only a few WebGL contexts, so they take turns on this one
 * and copy the result with `drawImage`. Null when WebGL2 is not available.
 */
export function sharedGlowRenderer(): { canvas: HTMLCanvasElement; renderer: GlowScopeRenderer } | null {
  if (sharedFailed) return null;
  if (shared && !shared.renderer.lost) return shared;
  if (shared) {
    shared.renderer.dispose();
    shared = null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const renderer = new GlowScopeRenderer(canvas);
  if (!renderer.ok) {
    renderer.dispose();
    sharedFailed = true;
    return null;
  }
  shared = { canvas, renderer };
  return shared;
}
