import {
  RenderTarget,
  linkProgram,
  uniformLocations,
  type UniformLocations,
} from 'src/components/tracker/glow-gl';
import type { Bars3dFrame } from 'src/components/tracker/bars3d-renderer';
import { RAYMARCH_VERTEX_SHADER } from 'src/components/tracker/raymarch-shader';
import { TERRAIN_FRAGMENT_SHADER } from 'src/components/tracker/terrain-shader';
import { skyState } from 'src/components/tracker/sky-cycle';
import { terrainCamera } from 'src/components/tracker/terrain-camera';
import { BLUR_VERTEX_SHADER } from 'src/components/tracker/glow-scope-shader';

/** Rows of history (the newest nearest the camera) and columns (bands) the texture holds. */
export const TERRAIN_ROWS = 320;
export const TERRAIN_TEX_WIDTH = 128;
/** A new row of spectrum this many times a second, spaced ROW_SPACING apart: the speed the land streams past. */
const ROW_HZ = 30;
const ROW_SPACING = 0.22;
/** Half the width the spectrum spans, and how tall a full-scale band stands. */
const HALF_WIDTH = 10;
const MAX_HEIGHT = 2.8;
/**
 * World z of the newest row. It is where the bottom edge of the view meets the ground, so a sound shows up the
 * moment it is made and the land streams away from there; nearer to the camera it would be off screen.
 */
const NEWEST_Z = -6.3;
/** How many bands either side a peak is spread to when a row is made. */
const SPREAD_REACH = 3;

