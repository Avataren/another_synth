import {
  RenderTarget,
  linkProgram,
  uniformLocations,
  type UniformLocations,
} from './glow-gl';
import { RAYMARCH_VERTEX_SHADER } from './raymarch-shader';
import { TERRAIN_HEIGHT_GLSL } from './terrain-shader';
import {
  TERRAIN_BOUND_FRAGMENT_SHADER,
  TERRAIN_PACK_GLSL,
} from './terrain-surface';

const ATLAS_SHADER =
  TERRAIN_HEIGHT_GLSL +
  TERRAIN_PACK_GLSL +
  `
uniform vec2 uSurfaceOrigin;
uniform vec2 uSurfaceStep;
void main() {
  vec2 grid = uSurfaceOrigin + (gl_FragCoord.xy - 0.5) * uSurfaceStep;
  vec2 xz = vec2(grid.x, uZ0 - grid.y);
  outColor = vec4(packHeight(height(xz, 4, 0.0)), packHeight(SEA + bowWave(xz)));
}
`;

// Micro relief remains in close-up procedural normals. Keeping it out of the
// visibility atlas avoids changing a parcel's geometry with distance-dependent LOD.

export class TerrainAtlas {
  readonly surface: RenderTarget;
  readonly bounds: readonly [RenderTarget, RenderTarget, RenderTarget];
  readonly program: WebGLProgram;
  readonly uniforms: UniformLocations;
  private readonly boundProgram: WebGLProgram;
  private readonly boundUniforms: UniformLocations;
  origin: [number, number] = [0, 0];
  step: [number, number] = [0, 0];

  constructor(gl: WebGL2RenderingContext) {
    this.program = linkProgram(gl, RAYMARCH_VERTEX_SHADER, ATLAS_SHADER);
    this.boundProgram = linkProgram(
      gl,
      RAYMARCH_VERTEX_SHADER,
      TERRAIN_BOUND_FRAGMENT_SHADER,
    );
    this.uniforms = uniformLocations(gl, this.program, [
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
      'uTime',
      'uSurfaceOrigin',
      'uSurfaceStep',
    ]);
    this.boundUniforms = uniformLocations(gl, this.boundProgram, [
      'uSource',
      'uVertices',
    ]);
    this.surface = new RenderTarget(gl);
    this.bounds = [
      new RenderTarget(gl),
      new RenderTarget(gl),
      new RenderTarget(gl),
    ];
  }

  /** Four samples per band, two per archive interval. The grid travels WITH the parcels. */
  use(
    gl: WebGL2RenderingContext,
    bands: number,
    halfWidth: number,
    dz: number,
    phase: number,
  ): void {
    const dx = (2 * halfWidth) / (bands - 1) / 4;
    const dy = dz / 2;
    const apron = Math.ceil((halfWidth * 0.6) / dx);
    const xmin = -halfWidth - apron * dx;
    const dmin = Math.floor(-6 / dy) * dy + phase * dz;
    this.origin = [xmin, dmin];
    this.step = [dx, dy];
    // Divisibility by eight keeps all bound reductions aligned with the traversal tiles.
    const width = Math.ceil(((2 * halfWidth) / dx + 2 * apron + 1) / 8) * 8;
    const height = Math.ceil((78 / dy + 1) / 8) * 8;
    this.surface.use(gl, width, height);
    gl.useProgram(this.program);
    gl.uniform2fv(this.uniforms.uSurfaceOrigin ?? null, this.origin);
    gl.uniform2fv(this.uniforms.uSurfaceStep ?? null, this.step);
  }

  reduce(gl: WebGL2RenderingContext): void {
    gl.useProgram(this.boundProgram);
    gl.uniform1i(this.boundUniforms.uSource ?? null, 0);
    let source = this.surface;
    for (const [index, target] of this.bounds.entries()) {
      target.use(gl, source.width / 2, source.height / 2);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform1i(this.boundUniforms.uVertices ?? null, index === 0 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = target;
    }
  }

  get boundTexture(): WebGLTexture {
    return this.bounds[2].texture;
  }

  dispose(gl: WebGL2RenderingContext): void {
    this.surface.dispose(gl);
    for (const bound of this.bounds) bound.dispose(gl);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.boundProgram);
  }
}
