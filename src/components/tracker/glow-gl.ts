import {
  BLOOM_FRAGMENT_SHADER,
  BLUR_FRAGMENT_SHADER,
  BLUR_VERTEX_SHADER,
  CRT_VERTEX_SHADER,
} from 'src/components/tracker/glow-scope-shader';

/** WebGL2 plumbing shared by the glow scope renderer and the 3D bars scene. */

export type UniformLocations = Record<string, WebGLUniformLocation | null>;

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`glow scope shader: ${log ?? 'compile failed'}`);
  }
  return shader;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertex);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`glow scope program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  }
  return program;
}

export function uniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: string[],
): UniformLocations {
  const out: UniformLocations = {};
  for (const name of names) out[name] = gl.getUniformLocation(program, name);
  return out;
}

/** A texture with a framebuffer on it (and optionally a depth buffer), resized on demand. */
export class RenderTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  private readonly depth: WebGLRenderbuffer | null;
  width = 0;
  height = 0;

  constructor(gl: WebGL2RenderingContext, withDepth = false) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    const depth = withDepth ? gl.createRenderbuffer() : null;
    if (!texture || !framebuffer || (withDepth && !depth)) {
      throw new Error('render target allocation failed');
    }
    this.texture = texture;
    this.framebuffer = framebuffer;
    this.depth = depth;
  }

  /** Makes it `width` x `height` and binds it for drawing. */
  use(gl: WebGL2RenderingContext, width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    if (this.width !== w || this.height !== h) {
      this.width = w;
      this.height = h;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      if (this.depth) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      }
    }
    gl.viewport(0, 0, w, h);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteTexture(this.texture);
    gl.deleteFramebuffer(this.framebuffer);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
  }
}

/**
 * A multisampled colour + depth target (MSAA) that resolves into a plain
 * texture: draw into it after `use`, call `resolve`, then sample `texture`.
 * Falls back to fewer samples where the hardware allows fewer.
 */
export class MultisampleTarget {
  private readonly resolved: RenderTarget;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly color: WebGLRenderbuffer;
  private readonly depth: WebGLRenderbuffer;
  private readonly samples: number;
  private width = 0;
  private height = 0;

  constructor(gl: WebGL2RenderingContext, samples = 4) {
    const framebuffer = gl.createFramebuffer();
    const color = gl.createRenderbuffer();
    const depth = gl.createRenderbuffer();
    if (!framebuffer || !color || !depth) throw new Error('render target allocation failed');
    this.framebuffer = framebuffer;
    this.color = color;
    this.depth = depth;
    this.resolved = new RenderTarget(gl);
    this.samples = Math.max(0, Math.min(samples, gl.getParameter(gl.MAX_SAMPLES) as number));
  }

  /** The resolved result. */
  get texture(): WebGLTexture {
    return this.resolved.texture;
  }

  /** Makes it `width` x `height` and binds it for drawing. */
  use(gl: WebGL2RenderingContext, width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (this.width !== w || this.height !== h) {
      this.width = w;
      this.height = h;
      this.resolved.use(gl, w, h); // allocates the texture
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT16, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, w, h);
  }

  /** Averages the samples into `texture`. */
  resolve(gl: WebGL2RenderingContext): void {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteRenderbuffer(this.color);
    gl.deleteRenderbuffer(this.depth);
    this.resolved.dispose(gl);
  }
}

/** Blur levels of the bloom, each half the size of the one before. */
const BLOOM_LEVELS = 4;

/**
 * The bloom post-process: blurs a source texture down a chain of half-size
 * targets (horizontal then vertical gaussian at every level, each reading the
 * last, so the radii double) and adds the levels back over rectangles of the
 * default framebuffer.
 */
export class BloomChain {
  private readonly blurProgram: WebGLProgram;
  private readonly bloomProgram: WebGLProgram;
  private readonly blurUniforms: UniformLocations;
  private readonly bloomUniforms: UniformLocations;
  private readonly emptyVao: WebGLVertexArrayObject | null;
  private readonly rectVao: WebGLVertexArrayObject | null;
  private readonly cornerBuffer: WebGLBuffer | null;
  private readonly rectBuffer: WebGLBuffer | null;
  private readonly tmp: RenderTarget[] = [];
  private readonly blur: RenderTarget[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.blurProgram = linkProgram(gl, BLUR_VERTEX_SHADER, BLUR_FRAGMENT_SHADER);
    this.bloomProgram = linkProgram(gl, CRT_VERTEX_SHADER, BLOOM_FRAGMENT_SHADER);
    this.blurUniforms = uniformLocations(gl, this.blurProgram, ['uSrc', 'uStep']);
    this.bloomUniforms = uniformLocations(gl, this.bloomProgram, [
      'uScene',
      'uBloom0',
      'uBloom1',
      'uBloom2',
      'uBloom3',
      'uResolution',
      'uStrength',
    ]);
    this.emptyVao = gl.createVertexArray();

    // A 0..1 quad, instanced once per rectangle to composite over.
    this.rectVao = gl.createVertexArray();
    gl.bindVertexArray(this.rectVao);
    this.cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.rectBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    for (let i = 0; i < BLOOM_LEVELS; i++) {
      this.tmp.push(new RenderTarget(gl));
      this.blur.push(new RenderTarget(gl));
    }
  }

  /**
   * Blurs `source` (a `width` x `height` texture) and draws source plus bloom
   * into each of the `count` rectangles (x, y, w, h in device pixels, y down)
   * of `rects` on the default framebuffer, which is cleared first.
   */
  apply(
    gl: WebGL2RenderingContext,
    source: RenderTarget,
    width: number,
    height: number,
    rects: Float32Array,
    count: number,
    strength: number,
  ): void {
    gl.disable(gl.BLEND);
    gl.useProgram(this.blurProgram);
    gl.bindVertexArray(this.emptyVao);
    gl.uniform1i(this.blurUniforms.uSrc ?? null, 0);
    gl.activeTexture(gl.TEXTURE0);
    let from = source;
    let sw = width;
    let sh = height;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const tmp = this.tmp[i];
      const blur = this.blur[i];
      if (!tmp || !blur) return;
      const dw = Math.max(1, sw >> 1);
      const dh = Math.max(1, sh >> 1);
      tmp.use(gl, dw, dh);
      gl.bindTexture(gl.TEXTURE_2D, from.texture);
      gl.uniform2f(this.blurUniforms.uStep ?? null, 1.5 / sw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      blur.use(gl, dw, dh);
      gl.bindTexture(gl.TEXTURE_2D, tmp.texture);
      gl.uniform2f(this.blurUniforms.uStep ?? null, 0, 1.5 / dh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      from = blur;
      sw = dw;
      sh = dh;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (count === 0) return;
    gl.useProgram(this.bloomProgram);
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, rects.subarray(0, count * 4), gl.DYNAMIC_DRAW);
    const textures = [source, ...this.blur];
    const names = ['uScene', 'uBloom0', 'uBloom1', 'uBloom2', 'uBloom3'];
    textures.forEach((target, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      gl.uniform1i(this.bloomUniforms[names[unit] as string] ?? null, unit);
    });
    gl.uniform2f(this.bloomUniforms.uResolution ?? null, width, height);
    gl.uniform1f(this.bloomUniforms.uStrength ?? null, strength);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(gl: WebGL2RenderingContext): void {
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.bloomProgram);
    if (this.emptyVao) gl.deleteVertexArray(this.emptyVao);
    if (this.rectVao) gl.deleteVertexArray(this.rectVao);
    if (this.cornerBuffer) gl.deleteBuffer(this.cornerBuffer);
    if (this.rectBuffer) gl.deleteBuffer(this.rectBuffer);
    for (const target of [...this.tmp, ...this.blur]) target.dispose(gl);
  }
}
