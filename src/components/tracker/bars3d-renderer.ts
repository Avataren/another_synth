import {
  BloomChain,
  MultisampleTarget,
  RenderTarget,
  linkProgram,
  uniformLocations,
  type UniformLocations,
} from 'src/components/tracker/glow-gl';
import {
  BARS3D_FRAGMENT_SHADER,
  BARS3D_VERTEX_SHADER,
  FLOOR_FRAGMENT_SHADER,
  FLOOR_VERTEX_SHADER,
  REFLECT_COMBINE_FRAGMENT_SHADER,
} from 'src/components/tracker/bars3d-shader';
import {
  BLUR_FRAGMENT_SHADER,
  BLUR_VERTEX_SHADER,
} from 'src/components/tracker/glow-scope-shader';
import { lookAt, multiply, perspective, transformPoint } from 'src/components/tracker/mat4';

const FOV_Y = (34 * Math.PI) / 180;
/** Width of the row of bars, world units, and the tallest a bar gets. */
const ROW_WIDTH = 5.6;
const MAX_HEIGHT = 1.9;
const FLOATS_PER_INSTANCE = 5;
const BLOOM_STRENGTH = 0.15;
const REFLECTION_STRENGTH = 0.4;
const BACKGROUND: readonly [number, number, number] = [0.008, 0.01, 0.017];

export interface Bars3dFrame {
  /** Bar heights and peak-marker heights, 0..1, for the first `bands` entries. */
  levels: ArrayLike<number>;
  peaks: ArrayLike<number>;
  bands: number;
  timeMs: number;
}

