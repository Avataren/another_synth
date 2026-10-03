import { GpuRenderBudget } from './gpu-render-budget';
import {
  BloomChain,
  RenderTarget,
  linkProgram,
  uniformLocations,
  type UniformLocations,
} from 'src/components/tracker/glow-gl';
import type { Bars3dFrame } from 'src/components/tracker/bars3d-renderer';
import { RAYMARCH_VERTEX_SHADER } from 'src/components/tracker/raymarch-shader';
import {
  FRACTAL_BANDS,
  FRACTAL_COMBINE_FRAGMENT_SHADER,
  FRACTAL_FRAGMENT_SHADER,
  FRACTAL_METER_FRAGMENT_SHADER,
} from 'src/components/tracker/fractal-shader';
import {
  fractalCamera,
  glassPosition,
} from 'src/components/tracker/fractal-camera';
import { BLUR_VERTEX_SHADER } from 'src/components/tracker/glow-scope-shader';

/** How much of the bloom is added. */
const BLOOM_STRENGTH = 0.15;
/**
 * Auto exposure: the frame's average brightness (linear light) the exposure aims
 * for, how strongly it corrects towards it (1 = fully), the range it may move
 * through, and how fast it moves (per second) when the picture is too bright and
 * when it is too dark: quick to darken so a flash does not blow out, slower to lift.
 */
const TARGET_LUMINANCE = 0.05;
const CORRECTION = 0.6;
const MIN_EXPOSURE = 0.3;
const MAX_EXPOSURE = 1.25;
const DARKEN_RATE = 4;
const BRIGHTEN_RATE = 1.2;

/** The linear brightness of a packed (c / (1 + c) under a 2.2 gamma) colour, 0..255 per channel. */
export function unpackLuminance(r: number, g: number, b: number): number {
  const y = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const t = Math.pow(y, 2.2);
  return t / Math.max(1 - t, 1 / 64);
}

/** The exposure that moves a picture of average brightness `luminance` towards the target. */
export function exposureFor(luminance: number): number {
  const wanted = Math.pow(
    TARGET_LUMINANCE / Math.max(luminance, 1e-3),
    CORRECTION,
  );
  return Math.min(MAX_EXPOSURE, Math.max(MIN_EXPOSURE, wanted));
}

/** Folds a spectrum of any width into `out.length` bars, averaging each group. */
export function foldSpectrum(
  levels: ArrayLike<number>,
  bands: number,
  out: Float32Array,
): void {
  const n = Math.max(1, Math.min(bands, levels.length));
  for (let k = 0; k < out.length; k++) {
    const from = Math.floor((k * n) / out.length);
    const to = Math.max(from + 1, Math.floor(((k + 1) * n) / out.length));
    let sum = 0;
    for (let i = from; i < to; i++) sum += levels[i] ?? 0;
    out[k] = Math.min(1, sum / (to - from));
  }
}

function mean(values: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i] ?? 0;
  return sum / Math.max(1, to - from);
}

/**
 * The spectrum as a Mandelbulb over a mirror floor, with a glass sphere
 * orbiting it (see fractal-shader.ts): one full-screen fragment shader into a
 * target whose resolution follows the frame rate (as packed HDR), then a combine
 * pass (FXAA, tone mapping) and the bloom chain up onto the canvas. The canvas is sized by the caller.
 */
