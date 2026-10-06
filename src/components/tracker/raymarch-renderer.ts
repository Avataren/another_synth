import { GpuRenderBudget } from './gpu-render-budget';
import { RaymarchBarData, RAYMARCH_MAX_BARS } from './raymarch-bars';
import {
  BloomChain,
  RenderTarget,
  linkProgram,
  programStatus,
  startProgram,
  uniformLocations,
  type UniformLocations,
} from 'src/components/tracker/glow-gl';
import type { Bars3dFrame } from 'src/components/tracker/bars3d-renderer';
import {
  RAYMARCH_COMBINE_FRAGMENT_SHADER,
  RAYMARCH_FRAGMENT_SHADER,
  RAYMARCH_LOOPS,
  RAYMARCH_SKY_FRAGMENT_SHADER,
  RAYMARCH_VERTEX_SHADER,
} from 'src/components/tracker/raymarch-shader';
import {
  BALL_RADIUS,
  SEA_LIFT,
  ballState,
  bounceSeconds,
} from 'src/components/tracker/ball-motion';
import { skyState } from 'src/components/tracker/sky-cycle';
import {
  BLUR_FRAGMENT_SHADER,
  BLUR_VERTEX_SHADER,
} from 'src/components/tracker/glow-scope-shader';

const FOV_Y = (34 * Math.PI) / 180;
/**
 * Width of the row of bars, world units, and the tallest a bar gets. The
 * camera is framed on VIEW_WIDTH, so the row (twice that) runs past both
 * edges of the canvas: the bars are big, and the ends are out of sight.
 */
const ROW_WIDTH = 11.2;
const VIEW_WIDTH = 5.6;
const MAX_HEIGHT = 3.6;
/** How much of its cell a bar fills across (the rest is the gap to its neighbour); a peak cap is 0.8 of that. */
/** The fixed scale of the half resolution setting: half the canvas width and height. */
const HALF_RESOLUTION = 0.5;
const BAR_FILL = 0.63;
const MAX_BARS = RAYMARCH_MAX_BARS;
const SKY_WIDTH = 384;
const SKY_HEIGHT = 96;
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
/**
 * Up to FIT_ASPECT_FULL the camera backs off far enough to show the whole row
 * (a 16:9 screen); from there to FIT_ASPECT_CROP it eases back to framing
 * VIEW_WIDTH alone, so a very wide strip still gets the big, cropped picture.
 */
const FIT_ASPECT_FULL = 2.0;
const FIT_ASPECT_CROP = 2.4;
/** Room the fit leaves for the camera's sideways drift (see `eye`). It looks at the row's centre, so the drift moves the ends far less than its own size. */
const EYE_DRIFT = 0.5;
/** The camera sweeps left and right along a sine: how far (world units) and how fast (radians a second, about 25 s a sweep). */
const EYE_SWAY = 2.0;
const EYE_SWAY_SPEED = 0.25;
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
export function ballOffscreenX(
  depth: number,
  tanHalf: number,
  radius: number,
): number {
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
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.scene.texture,
        0,
      );
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT1,
        gl.TEXTURE_2D,
        this.refl.texture,
        0,
      );
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

/** The first frames run small: see RenderQuality. */
const INITIAL_SCALE = 0.4;

