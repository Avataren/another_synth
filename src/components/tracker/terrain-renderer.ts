import { TerrainAtlas } from 'src/components/tracker/terrain-atlas';
import { TerrainQuality } from 'src/components/tracker/terrain-quality';
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
import {
  TerrainHistory,
  terrainHeightBound,
  TERRAIN_TEXTURE_ROWS,
  TERRAIN_TEX_WIDTH,
  TERRAIN_ROW_STRIDE,
} from 'src/components/tracker/terrain-history';

/** Distance between archived spectrum rows: the speed and extent of the land stay the same. */
const ROW_SPACING = 0.22;
/** Half the width the spectrum spans, and its height scale (relief may rise higher). */
const HALF_WIDTH = 10;
const HEIGHT_PER_LEVEL = 5.5;
/**
 * World z of the newest row. It is where the bottom edge of the view meets the ground, so a sound shows up the
 * moment it is made and the land streams away from there; nearer to the camera it would be off screen.
 */
const NEWEST_Z = -6.3;

const BLIT_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uSrc, vUv).rgb, 1.0);
}
`;

interface GpuTimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

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
  private readonly spectrumHistory = new TerrainHistory();
  private readonly quality = new TerrainQuality();
  private atlas: TerrainAtlas | null = null;
  private timer: GpuTimerExtension | null = null;
  private queries: { query: WebGLQuery; scale: number }[] = [];
  private frameCount = 0;
  private lastBands = 0;

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
    return this.quality.scale;
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
    this.gl = gl;
    try {
      this.program = linkProgram(
        gl,
        RAYMARCH_VERTEX_SHADER,
        TERRAIN_FRAGMENT_SHADER,
      );
      this.blitProgram = linkProgram(
        gl,
        BLUR_VERTEX_SHADER,
        BLIT_FRAGMENT_SHADER,
      );
      this.target = new RenderTarget(gl);
      this.atlas = new TerrainAtlas(gl);
      this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const history = gl.createTexture();
      if (!history) throw new Error('history texture allocation failed');
      this.history = history;
    } catch (error) {
      console.error(error);
      this.release();
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.history);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG16F,
      TERRAIN_TEX_WIDTH,
      TERRAIN_TEXTURE_ROWS,
      0,
      gl.RG,
      gl.FLOAT,
      this.spectrumHistory.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.uniforms = uniformLocations(gl, this.program, [
      'uSurface',
      'uBounds',
      'uSurfaceOrigin',
      'uSurfaceStep',
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
      'uHeightBound',
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
      this.atlas?.dispose(gl);
      for (const { query } of this.queries) gl.deleteQuery(query);
      if (this.blitProgram) gl.deleteProgram(this.blitProgram);
    }
    this.atlas = null;
    this.timer = null;
    this.queries = [];
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

  /** Read completed timers only: no gl.finish(), stalls or waiting for this frame's GPU. */
  private pollTimers(gl: WebGL2RenderingContext, timeMs: number): void {
    const timer = this.timer;
    if (!timer) return;
    const disjoint: unknown = gl.getParameter(timer.GPU_DISJOINT_EXT);
    while (this.queries.length > 0) {
      const pending = this.queries[0];
      if (!pending) break;
      if (
        !disjoint &&
        !gl.getQueryParameter(pending.query, gl.QUERY_RESULT_AVAILABLE)
      )
        break;
      if (!disjoint && Math.abs(pending.scale - this.quality.scale) < 0.001) {
        const ns: unknown = gl.getQueryParameter(
          pending.query,
          gl.QUERY_RESULT,
        );
        if (typeof ns === 'number') this.quality.recordGpu(ns / 1e6, timeMs);
      }
      gl.deleteQuery(pending.query);
      this.queries.shift();
    }
  }

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const { target, blitProgram, history, atlas } = this;
    if (
      !gl ||
      this.lost ||
      !target ||
      !blitProgram ||
      !history ||
      !atlas ||
      !this.program
    )
      return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bands = Math.max(
      2,
      Math.min(TERRAIN_TEX_WIDTH, Math.floor(frame.bands)),
    );
    this.pollTimers(gl, frame.timeMs);
    this.quality.update(frame.timeMs, width * height);

    const spectrum = this.spectrumHistory;
    const previousRows = spectrum.rowsPushed;
    const previousBands = this.lastBands;
    this.lastBands = bands;
    spectrum.update(frame.levels, bands, frame.timeMs);
    gl.bindTexture(gl.TEXTURE_2D, history);
    // Only the live row changes between archive ticks; upload the whole history when it moves.
    const uploadRows =
      spectrum.rowsPushed !== previousRows || previousBands !== bands
        ? TERRAIN_TEXTURE_ROWS
        : 1;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      TERRAIN_TEX_WIDTH,
      uploadRows,
      gl.RG,
      gl.FLOAT,
      spectrum.data.subarray(0, uploadRows * TERRAIN_ROW_STRIDE),
    );

    // The camera drifts: close and low, then far and high, with the field of view breathing (see terrain-camera.ts).
    const t = frame.timeMs / 1000;
    const { eye, look, fovY } = terrainCamera(t, NEWEST_Z);

    const rw = Math.max(1, Math.round(width * this.quality.scale));
    const rh = Math.max(1, Math.round(height * this.quality.scale));
    const timer = this.timer;
    const query =
      timer && ++this.frameCount % 6 === 0 && this.queries.length < 4
        ? gl.createQuery()
        : null;
    if (timer && query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER); // Packed height bytes must not be changed by framebuffer dithering.
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);

    atlas.use(gl, bands, HALF_WIDTH, ROW_SPACING, spectrum.phase);
    gl.bindTexture(gl.TEXTURE_2D, history);
    const au = atlas.uniforms;
    gl.uniform1i(au.uHist ?? null, 0);
    gl.uniform1f(au.uTime ?? null, t);
    gl.uniform1f(au.uBands ?? null, bands);
    gl.uniform1f(au.uTexW ?? null, TERRAIN_TEX_WIDTH);
    gl.uniform1f(au.uRows ?? null, TERRAIN_TEXTURE_ROWS);
    gl.uniform1f(au.uPhase ?? null, spectrum.phase);
    gl.uniform1f(
      au.uScroll ?? null,
      (spectrum.rowsPushed + spectrum.phase) * ROW_SPACING,
    );
    gl.uniform1f(au.uZ0 ?? null, NEWEST_Z);
    gl.uniform1f(au.uDz ?? null, ROW_SPACING);
    gl.uniform1f(au.uHalfW ?? null, HALF_WIDTH);
    gl.uniform1f(au.uMaxH ?? null, HEIGHT_PER_LEVEL);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    atlas.reduce(gl);

    target.use(gl, rw, rh);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlas.surface.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlas.boundTexture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, history);
    const u = this.uniforms;
    gl.uniform1i(u.uHist ?? null, 0);
    gl.uniform1i(u.uSurface ?? null, 1);
    gl.uniform1i(u.uBounds ?? null, 2);
    gl.uniform2fv(u.uSurfaceOrigin ?? null, atlas.origin);
    gl.uniform2fv(u.uSurfaceStep ?? null, atlas.step);
    gl.uniform2f(u.uRes ?? null, rw, rh);
    gl.uniform3f(u.uEye ?? null, eye[0], eye[1], eye[2]);
    gl.uniform3f(u.uTarget ?? null, look[0], look[1], look[2]);
    gl.uniform1f(u.uFocal ?? null, 1 / Math.tan(fovY / 2));
    gl.uniform1f(u.uTime ?? null, t);
    gl.uniform1f(u.uBands ?? null, bands);
    gl.uniform1f(u.uTexW ?? null, TERRAIN_TEX_WIDTH);
    gl.uniform1f(u.uRows ?? null, TERRAIN_TEXTURE_ROWS);
    gl.uniform1f(u.uPhase ?? null, spectrum.phase);
    gl.uniform1f(
      u.uScroll ?? null,
      (spectrum.rowsPushed + spectrum.phase) * ROW_SPACING,
    );
    gl.uniform1f(u.uZ0 ?? null, NEWEST_Z);
    gl.uniform1f(u.uDz ?? null, ROW_SPACING);
    gl.uniform1f(u.uHalfW ?? null, HALF_WIDTH);
    gl.uniform1f(u.uMaxH ?? null, HEIGHT_PER_LEVEL);
    gl.uniform1f(
      u.uHeightBound ?? null,
      terrainHeightBound(spectrum.maximumLevel, HEIGHT_PER_LEVEL),
    );
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
    if (timer && query) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.queries.push({ query, scale: this.quality.scale });
    }
  }
}