export class FractalRenderer {
  lost = false;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: UniformLocations = {};
  private emptyVao: WebGLVertexArrayObject | null = null;
  private target: RenderTarget | null = null;
  private combineProgram: WebGLProgram | null = null;
  private combineUniforms: UniformLocations = {};
  private combined: RenderTarget | null = null;
  private bloom: BloomChain | null = null;
  private readonly rect = new Float32Array(4);
  private budget: GpuRenderBudget | null = null;
  private readonly bands = new Float32Array(FRACTAL_BANDS);
  private readonly smooth = new Float32Array(FRACTAL_BANDS);
  private meterProgram: WebGLProgram | null = null;
  private meterSrc: WebGLUniformLocation | null = null;
  private meter: RenderTarget | null = null;
  private meterBuffer: WebGLBuffer | null = null;
  private meterFence: WebGLSync | null = null;
  private readonly meterPixel = new Uint8Array(4);
  private exposure = 1;
  private lastMeterMs = 0;
  private bass = 0;
  private mid = 0;
  private high = 0;
  private lastMs = 0;

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
        FRACTAL_FRAGMENT_SHADER,
      );
      this.combineProgram = linkProgram(
        gl,
        BLUR_VERTEX_SHADER,
        FRACTAL_COMBINE_FRAGMENT_SHADER,
      );
      this.meterProgram = linkProgram(
        gl,
        BLUR_VERTEX_SHADER,
        FRACTAL_METER_FRAGMENT_SHADER,
      );
      this.meter = new RenderTarget(gl);
      this.meterBuffer = gl.createBuffer();
      this.bloom = new BloomChain(gl);
      this.target = new RenderTarget(gl);
      this.combined = new RenderTarget(gl);
      this.budget = new GpuRenderBudget(gl);
    } catch (error) {
      console.error(error);
      this.release();
      return false;
    }
    this.uniforms = uniformLocations(gl, this.program, [
      'uRes',
      'uEye',
      'uTarget',
      'uFocal',
      'uTime',
      'uPower',
      'uBass',
      'uMid',
      'uHigh',
      'uGlass',
      'uBand',
    ]);
    this.combineUniforms = uniformLocations(gl, this.combineProgram, [
      'uScene',
      'uExposure',
    ]);
    this.meterSrc = gl.getUniformLocation(this.meterProgram, 'uSrc');
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.meterBuffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.emptyVao = gl.createVertexArray();
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      if (this.program) gl.deleteProgram(this.program);
      if (this.combineProgram) gl.deleteProgram(this.combineProgram);
      this.target?.dispose(gl);
      this.combined?.dispose(gl);
      this.bloom?.dispose(gl);
      if (this.meterProgram) gl.deleteProgram(this.meterProgram);
      this.meter?.dispose(gl);
      if (this.meterBuffer) gl.deleteBuffer(this.meterBuffer);
      if (this.meterFence) gl.deleteSync(this.meterFence);
      this.budget?.dispose();
    }
    this.budget = null;
    this.emptyVao = null;
    this.program = null;
    this.combineProgram = null;
    this.target = null;
    this.combined = null;
    this.bloom = null;
    this.meterProgram = null;
    this.meter = null;
    this.meterBuffer = null;
    this.meterFence = null;
    this.gl = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.release();
    this.lost = true;
  }

  /** Eases the bands towards the new spectrum: quick to rise, slower to fall. */
  private follow(frame: Bars3dFrame): void {
    const dt = Math.min(0.1, Math.max(0, (frame.timeMs - this.lastMs) / 1000));
    this.lastMs = frame.timeMs;
    foldSpectrum(frame.levels, frame.bands, this.bands);
    const rise = 1 - Math.exp(-dt * 30);
    const fall = 1 - Math.exp(-dt * 6);
    for (let k = 0; k < FRACTAL_BANDS; k++) {
      const target = this.bands[k] ?? 0;
      const now = this.smooth[k] ?? 0;
      this.smooth[k] = now + (target - now) * (target > now ? rise : fall);
    }
    const ease = (now: number, target: number): number =>
      now + (target - now) * (target > now ? rise : fall);
    this.bass = ease(this.bass, mean(this.smooth, 0, 3));
    this.mid = ease(this.mid, mean(this.smooth, 3, 9));
    this.high = ease(this.high, mean(this.smooth, 9, FRACTAL_BANDS));
  }

  /**
   * Auto exposure. Mips the scene down to one pixel and reads it back without
   * stalling (a pixel pack buffer and a fence: the answer arrives a frame or two
   * late, which a smoothed exposure does not mind), then eases the exposure
   * towards the one that suits the picture's average brightness.
   */
  private meterFrame(
    gl: WebGL2RenderingContext,
    scene: RenderTarget,
    timeMs: number,
  ): void {
    const { meter, meterProgram, meterBuffer } = this;
    if (!meter || !meterProgram || !meterBuffer) return;
    if (this.meterFence) {
      const status = gl.clientWaitSync(this.meterFence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        gl.deleteSync(this.meterFence);
        this.meterFence = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, meterBuffer);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.meterPixel);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const [r, g, b] = this.meterPixel;
        const wanted = exposureFor(unpackLuminance(r ?? 0, g ?? 0, b ?? 0));
        const dt = Math.min(
          0.25,
          Math.max(0, (timeMs - this.lastMeterMs) / 1000),
        );
        this.lastMeterMs = timeMs;
        const rate = wanted < this.exposure ? DARKEN_RATE : BRIGHTEN_RATE;
        this.exposure *= Math.pow(
          wanted / this.exposure,
          1 - Math.exp(-rate * dt),
        );
      }
    }
    if (this.meterFence) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    // The combine pass samples level 0 only (1:1), so the mips cost it nothing.
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_NEAREST,
    );
    meter.use(gl, 1, 1);
    gl.useProgram(meterProgram);
    gl.uniform1i(this.meterSrc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, meterBuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.meterFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const { target, combined, bloom, combineProgram, budget, program } =
      this;
    if (
      !gl ||
      this.lost ||
      !target ||
      !combined ||
      !bloom ||
      !combineProgram ||
      !budget ||
      !program
    )
      return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    budget.update(frame.timeMs, width, height);
    this.follow(frame);

    const t = frame.timeMs / 1000;
    const scale = frame.halfResolution ? 0.5 : budget.quality.scale;
    const rw = Math.max(1, Math.round(width * scale));
    const rh = Math.max(1, Math.round(height * scale));
    budget.begin(rw, rh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    // The camera cuts between shots (see fractal-camera.ts); the bulb's power breathes with the bass.
    const { eye, look, fovY } = fractalCamera(t, this.bass);
    const glass = glassPosition(t);
    const power = 5.2 + 1.8 * Math.sin(t * 0.06) + 2.4 * this.bass;

    target.use(gl, rw, rh);
    gl.useProgram(program);
    const u = this.uniforms;
    gl.uniform2f(u.uRes ?? null, rw, rh);
    gl.uniform3f(u.uEye ?? null, eye[0], eye[1], eye[2]);
    gl.uniform3f(u.uTarget ?? null, look[0], look[1], look[2]);
    gl.uniform1f(u.uFocal ?? null, 1 / Math.tan(fovY / 2));
    gl.uniform1f(u.uTime ?? null, t);
    gl.uniform1f(u.uPower ?? null, power);
    gl.uniform1f(u.uBass ?? null, this.bass);
    gl.uniform1f(u.uMid ?? null, this.mid);
    gl.uniform1f(u.uHigh ?? null, this.high);
    gl.uniform3f(u.uGlass ?? null, glass[0], glass[1], glass[2]);
    gl.uniform1fv(u.uBand ?? null, this.smooth);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.meterFrame(gl, target, frame.timeMs);

    // FXAA and tone mapping into a second target, then the bloom up onto the canvas.
    combined.use(gl, rw, rh);
    gl.useProgram(combineProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.uniform1i(this.combineUniforms.uScene ?? null, 0);
    gl.uniform1f(this.combineUniforms.uExposure ?? null, this.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.rect[0] = 0;
    this.rect[1] = 0;
    this.rect[2] = width;
    this.rect[3] = height;
    bloom.apply(gl, combined, width, height, this.rect, 1, BLOOM_STRENGTH);
    budget.end();
  }
}
