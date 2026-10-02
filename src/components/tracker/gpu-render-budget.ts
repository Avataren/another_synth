import { RenderQuality } from './render-quality';

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

// Keep untyped WebGL query/extension results at the boundary.
interface TimerContext {
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
  getExtension(name: string): TimerExtension | null;
  getParameter(parameter: number): unknown;
  getQueryParameter(query: WebGLQuery, parameter: number): unknown;
  createQuery(): WebGLQuery | null;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  deleteQuery(query: WebGLQuery): void;
}

/** Sparse, nonblocking GPU measurements shared by both ray-based visualizers. */
export class GpuRenderBudget {
  readonly quality = new RenderQuality();
  private readonly timer: TimerExtension | null;
  private readonly pending: { query: WebGLQuery; pixels: number }[] = [];
  private active: { query: WebGLQuery; pixels: number } | null = null;
  private frames = 0;

  constructor(private readonly gl: TimerContext) {
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  update(timeMs: number, width: number, height: number): void {
    const gl = this.gl;
    if (this.timer) {
      const disjoint: unknown = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
      const pixels =
        Math.round(width * this.quality.scale) *
        Math.round(height * this.quality.scale);
      while (this.pending.length > 0) {
        const result = this.pending[0];
        if (!result) break;
        if (
          !disjoint &&
          !gl.getQueryParameter(result.query, gl.QUERY_RESULT_AVAILABLE)
        )
          break;
        if (!disjoint && result.pixels === pixels) {
          const ns: unknown = gl.getQueryParameter(
            result.query,
            gl.QUERY_RESULT,
          );
          if (typeof ns === 'number') this.quality.recordGpu(ns / 1e6, timeMs);
        }
        gl.deleteQuery(result.query);
        this.pending.shift();
      }
    }
    this.quality.update(timeMs, width * height);
  }

  begin(width: number, height: number): void {
    if (!this.timer || ++this.frames % 6 !== 0 || this.pending.length >= 4)
      return;
    const query = this.gl.createQuery();
    if (!query) return;
    this.active = { query, pixels: width * height };
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
  }

  end(): void {
    if (!this.timer || !this.active) return;
    this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  dispose(): void {
    if (this.active && this.timer) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active.query);
    }
    for (const { query } of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
    this.active = null;
  }
}