/** Unit box: 24 vertices (position, normal) and 36 indices. */
function boxMesh(): { vertices: Float32Array; indices: Uint16Array } {
  const faces: { n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }[] = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ];
  const vertices: number[] = [];
  const indices: number[] = [];
  faces.forEach((face, f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      // Centre of the face plus a step along each of its axes; then x, z in
      // -0.5..0.5 and y in 0..1.
      const p = [0, 1, 2].map(
        (i) => (face.n[i] ?? 0) * 0.5 + (face.u[i] ?? 0) * 0.5 * a + (face.v[i] ?? 0) * 0.5 * b,
      ) as [number, number, number];
      vertices.push(p[0], p[1] + 0.5, p[2], ...face.n);
    }
    const o = f * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/**
 * A 3D scene of glowing bars standing on a glossy floor: the bars are drawn
 * upright and mirrored, the mirror is blurred into a diffuse reflection and
 * faded with distance, and the sum goes through the bloom. The canvas is sized
 * by the caller.
 */
export class Bars3dRenderer {
  lost = false;

  private gl: WebGL2RenderingContext | null = null;
  private barsProgram: WebGLProgram | null = null;
  private floorProgram: WebGLProgram | null = null;
  private blurProgram: WebGLProgram | null = null;
  private combineProgram: WebGLProgram | null = null;
  private barsUniforms: UniformLocations = {};
  private floorUniforms: UniformLocations = {};
  private blurUniforms: UniformLocations = {};
  private combineUniforms: UniformLocations = {};
  private boxVao: WebGLVertexArrayObject | null = null;
  private floorVao: WebGLVertexArrayObject | null = null;
  private emptyVao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private instanceBuffer: WebGLBuffer | null = null;
  private scene: MultisampleTarget | null = null;
  private reflection: RenderTarget | null = null;
  private reflTmp: RenderTarget | null = null;
  private reflBlur: RenderTarget | null = null;
  private combined: RenderTarget | null = null;
  private bloom: BloomChain | null = null;
  private instances = new Float32Array(0);
  private readonly rect = new Float32Array(4);

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
    try {
      this.barsProgram = linkProgram(gl, BARS3D_VERTEX_SHADER, BARS3D_FRAGMENT_SHADER);
      this.floorProgram = linkProgram(gl, FLOOR_VERTEX_SHADER, FLOOR_FRAGMENT_SHADER);
      this.blurProgram = linkProgram(gl, BLUR_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
      this.combineProgram = linkProgram(gl, BLUR_VERTEX_SHADER, REFLECT_COMBINE_FRAGMENT_SHADER);
      this.bloom = new BloomChain(gl);
      this.scene = new MultisampleTarget(gl);
      this.reflection = new RenderTarget(gl, true);
      this.reflTmp = new RenderTarget(gl);
      this.reflBlur = new RenderTarget(gl);
      this.combined = new RenderTarget(gl);
    } catch (error) {
      console.error(error);
      return false;
    }
    this.barsUniforms = uniformLocations(gl, this.barsProgram, ['uViewProj', 'uSize', 'uMirror', 'uEye']);
    this.floorUniforms = uniformLocations(gl, this.floorProgram, ['uViewProj', 'uGlow']);
    this.blurUniforms = uniformLocations(gl, this.blurProgram, ['uSrc', 'uStep']);
    this.combineUniforms = uniformLocations(gl, this.combineProgram, [
      'uScene',
      'uRefl',
      'uBaseV',
      'uStrength',
    ]);

    const buffer = (target: number, data?: BufferSource): WebGLBuffer => {
      const b = gl.createBuffer();
      if (!b) throw new Error('createBuffer failed');
      gl.bindBuffer(target, b);
      if (data) gl.bufferData(target, data, gl.STATIC_DRAW);
      this.buffers.push(b);
      return b;
    };

    const mesh = boxMesh();
    this.boxVao = gl.createVertexArray();
    gl.bindVertexArray(this.boxVao);
    buffer(gl.ARRAY_BUFFER, mesh.vertices);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.instanceBuffer = buffer(gl.ARRAY_BUFFER);
    const stride = FLOATS_PER_INSTANCE * 4;
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    buffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);

    this.floorVao = gl.createVertexArray();
    gl.bindVertexArray(this.floorVao);
    buffer(gl.ARRAY_BUFFER, new Float32Array([-16, 0, -12, 16, 0, -12, -16, 0, 12, 16, 0, 12]));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.emptyVao = gl.createVertexArray();
    gl.bindVertexArray(null);
    this.gl = gl;
    return true;
  }

  private release(): void {
    const gl = this.gl;
    if (gl) {
      for (const b of this.buffers) gl.deleteBuffer(b);
      for (const vao of [this.boxVao, this.floorVao, this.emptyVao]) {
        if (vao) gl.deleteVertexArray(vao);
      }
      for (const p of [this.barsProgram, this.floorProgram, this.blurProgram, this.combineProgram]) {
        if (p) gl.deleteProgram(p);
      }
      for (const t of [this.scene, this.reflection, this.reflTmp, this.reflBlur, this.combined]) {
        t?.dispose(gl);
      }
      this.bloom?.dispose(gl);
    }
    this.buffers = [];
    this.boxVao = this.floorVao = this.emptyVao = null;
    this.barsProgram = this.floorProgram = this.blurProgram = this.combineProgram = null;
    this.scene = this.reflection = this.reflTmp = this.reflBlur = this.combined = null;
    this.bloom = null;
    this.gl = null;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.release();
    this.lost = true;
  }

  /** Draws one frame into the canvas, whose bitmap size the caller has set. */
  render(frame: Bars3dFrame): void {
    const gl = this.gl;
    const { scene, reflection, reflTmp, reflBlur, combined, bloom } = this;
    if (!gl || this.lost || !scene || !reflection || !reflTmp || !reflBlur || !combined || !bloom) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const bands = Math.max(1, frame.bands);

    // --- the camera: low and wide, drifting a little so the depth reads ---
    const aspect = width / Math.max(1, height);
    const t = frame.timeMs / 1000;
    const distance = Math.max(4.6, ((ROW_WIDTH / 2) * 1.12) / (Math.tan(FOV_Y / 2) * aspect));
    const eye = [Math.sin(t * 0.17) * 0.9, 1.0 + Math.sin(t * 0.11) * 0.05, distance] as const;
    const viewProj = multiply(
      perspective(FOV_Y, aspect, 0.1, 60),
      lookAt(eye, [0, 0.45, 0], [0, 1, 0]),
    );
    const contact = transformPoint(viewProj, [0, 0, 0]);
    const baseV = (contact[1] / (contact[3] || 1)) * 0.5 + 0.5;

    // --- one instance per bar and per peak cap ---
    const pitch = ROW_WIDTH / bands;
    const barWidth = pitch * 0.62;
    const need = bands * 2 * FLOATS_PER_INSTANCE;
    if (this.instances.length < need) this.instances = new Float32Array(need);
    let loud = 0;
    let n = 0;
    for (let b = 0; b < bands; b++) {
      const x = (b - (bands - 1) / 2) * pitch;
      const tt = bands > 1 ? b / (bands - 1) : 0;
      const level = Math.min(1, Math.max(0, frame.levels[b] ?? 0));
      const peak = Math.min(1, Math.max(0, frame.peaks[b] ?? 0));
      loud += level;
      this.instances.set([x, 0, Math.max(0.02, level * MAX_HEIGHT), tt, 0], n);
      n += FLOATS_PER_INSTANCE;
      this.instances.set([x, peak * MAX_HEIGHT + 0.04, 0.035, tt, 1], n);
      n += FLOATS_PER_INSTANCE;
    }
    const count = n / FLOATS_PER_INSTANCE;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.instances.subarray(0, n), gl.DYNAMIC_DRAW);

    const drawBars = (mirror: number): void => {
      gl.useProgram(this.barsProgram);
      gl.bindVertexArray(this.boxVao);
      gl.uniformMatrix4fv(this.barsUniforms.uViewProj ?? null, false, viewProj);
      gl.uniform2f(this.barsUniforms.uSize ?? null, barWidth, barWidth);
      gl.uniform1f(this.barsUniforms.uMirror ?? null, mirror);
      gl.uniform3f(this.barsUniforms.uEye ?? null, eye[0], eye[1], eye[2]);
      gl.drawElementsInstanced(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0, count);
    };

    // 1. floor and bars
    scene.use(gl, width, height);
    gl.clearColor(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.floorProgram);
    gl.bindVertexArray(this.floorVao);
    gl.uniformMatrix4fv(this.floorUniforms.uViewProj ?? null, false, viewProj);
    gl.uniform1f(this.floorUniforms.uGlow ?? null, Math.min(1, loud / bands / 0.4));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    drawBars(1);
    scene.resolve(gl);

    // 2. the mirrored bars, at half resolution
    const rw = Math.max(1, width >> 1);
    const rh = Math.max(1, height >> 1);
    reflection.use(gl, rw, rh);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawBars(-1);

    // 3. smear the mirror: long vertically, barely across, so the colours stay apart
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.blurProgram);
    gl.bindVertexArray(this.emptyVao);
    gl.uniform1i(this.blurUniforms.uSrc ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    const smear = (from: RenderTarget, into: RenderTarget, dx: number, dy: number): void => {
      into.use(gl, rw, rh);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(this.blurUniforms.uStep ?? null, dx / rw, dy / rh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    smear(reflection, reflTmp, 0.8, 0);
    smear(reflTmp, reflBlur, 0, 6);
    smear(reflBlur, reflTmp, 1.2, 0);
    smear(reflTmp, reflBlur, 0, 10);

    // 4. scene + reflection
    combined.use(gl, width, height);
    gl.useProgram(this.combineProgram);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, reflBlur.texture);
    gl.uniform1i(this.combineUniforms.uScene ?? null, 0);
    gl.uniform1i(this.combineUniforms.uRefl ?? null, 1);
    gl.uniform1f(this.combineUniforms.uBaseV ?? null, baseV);
    gl.uniform1f(this.combineUniforms.uStrength ?? null, REFLECTION_STRENGTH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);

    // 5. bloom, onto the canvas
    this.rect[0] = 0;
    this.rect[1] = 0;
    this.rect[2] = width;
    this.rect[3] = height;
    bloom.apply(gl, combined, width, height, this.rect, 1, BLOOM_STRENGTH);
  }
}
