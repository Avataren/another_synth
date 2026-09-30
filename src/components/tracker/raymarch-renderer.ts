import {
  BloomChain,
  RenderTarget,
  linkProgram,
  uniformLocations,
  type UniformLocations,
} from 'src/components/tracker/glow-gl';
import type { Bars3dFrame } from 'src/components/tracker/bars3d-renderer';
import {
  RAYMARCH_COMBINE_FRAGMENT_SHADER,
  RAYMARCH_FRAGMENT_SHADER,
  RAYMARCH_VERTEX_SHADER,
} from 'src/components/tracker/raymarch-shader';
import { BALL_RADIUS, SEA_LIFT, ballState, bounceSeconds } from 'src/components/tracker/ball-motion';
import { skyState } from 'src/components/tracker/sky-cycle';
import { BLUR_FRAGMENT_SHADER, BLUR_VERTEX_SHADER } from 'src/components/tracker/glow-scope-shader';

const FOV_Y = (34 * Math.PI) / 180;
/**
 * Width of the row of bars, world units, and the tallest a bar gets. The
 * camera is framed on VIEW_WIDTH, so the row (twice that) runs past both
 * edges of the canvas: the bars are big, and the ends are out of sight.
 */
const ROW_WIDTH = 11.2;
const VIEW_WIDTH = 5.6;
const MAX_HEIGHT = 2.85;
const MAX_BARS = 128;
/** A regular octagon reaches this much further at its corners than at its flats (1 / cos 22.5 degrees). */
const OCTAGON_CORNER = 1.0824;
/** How much of the canvas width the row may fill (1 = edge to edge). */
const ROW_FILL = 0.97;
/**
 * The camera backs away as the canvas gets wider, so a very wide strip shows a
 * scene with much the same composition as a squarer one (more of the row, more
 * sky and floor) instead of a close-up slice of it. At ASPECT_REF the camera is
 * DISTANCE_REF away; beyond that the distance grows as aspect ** ASPECT_POWER
 * (1 would keep the picture's height constant in proportion, 0 would not back
 * off at all). Narrower than that, the row's width sets the distance, as before.
 */
const ASPECT_REF = 2.3;
const DISTANCE_REF = 6.2;
const ASPECT_POWER = 0.35;
/** Where the camera looks and how high it sits, tied to how tall the bars get. */
const LOOK_HEIGHT = MAX_HEIGHT * 0.26;
const EYE_HEIGHT = 1.25;
const BLOOM_STRENGTH = 0.15;
const REFLECTION_STRENGTH = 0.85;
/** Scene exposure ahead of the ACES curve, which otherwise reads a touch dark. */
const EXPOSURE = 1.35;

/**
 * How far sideways (world x) a sphere of radius `radius` at `depth` in front of
 * the camera must be to be entirely off a canvas whose half-width is `tanHalf`
 * times the depth. The sphere's edge is an angle `asin(radius / distance)` from
 * its centre, and at a wide view angle that is a lot of sideways travel, so this
 * is found in angles, not by adding a margin to the screen edge. A little extra
 * covers the camera's sideways drift.
 */
export function ballOffscreenX(depth: number, tanHalf: number, radius: number): number {
  const half = Math.atan(tanHalf);
  let x = depth * tanHalf;
  for (let i = 0; i < 4; i++) {
    const rho = Math.hypot(x, depth);
    const edge = Math.asin(Math.min(radius / rho, 0.99));
    // A little over the ball's own angular size: its reflection in the floor and its shadow reach a bit further.
    x = depth * Math.tan(Math.min(half + edge * 1.3, 1.5));
  }
  return x + 1.5;
}

