import { describe, expect, it, vi } from 'vitest';
import { GpuRenderBudget } from '../components/tracker/gpu-render-budget';

function fixture(timers = true) {
  const state = { available: false, disjoint: false, ns: 7_000_000 };
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () =>
      timers ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null,
    getParameter: () => state.disjoint,
    getQueryParameter: vi.fn((_query: WebGLQuery, parameter: number) =>
      parameter === 1 ? state.available : state.ns,
    ),
    createQuery: vi.fn((): WebGLQuery => ({})),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    deleteQuery: vi.fn(),
  };
  const budget = new GpuRenderBudget(gl);
  const record = vi.spyOn(budget.quality, 'recordGpu');
  const draw = () => {
    budget.begin(750, 225);
    budget.end();
  };
  return { gl, state, budget, record, draw };
}

describe('asynchronous GPU render budget', () => {
  it('samples every sixth frame and only reads completed results', () => {
    const { gl, state, budget, record, draw } = fixture();
    for (let i = 0; i < 6; i++) draw();
    expect(gl.beginQuery).toHaveBeenCalledTimes(1);
    budget.update(0, 1000, 300);
    expect(record).not.toHaveBeenCalled();
    expect(gl.getQueryParameter).toHaveBeenCalledTimes(1);
    state.available = true;
    budget.update(16.7, 1000, 300);
    expect(record).toHaveBeenCalledWith(7, 16.7);
    expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
  });

  it('limits pending queries and releases them on disposal', () => {
    const { gl, budget, draw } = fixture();
    for (let i = 0; i < 60; i++) draw();
    expect(gl.createQuery).toHaveBeenCalledTimes(4);
    budget.dispose();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(4);
    budget.dispose();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(4);
  });

  it('drops disjoint measurements without waiting for completion', () => {
    const { gl, state, budget, record, draw } = fixture();
    for (let i = 0; i < 6; i++) draw();
    state.disjoint = true;
    budget.update(0, 1000, 300);
    expect(record).not.toHaveBeenCalled();
    expect(gl.getQueryParameter).not.toHaveBeenCalled();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
  });

  it('discards results from the previous resolution', () => {
    const { gl, state, budget, record, draw } = fixture();
    for (let i = 0; i < 6; i++) draw();
    state.available = true;
    budget.quality.scale = 0.5;
    budget.update(0, 1000, 300);
    expect(record).not.toHaveBeenCalled();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
  });

  it('ends and releases an active query when disposed', () => {
    const { gl, budget, draw } = fixture();
    for (let i = 0; i < 5; i++) draw();
    budget.begin(750, 225);
    budget.dispose();
    expect(gl.endQuery).toHaveBeenCalledTimes(1);
    expect(gl.deleteQuery).toHaveBeenCalledTimes(1);
  });

  it('adapts to sustained slow frames when GPU timers are unavailable', () => {
    const { gl, budget, draw } = fixture(false);
    for (let time = 0; time <= 1000; time += 125) {
      draw();
      budget.update(time, 1000, 300);
    }
    expect(gl.createQuery).not.toHaveBeenCalled();
    expect(budget.quality.scale).toBeLessThan(0.5);
  });
});