const BLIT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uSrc, vUv).rgb, 1.0);
}
`;

/** The marcher's resolution, as a fraction of the canvas, and how it is steered. */
const MIN_SCALE = 0.4;
const MAX_SCALE = 1;
const SCALE_STEP_DOWN = 0.1;
const SCALE_STEP_UP = 0.05;
const DECISION_FRAMES = 30;
const SLOW_MS = 23;
const FAST_MS = 18;
const BASE_COOLDOWN_MS = 4000;
const MAX_COOLDOWN_MS = 60000;

/**
 * The spectrum as a landscape: the last few seconds of the spectrum are kept
 * as rows of a texture, and one full-screen fragment shader raymarches it as a
 * heightfield, the newest row at the viewer's feet and the past streaming
 * away to the horizon. The canvas is sized by the caller.
 */
export class TerrainRenderer {
  lost = false;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: UniformLocations = {};
  private emptyVao: WebGLVertexArrayObject | null = null;
  private history: WebGLTexture | null = null;
  private target: RenderTarget | null = null;
  private blitProgram: WebGLProgram | null = null;
  private blitSrc: WebGLUniformLocation | null = null;
  private readonly rows = new Float32Array(TERRAIN_ROWS * TERRAIN_TEX_WIDTH);
  /** The loudest each band has been since the last row was pushed, so a short hit still lands in a row. */
  private readonly pending = new Float32Array(TERRAIN_TEX_WIDTH);
  private readonly spread = new Float32Array(TERRAIN_TEX_WIDTH);

  private timeMsPrev = 0;
  private rowClock = 0;
  private rowsPushed = 0;
  private dirty = true;
  private scale = 0.75;
  private lastTime = 0;
  private smoothedMs = 16.7;
  private frames = 0;
  private raisedAt = -Infinity;
  private cooldownMs = BASE_COOLDOWN_MS;
  private blockedUntil = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.lost = !this.init();
  }

  get ok(): boolean {
    return this.gl != null && !this.lost;
  }

  /** The current marcher resolution as a fraction of the canvas. */
  get resolutionScale(): number {
    return this.scale;
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
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return false;
    try {
      this.program = linkProgram(gl, RAYMARCH_VERTEX_SHADER, TERRAIN_FRAGMENT_SHADER);
      this.blitProgram = linkProgram(gl, BLUR_VERTEX_SHADER, BLIT_FRAGMENT_SHADER);
      this.target = new RenderTarget(gl);
      const history = gl.createTexture();
      if (!history) throw new Error('history texture allocation failed');
      this.history = history;
    } catch (error) {
      console.error(error);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.history);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TERRAIN_TEX_WIDTH, TERRAIN_ROWS, 0, gl.RED, gl.FLOAT, this.rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.dirty = false;
    this.uniforms = uniformLocations(gl, this.program, [
      'uRes',
      'uEye',
      'uTarget',
      'uFocal',
      'uTime',
      'uHist',
      'uBands',
      'uTexW',
      'uRows',
      'uPhase',
      'uScroll',
      'uZ0',
      'uDz',
      'uHalfW',
      'uMaxH',
      'uSunDir',
      'uMoonDir',
      'uSunColor',
      'uMoonColor',
      'uKeyDir',
      'uKeyColor',
      'uAmbient',
      'uDay',
      'uNight',
    ]);
    this.blitSrc = gl.getUniformLocation(this.blitProgram, 'uSrc');
    this.emptyVao = gl.createVertexArray();
    this.gl = gl;
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      if (this.program) gl.deleteProgram(this.program);
      if (this.history) gl.deleteTexture(this.history);
      this.target?.dispose(gl);
      if (this.blitProgram) gl.deleteProgram(this.blitProgram);
    }
    this.emptyVao = null;
    this.program = null;
    this.history = null;
    this.target = null;
    this.blitProgram = null;
    this.gl = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.release();
    this.lost = true;
  }

  /** Trades resolution for frame rate, as the raytraced view does: down fast, up cautiously. */
  private adapt(timeMs: number): void {
    const dt = timeMs - this.lastTime;
    this.lastTime = timeMs;
    if (dt <= 0 || dt > 120) return;
    this.smoothedMs += (dt - this.smoothedMs) * 0.1;
    if (++this.frames < DECISION_FRAMES) return;
    this.frames = 0;
    if (this.smoothedMs > SLOW_MS && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale - SCALE_STEP_DOWN);
      if (timeMs - this.raisedAt < this.cooldownMs) {
        this.cooldownMs = Math.min(MAX_COOLDOWN_MS, this.cooldownMs * 2);
      }
      this.blockedUntil = timeMs + this.cooldownMs;
      this.smoothedMs = (FAST_MS + SLOW_MS) / 2;
    } else if (this.smoothedMs < FAST_MS && this.scale < MAX_SCALE && timeMs >= this.blockedUntil) {
      this.scale = Math.min(MAX_SCALE, this.scale + SCALE_STEP_UP);
      this.raisedAt = timeMs;
    }
  }

  /**
   * Ages the history by one row and puts the loudest of each band since the
   * last row at the front. A tonal mix is a comb of harmonic spikes with next to
   * nothing between them, which would be a fence of needles, not land: each
   * peak is spread to its neighbours (falling off with distance) and the result
   * blurred, so the row is one continuous ridge line.
   */
  private pushRow(bands: number): void {
    this.rows.copyWithin(TERRAIN_TEX_WIDTH, 0, (TERRAIN_ROWS - 1) * TERRAIN_TEX_WIDTH);
    const raw = this.pending;
    const spread = this.spread;
    for (let b = 0; b < bands; b++) {
      let v = raw[b] ?? 0;
      for (let k = 1; k <= SPREAD_REACH; k++) {
        const w = 1 - k / (SPREAD_REACH + 1);
        v = Math.max(v, (raw[b - k] ?? 0) * w, (b + k < bands ? (raw[b + k] ?? 0) : 0) * w);
      }
      spread[b] = v;
    }
    for (let b = 0; b < bands; b++) {
      const l = spread[Math.max(0, b - 1)] ?? 0;
      const r = spread[Math.min(bands - 1, b + 1)] ?? 0;
      this.rows[b] = 0.25 * l + 0.5 * (spread[b] ?? 0) + 0.25 * r;
    }
    this.rowsPushed++;
    this.dirty = true;
  }

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const { target, blitProgram, history } = this;
    if (!gl || this.lost || !target || !blitProgram || !history || !this.program) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bands = Math.max(2, Math.min(TERRAIN_TEX_WIDTH, frame.bands));
    const levels = frame.levels;
    this.adapt(frame.timeMs);

    // A stalled frame (a background tab) must not rush the rows or bank a backlog.
    const dt = Math.min(0.1, Math.max(0, (frame.timeMs - this.timeMsPrev) / 1000));
    this.timeMsPrev = frame.timeMs;
    for (let b = 0; b < bands; b++) {
      this.pending[b] = Math.max(this.pending[b] ?? 0, Math.min(1, Math.max(0, levels[b] ?? 0)));
    }
    this.rowClock += dt * ROW_HZ;
    while (this.rowClock >= 1) {
      this.rowClock -= 1;
      this.pushRow(bands);
      for (let b = 0; b < bands; b++) this.pending[b] = Math.min(1, Math.max(0, levels[b] ?? 0));
    }
    if (this.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, history);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TERRAIN_TEX_WIDTH, TERRAIN_ROWS, gl.RED, gl.FLOAT, this.rows);
      this.dirty = false;
    }

    // The camera drifts: close and low, then far and high, with the field of view breathing (see terrain-camera.ts).
    const t = frame.timeMs / 1000;
    const { eye, look, fovY } = terrainCamera(t, NEWEST_Z);

    const rw = Math.max(1, Math.round(width * this.scale));
    const rh = Math.max(1, Math.round(height * this.scale));
    target.use(gl, rw, rh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, history);
    const u = this.uniforms;
    gl.uniform1i(u.uHist ?? null, 0);
    gl.uniform2f(u.uRes ?? null, rw, rh);
    gl.uniform3f(u.uEye ?? null, eye[0], eye[1], eye[2]);
    gl.uniform3f(u.uTarget ?? null, look[0], look[1], look[2]);
    gl.uniform1f(u.uFocal ?? null, 1 / Math.tan(fovY / 2));
    gl.uniform1f(u.uTime ?? null, t);
    gl.uniform1f(u.uBands ?? null, bands);
    gl.uniform1f(u.uTexW ?? null, TERRAIN_TEX_WIDTH);
    gl.uniform1f(u.uRows ?? null, TERRAIN_ROWS);
    gl.uniform1f(u.uPhase ?? null, this.rowClock);
    gl.uniform1f(u.uScroll ?? null, (this.rowsPushed + this.rowClock) * ROW_SPACING);
    gl.uniform1f(u.uZ0 ?? null, NEWEST_Z);
    gl.uniform1f(u.uDz ?? null, ROW_SPACING);
    gl.uniform1f(u.uHalfW ?? null, HALF_WIDTH);
    gl.uniform1f(u.uMaxH ?? null, MAX_HEIGHT);
    const sky = skyState(t);
    gl.uniform3fv(u.uSunDir ?? null, sky.sunDir);
    gl.uniform3fv(u.uMoonDir ?? null, sky.moonDir);
    gl.uniform3fv(u.uSunColor ?? null, sky.sunColor);
    gl.uniform3fv(u.uMoonColor ?? null, sky.moonColor);
    gl.uniform3fv(u.uKeyDir ?? null, sky.keyDir);
    gl.uniform3fv(u.uKeyColor ?? null, sky.keyColor);
    gl.uniform3fv(u.uAmbient ?? null, sky.ambient);
    gl.uniform1f(u.uDay ?? null, sky.day);
    gl.uniform1f(u.uNight ?? null, sky.night);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Straight to the canvas, upscaled. No bloom: the scene is bright all over, so a blurred copy added
    // on top washes it out, and it clouds the picture with smudges.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(blitProgram);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this.blitSrc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
