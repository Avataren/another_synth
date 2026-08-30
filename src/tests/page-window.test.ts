import { describe, it, expect } from 'vitest';
import { visiblePageWindow } from 'src/components/tracker/page-window';

/**
 * The instrument pager shows five page numbers out of twenty-six. What matters
 * is that the window is the same size wherever it sits -- a strip that shrinks
 * near the ends makes the panel header jump as you page through it -- and that
 * it always contains the page you are on.
 */
describe('the page window', () => {
  const TOTAL = 26;
  const SIZE = 5;

  it('centres on the current page in the middle of the range', () => {
    expect(visiblePageWindow(10, TOTAL, SIZE)).toEqual([8, 9, 10, 11, 12]);
  });

  it('sits flush against the start rather than running past it', () => {
    expect(visiblePageWindow(0, TOTAL, SIZE)).toEqual([0, 1, 2, 3, 4]);
    expect(visiblePageWindow(1, TOTAL, SIZE)).toEqual([0, 1, 2, 3, 4]);
    expect(visiblePageWindow(2, TOTAL, SIZE)).toEqual([0, 1, 2, 3, 4]);
    expect(visiblePageWindow(3, TOTAL, SIZE)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sits flush against the end rather than running past it', () => {
    expect(visiblePageWindow(25, TOTAL, SIZE)).toEqual([21, 22, 23, 24, 25]);
    expect(visiblePageWindow(24, TOTAL, SIZE)).toEqual([21, 22, 23, 24, 25]);
    expect(visiblePageWindow(23, TOTAL, SIZE)).toEqual([21, 22, 23, 24, 25]);
    expect(visiblePageWindow(22, TOTAL, SIZE)).toEqual([20, 21, 22, 23, 24]);
  });

  it('keeps one width everywhere, and always holds the current page', () => {
    for (let page = 0; page < TOTAL; page++) {
      const window = visiblePageWindow(page, TOTAL, SIZE);
      expect(window).toHaveLength(SIZE);
      expect(window).toContain(page);
      // Contiguous and in range.
      expect(window[0]).toBeGreaterThanOrEqual(0);
      expect(window[window.length - 1]).toBeLessThan(TOTAL);
      for (let i = 1; i < window.length; i++) {
        expect(window[i]).toBe(window[i - 1]! + 1);
      }
    }
  });

  it('shows every page when there are fewer than the window holds', () => {
    expect(visiblePageWindow(1, 3, SIZE)).toEqual([0, 1, 2]);
    expect(visiblePageWindow(0, 1, SIZE)).toEqual([0]);
  });

  it('returns nothing rather than throwing on degenerate input', () => {
    expect(visiblePageWindow(0, 0, SIZE)).toEqual([]);
    expect(visiblePageWindow(0, TOTAL, 0)).toEqual([]);
  });
});
