import { describe, expect, it } from 'vitest';
import { lookAt, multiply, perspective, transformPoint } from 'src/components/tracker/mat4';

describe('mat4', () => {
  it('a look-at view puts the target straight ahead of the eye', () => {
    const view = lookAt([0, 1, 5], [0, 1, 0], [0, 1, 0]);
    const p = transformPoint(view, [0, 1, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(-5); // five units down -z
  });

  it('keeps the target at the centre of the screen from any eye position', () => {
    const proj = perspective(1, 2, 0.1, 50);
    for (const eye of [[0.9, 0.5, 4.6], [-0.9, 0.5, 4.6], [0, 3, 4], [2, 1, -3]] as const) {
      const m = multiply(proj, lookAt(eye, [0, 0.85, 0], [0, 1, 0]));
      const [x, y, , w] = transformPoint(m, [0, 0.85, 0]);
      expect(x / w).toBeCloseTo(0);
      expect(y / w).toBeCloseTo(0);
    }
  });

  it('puts a point to the right of the target on the right of the screen', () => {
    const m = multiply(
      perspective(1, 2, 0.1, 50),
      lookAt([0.9, 0.5, 4.6], [0, 0.85, 0], [0, 1, 0]),
    );
    const [x, , , w] = transformPoint(m, [1, 0.85, 0]);
    expect(x / w).toBeGreaterThan(0);
  });

  it('projects the point straight ahead to the centre of the screen', () => {
    const m = multiply(perspective(1, 2, 0.1, 50), lookAt([0, 0, 4], [0, 0, 0], [0, 1, 0]));
    const [x, y, , w] = transformPoint(m, [0, 0, 0]);
    expect(x / w).toBeCloseTo(0);
    expect(y / w).toBeCloseTo(0);
    expect(w).toBeGreaterThan(0);
  });

  it('a point above the target lands in the upper half of the screen', () => {
    const m = multiply(perspective(1, 2, 0.1, 50), lookAt([0, 0, 4], [0, 0, 0], [0, 1, 0]));
    const [, y, , w] = transformPoint(m, [0, 1, 0]);
    expect(y / w).toBeGreaterThan(0);
  });

  it('keeps the aspect: the same offset sideways is narrower on a wider screen', () => {
    const view = lookAt([0, 0, 4], [0, 0, 0], [0, 1, 0]);
    const narrow = transformPoint(multiply(perspective(1, 1, 0.1, 50), view), [1, 0, 0]);
    const wide = transformPoint(multiply(perspective(1, 2, 0.1, 50), view), [1, 0, 0]);
    expect(wide[0] / wide[3]).toBeCloseTo((narrow[0] / narrow[3]) / 2);
  });

  it('multiplies matrices in the order b first, then a', () => {
    const t = new Float32Array(16);
    t[0] = t[5] = t[10] = t[15] = 1;
    t[12] = 3; // translate x by 3
    const s = new Float32Array(16);
    s[0] = 2;
    s[5] = s[10] = s[15] = 1; // scale x by 2
    const scaleThenTranslate = multiply(t, s);
    expect(transformPoint(scaleThenTranslate, [1, 0, 0])[0]).toBeCloseTo(5);
    const translateThenScale = multiply(s, t);
    expect(transformPoint(translateThenScale, [1, 0, 0])[0]).toBeCloseTo(8);
  });
});