/**
 * The 3D bars scene, raytraced: one full-screen fragment shader intersects
 * the bars (soft shadows, ambient occlusion, a glossy mirror
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
  private readonly bars = new RaymarchBarData();
  private barTexture: WebGLTexture | null = null;
  private skyTarget: RenderTarget | null = null;
  private skyProgram: WebGLProgram | null = null;
  private skyUniforms: UniformLocations = {};
  private budget: GpuRenderBudget | null = null;
  private halfResolution = false;
  private linked = false;
  private readonly rect = new Float32Array(4);

  private bounces = 0;
  private lastBounceMs = 0;

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
    if (this.halfResolution) return HALF_RESOLUTION;
    return this.budget?.quality.scale ?? 0.75;
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
      this.budget = new GpuRenderBudget(gl, INITIAL_SCALE);
      this.skyProgram = startProgram(
        gl,
        RAYMARCH_VERTEX_SHADER,
        RAYMARCH_SKY_FRAGMENT_SHADER,
      );
      this.skyTarget = new RenderTarget(gl);
      this.barTexture = gl.createTexture();
      if (!this.barTexture) throw new Error('bar texture allocation failed');
      gl.bindTexture(gl.TEXTURE_2D, this.barTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        MAX_BARS,
        2,
        0,
        gl.RGBA,
        gl.FLOAT,
        this.bars.data,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.program = startProgram(
        gl,
        RAYMARCH_VERTEX_SHADER,
        RAYMARCH_FRAGMENT_SHADER,
      );
      this.blurProgram = linkProgram(
        gl,
        BLUR_VERTEX_SHADER,
        BLUR_FRAGMENT_SHADER,
      );
      this.combineProgram = linkProgram(
        gl,
        BLUR_VERTEX_SHADER,
        RAYMARCH_COMBINE_FRAGMENT_SHADER,
      );
      this.bloom = new BloomChain(gl);
      this.target = new SceneTarget(gl);
      this.reflTmp = new RenderTarget(gl);
      this.reflBlur = new RenderTarget(gl);
      this.combined = new RenderTarget(gl);
    } catch (error) {
      console.error(error);
      this.release();
      return false;
    }
    this.blurUniforms = uniformLocations(gl, this.blurProgram, [
      'uSrc',
      'uStep',
    ]);
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


  /**
   * The two heavy programs compile in the background. Until both are linked nothing is drawn; once they
   * are, finds their uniforms. A failed link makes the view unusable, as a failed init does.
   */
  private programsReady(gl: WebGL2RenderingContext): boolean {
    if (this.linked) return true;
    const { program, skyProgram } = this;
    if (!program || !skyProgram) return false;
    const states = [program, skyProgram].map((p) => programStatus(gl, p));
    const failed = states.find((s) => s.state === 'failed');
    if (failed) {
      console.error(`raymarch program: ${failed.error ?? 'link failed'}`);
      this.lost = true;
      return false;
    }
    if (states.some((s) => s.state === 'pending')) return false;
    this.uniforms = uniformLocations(gl, program, [
      'uRes',
      'uEye',
      'uTarget',
      'uFocal',
      'uTime',
      'uBands',
      'uPitch',
      'uHalf',
      'uCapHalf',
      'uHalfZ',
      'uMaxH',
      'uLoud',
      'uBarData',
      'uSky',
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
      ...Object.keys(RAYMARCH_LOOPS),
    ]);
    this.skyUniforms = uniformLocations(gl, skyProgram, [
      'uSkyRes',
      'uTime',
      'uLoud',
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
    ]);
    this.linked = true;
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      this.budget?.dispose();
      this.skyTarget?.dispose(gl);
      if (this.skyProgram) gl.deleteProgram(this.skyProgram);
      if (this.barTexture) gl.deleteTexture(this.barTexture);
      if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
      for (const p of [this.program, this.blurProgram, this.combineProgram]) {
        if (p) gl.deleteProgram(p);
      }
      for (const t of [this.target, this.reflTmp, this.reflBlur, this.combined])
        t?.dispose(gl);
      this.bloom?.dispose(gl);
    }
    this.linked = false;
    this.budget = null;
    this.skyTarget = null;
    this.skyProgram = null;
    this.barTexture = null;
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

  private applySky(
    gl: WebGL2RenderingContext,
    u: UniformLocations,
    sky: ReturnType<typeof skyState>,
  ): void {
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
  }

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const {
      target,
      reflTmp,
      reflBlur,
      combined,
      bloom,
      skyTarget,
      skyProgram,
      budget,
      barTexture,
    } = this;
    if (
      !gl ||
      this.lost ||
      !target ||
      !reflTmp ||
      !reflBlur ||
      !combined ||
      !bloom ||
      !this.program ||
      !skyTarget ||
      !skyProgram ||
      !budget ||
      !barTexture ||
      !this.programsReady(gl)
    )
      return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bands = Math.max(1, Math.min(MAX_BARS, Math.floor(frame.bands)));
    budget.update(frame.timeMs, width, height);
    // Count bounces at the song's tempo: a running count, so a tempo change bends the rate without a jump.
    const frameSeconds = Math.min(
      0.1,
      Math.max(0, (frame.timeMs - this.lastBounceMs) / 1000),
    );
    this.lastBounceMs = frame.timeMs;
    this.bounces += frameSeconds / bounceSeconds(frame.bpm ?? 0);

    // The camera: low and wide, drifting a little so the depth reads.
    const aspect = width / Math.max(1, height);
    const t = frame.timeMs / 1000;
    const showAll = Math.min(
      1,
      Math.max(
        0,
        (FIT_ASPECT_CROP - aspect) / (FIT_ASPECT_CROP - FIT_ASPECT_FULL),
      ),
    );
    const viewWidth = VIEW_WIDTH + (ROW_WIDTH - VIEW_WIDTH) * showAll;
    const fitWidth =
      (viewWidth / 2 + EYE_DRIFT * showAll) /
      ROW_FILL /
      (Math.tan(FOV_Y / 2) * aspect);
    const backOff =
      DISTANCE_REF *
      Math.pow(Math.max(aspect, ASPECT_REF) / ASPECT_REF, ASPECT_POWER);
    const distance = Math.max(fitWidth, backOff);
    const eye = [
      Math.sin(t * EYE_SWAY_SPEED) * EYE_SWAY,
      EYE_HEIGHT + Math.sin(t * 0.11) * 0.05,
      distance,
    ] as const;

    const pitch = ROW_WIDTH / bands;
    const loud = this.bars.update(frame.levels, frame.peaks, bands, MAX_HEIGHT);

    // Where the floor line under the bars lands on the screen (v, 0 at the bottom).
    const focal = 1 / Math.tan(FOV_Y / 2);
    const look = [0, LOOK_HEIGHT, 0] as const;
    const f = norm([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
    const right = norm([f[2], 0, -f[0]]); // cross(f, up)
    const up: [number, number, number] = [
      f[1] * right[2] - f[2] * right[1],
      f[2] * right[0] - f[0] * right[2],
      f[0] * right[1] - f[1] * right[0],
    ];
    const px = -eye[0];
    const py = -eye[1];
    const pz = -eye[2];
    const depth = px * f[0] + py * f[1] + pz * f[2];
    const baseV =
      0.5 + (0.5 * focal * (px * up[0] + py * up[1] + pz * up[2])) / depth;

    // Half resolution is fixed; otherwise the budget picks the scale from how long the GPU takes.
    this.halfResolution = frame.halfResolution === true;
    const scale = this.halfResolution ? HALF_RESOLUTION : budget.quality.scale;
    const rw = Math.max(1, Math.round(width * scale));
    const rh = Math.max(1, Math.round(height * scale));
    budget.begin(rw, rh);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, barTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      MAX_BARS,
      2,
      gl.RGBA,
      gl.FLOAT,
      this.bars.data,
    );
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    skyTarget.use(gl, SKY_WIDTH, SKY_HEIGHT);
    gl.useProgram(skyProgram);
    gl.uniform2f(this.skyUniforms.uSkyRes ?? null, SKY_WIDTH, SKY_HEIGHT);
    gl.uniform1f(this.skyUniforms.uTime ?? null, t);
    gl.uniform1f(this.skyUniforms.uLoud ?? null, loud);
    const sky = skyState(t);
    this.applySky(gl, this.skyUniforms, sky);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, skyTarget.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.activeTexture(gl.TEXTURE0);

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
    gl.uniform1f(u.uHalf ?? null, pitch * BAR_FILL * 0.5);
    gl.uniform1f(u.uCapHalf ?? null, pitch * BAR_FILL * 0.8 * 0.5);
    gl.uniform1f(u.uHalfZ ?? null, pitch * BAR_FILL * 0.5 * OCTAGON_CORNER);
    gl.uniform1f(u.uMaxH ?? null, MAX_HEIGHT);
    gl.uniform1f(u.uLoud ?? null, loud);
    gl.uniform1i(u.uBarData ?? null, 3);
    gl.uniform1i(u.uSky ?? null, 4);
    const tanHalf = Math.tan(FOV_Y / 2);
    const ball = ballState(
      t,
      (z) =>
        ballOffscreenX(
          Math.max(distance - z, 0.1),
          tanHalf * aspect,
          BALL_RADIUS,
        ),
      this.bounces,
    );
    gl.uniform4f(u.uBall ?? null, ball.x, ball.y, ball.z, ball.radius);
    gl.uniformMatrix3fv(u.uBallRot ?? null, false, ball.rotation);
    gl.uniform1f(u.uBallOn ?? null, ball.visible ? 1 : 0);
    gl.uniform1f(u.uSeaLift ?? null, SEA_LIFT);
    for (const [name, value] of Object.entries(RAYMARCH_LOOPS))
      gl.uniform1i(u[name] ?? null, value);
    this.applySky(gl, u, sky);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    // Smear the mirror: long vertically, barely across, so the colours stay apart.
    gl.useProgram(this.blurProgram);
    gl.uniform1i(this.blurUniforms.uSrc ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    const smear = (
      from: RenderTarget,
      into: RenderTarget,
      dx: number,
      dy: number,
    ): void => {
      into.use(
        gl,
        Math.max(1, Math.round(rw / 2)),
        Math.max(1, Math.round(rh / 2)),
      );
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(this.blurUniforms.uStep ?? null, dx / rw, dy / rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    smear(target.refl, reflTmp, 1.6, 0);
    // Two vertical passes with closer taps (about the old 3.6 texel spread in all): taps further
    // apart than a texel step over fine detail in the mirror, which then crawls as a ladder of lines.
    smear(reflTmp, reflBlur, 0, 2.5);
    smear(reflBlur, reflTmp, 0, 2.5);

    // Scene plus reflection, then the bloom onto the canvas.
    combined.use(gl, rw, rh);
    gl.useProgram(this.combineProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target.refl.texture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, reflTmp.texture);
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
    budget.end();
  }
}