function norm(v: readonly [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The marcher's resolution, as a fraction of the canvas, and how it is steered. */
const MIN_SCALE = 0.4;
const MAX_SCALE = 1;
const SCALE_STEP_DOWN = 0.1;
const SCALE_STEP_UP = 0.05;
/** Frames between decisions, and the smoothed frame time (ms) that triggers one. */
const DECISION_FRAMES = 30;
const SLOW_MS = 23;
const FAST_MS = 18;
/** A step up that is followed by a step down back off for this long (ms), doubling each time. */
const BASE_COOLDOWN_MS = 4000;
const MAX_COOLDOWN_MS = 60000;

/** A framebuffer with two colour textures (the scene and the floor's reflection), resized on demand. */
class SceneTarget {
  readonly scene: RenderTarget;
  readonly refl: RenderTarget;
  private readonly framebuffer: WebGLFramebuffer;
  private width = 0;
  private height = 0;

  constructor(gl: WebGL2RenderingContext) {
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('render target allocation failed');
    this.framebuffer = framebuffer;
    this.scene = new RenderTarget(gl);
    this.refl = new RenderTarget(gl);
  }

  use(gl: WebGL2RenderingContext, width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (this.width !== w || this.height !== h) {
      this.width = w;
      this.height = h;
      // `use` allocates each texture; the attachments are made here.
      this.scene.use(gl, w, h);
      this.refl.use(gl, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.scene.texture, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.refl.texture, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, w, h);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    this.scene.dispose(gl);
    this.refl.dispose(gl);
  }
}

/**
 * The 3D bars scene, raytraced: one full-screen fragment shader marches a
 * distance field of the bars (soft shadows, ambient occlusion, a glossy mirror
 * floor, reflections) into a target whose resolution follows the frame rate,
 * and the bloom chain scales it up onto the canvas. The canvas is sized by the
 * caller.
 */
export class RaymarchRenderer {
  lost = false;

  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: UniformLocations = {};
  private emptyVao: WebGLVertexArrayObject | null = null;
  private target: SceneTarget | null = null;
  private blurProgram: WebGLProgram | null = null;
  private combineProgram: WebGLProgram | null = null;
  private blurUniforms: UniformLocations = {};
  private combineUniforms: UniformLocations = {};
  private reflTmp: RenderTarget | null = null;
  private reflBlur: RenderTarget | null = null;
  private combined: RenderTarget | null = null;
  private bloom: BloomChain | null = null;
  private readonly bars = new Float32Array(MAX_BARS * 2);
  private readonly rect = new Float32Array(4);

  private bounces = 0;
  private scale = 0.75;
  private lastTime = 0;
  private lastBounceMs = 0;
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
      this.program = linkProgram(gl, RAYMARCH_VERTEX_SHADER, RAYMARCH_FRAGMENT_SHADER);
      this.blurProgram = linkProgram(gl, BLUR_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
      this.combineProgram = linkProgram(gl, BLUR_VERTEX_SHADER, RAYMARCH_COMBINE_FRAGMENT_SHADER);
      this.bloom = new BloomChain(gl);
      this.target = new SceneTarget(gl);
      this.reflTmp = new RenderTarget(gl);
      this.reflBlur = new RenderTarget(gl);
      this.combined = new RenderTarget(gl);
    } catch (error) {
      console.error(error);
      return false;
    }
    this.uniforms = uniformLocations(gl, this.program, [
      'uRes',
      'uEye',
      'uTarget',
      'uFocal',
      'uTime',
      'uBands',
      'uPitch',
      'uHalf',
      'uHalfZ',
      'uMaxH',
      'uLoud',
      'uBars',
      'uSunDir',
      'uMoonDir',
      'uSunColor',
      'uMoonColor',
      'uKeyDir',
      'uKeyColor',
      'uAmbient',
      'uDay',
      'uNight',
      'uAurora',
      'uSunE',
      'uBall',
      'uBallRot',
      'uBallOn',
      'uSeaLift',
    ]);
    this.blurUniforms = uniformLocations(gl, this.blurProgram, ['uSrc', 'uStep']);
    this.combineUniforms = uniformLocations(gl, this.combineProgram, [
      'uScene',
      'uSharp',
      'uBlur',
      'uBaseV',
      'uStrength',
      'uExposure',
    ]);
    this.emptyVao = gl.createVertexArray();
    this.gl = gl;
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      for (const p of [this.program, this.blurProgram, this.combineProgram]) {
        if (p) gl.deleteProgram(p);
      }
      for (const t of [this.target, this.reflTmp, this.reflBlur, this.combined]) t?.dispose(gl);
      this.bloom?.dispose(gl);
    }
    this.emptyVao = null;
    this.program = this.blurProgram = this.combineProgram = null;
    this.target = this.reflTmp = this.reflBlur = this.combined = null;
    this.bloom = null;
    this.gl = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.release();
    this.lost = true;
  }

  /**
   * Trades resolution for frame rate: the marcher is the whole cost of the
   * view, so it drops a step when frames run long and creeps back up when
   * there is room, backing off if going up keeps making it slow again.
   */
  private adapt(timeMs: number): void {
    const dt = timeMs - this.lastTime;
    this.lastTime = timeMs;
    // A stalled tab or the first frame says nothing about the GPU.
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

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const { target, reflTmp, reflBlur, combined, bloom } = this;
    if (!gl || this.lost || !target || !reflTmp || !reflBlur || !combined || !bloom || !this.program) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bands = Math.max(1, Math.min(MAX_BARS, frame.bands));
    this.adapt(frame.timeMs);
    // Count bounces at the song's tempo: a running count, so a tempo change bends the rate without a jump.
    const frameSeconds = Math.min(0.1, Math.max(0, (frame.timeMs - this.lastBounceMs) / 1000));
    this.lastBounceMs = frame.timeMs;
    this.bounces += frameSeconds / bounceSeconds(frame.bpm ?? 0);

    // The camera: low and wide, drifting a little so the depth reads.
    const aspect = width / Math.max(1, height);
    const t = frame.timeMs / 1000;
    const fitWidth = (VIEW_WIDTH / 2 / ROW_FILL) / (Math.tan(FOV_Y / 2) * aspect);
    const backOff = DISTANCE_REF * Math.pow(Math.max(aspect, ASPECT_REF) / ASPECT_REF, ASPECT_POWER);
    const distance = Math.max(fitWidth, backOff);
    const eye = [Math.sin(t * 0.17) * 0.9, EYE_HEIGHT + Math.sin(t * 0.11) * 0.05, distance] as const;

    const pitch = ROW_WIDTH / bands;
    let loud = 0;
    for (let b = 0; b < bands; b++) {
      const level = Math.min(1, Math.max(0, frame.levels[b] ?? 0));
      const peak = Math.min(1, Math.max(0, frame.peaks[b] ?? 0));
      loud += level;
      this.bars[b * 2] = Math.max(0.02, level * MAX_HEIGHT);
      this.bars[b * 2 + 1] = peak * MAX_HEIGHT + 0.04;
    }

    // Where the floor line under the bars lands on the screen (v, 0 at the bottom).
    const focal = 1 / Math.tan(FOV_Y / 2);
    const look = [0, LOOK_HEIGHT, 0] as const;
    const f = norm([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
    const right = norm([f[2], 0, -f[0]]); // cross(f, up)
    const up: [number, number, number] = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]];
    const px = -eye[0];
    const py = -eye[1];
    const pz = -eye[2];
    const depth = px * f[0] + py * f[1] + pz * f[2];
    const baseV = 0.5 + (0.5 * focal * (px * up[0] + py * up[1] + pz * up[2])) / depth;

    const rw = Math.max(1, Math.round(width * this.scale));
    const rh = Math.max(1, Math.round(height * this.scale));
    target.use(gl, rw, rh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.emptyVao);
    const u = this.uniforms;
    gl.uniform2f(u.uRes ?? null, rw, rh);
    gl.uniform3f(u.uEye ?? null, eye[0], eye[1], eye[2]);
    gl.uniform3f(u.uTarget ?? null, look[0], look[1], look[2]);
    gl.uniform1f(u.uFocal ?? null, focal);
    gl.uniform1f(u.uTime ?? null, t);
    gl.uniform1i(u.uBands ?? null, bands);
    gl.uniform1f(u.uPitch ?? null, pitch);
    gl.uniform1f(u.uHalf ?? null, pitch * 0.6 * 0.5);
    gl.uniform1f(u.uHalfZ ?? null, pitch * 0.6 * 0.5 * OCTAGON_CORNER);
    gl.uniform1f(u.uMaxH ?? null, MAX_HEIGHT);
    gl.uniform1f(u.uLoud ?? null, Math.min(1, loud / bands / 0.4));
    gl.uniform2fv(u.uBars ?? null, this.bars);
    const tanHalf = Math.tan(FOV_Y / 2);
    const ball = ballState(t, (z) => ballOffscreenX(Math.max(distance - z, 0.1), tanHalf * aspect, BALL_RADIUS), this.bounces);
    gl.uniform4f(u.uBall ?? null, ball.x, ball.y, ball.z, ball.radius);
    gl.uniformMatrix3fv(u.uBallRot ?? null, false, ball.rotation);
    gl.uniform1f(u.uBallOn ?? null, ball.visible ? 1 : 0);
    gl.uniform1f(u.uSeaLift ?? null, SEA_LIFT);
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
    gl.uniform1f(u.uAurora ?? null, sky.aurora);
    gl.uniform1f(u.uSunE ?? null, sky.sunElevation);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Smear the mirror: long vertically, barely across, so the colours stay apart.
    gl.useProgram(this.blurProgram);
    gl.uniform1i(this.blurUniforms.uSrc ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    const smear = (from: RenderTarget, into: RenderTarget, dx: number, dy: number): void => {
      into.use(gl, rw, rh);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(this.blurUniforms.uStep ?? null, dx / rw, dy / rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    smear(target.refl, reflTmp, 0.8, 0);
    smear(reflTmp, reflBlur, 0, 2);
    smear(reflBlur, reflTmp, 1.4, 0);
    smear(reflTmp, reflBlur, 0, 3);

    // Scene plus reflection, then the bloom onto the canvas.
    combined.use(gl, rw, rh);
    gl.useProgram(this.combineProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.refl.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, reflBlur.texture);
    gl.uniform1i(this.combineUniforms.uScene ?? null, 0);
    gl.uniform1i(this.combineUniforms.uSharp ?? null, 1);
    gl.uniform1i(this.combineUniforms.uBlur ?? null, 2);
    gl.uniform1f(this.combineUniforms.uBaseV ?? null, baseV);
    gl.uniform1f(this.combineUniforms.uStrength ?? null, REFLECTION_STRENGTH);
    gl.uniform1f(this.combineUniforms.uExposure ?? null, EXPOSURE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);

    this.rect[0] = 0;
    this.rect[1] = 0;
    this.rect[2] = width;
    this.rect[3] = height;
    bloom.apply(gl, combined, width, height, this.rect, 1, BLOOM_STRENGTH);
  }
}
