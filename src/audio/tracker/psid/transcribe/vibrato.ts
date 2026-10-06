/** GoatTracker's vibrato as a speed-table row: the shapes it can swing in, and the row that fits a swing. */

/** GoatTracker's vibrato (player.s `mt_effect_4`) for compare value `speed`: per frame, +1 (add) or -1 (subtract). */
function gtVibratoDirections(speed: number, frames: number): number[] {
  const out: number[] = [];
  let time = 0;
  for (let f = 0; f < frames; f++) {
    let a = time;
    if (a & 0x80 || a <= speed) a = (a + 2) & 0xff;
    else a = ((a ^ 0xff) + 2) & 0xff;
    time = a;
    out.push(a & 1 ? -1 : 1);
  }
  return out;
}

interface VibratoShape {
  readonly period: number;
  /** Peak to peak, in steps. */
  readonly span: number;
}

const VIBRATO_SHAPES: ReadonlyMap<number, VibratoShape> = (() => {
  const m = new Map<number, VibratoShape>();
  for (let s = 1; s <= 30; s++) {
    let pos = 0;
    const path = gtVibratoDirections(s, 200).map((d) => (pos += d));
    const tail = path.slice(100);
    const span = Math.max(...tail) - Math.min(...tail);
    for (let p = 2; p < 64; p++) {
      if (tail.slice(0, 60).every((v, i) => v === tail[i + p])) {
        m.set(s, { period: p, span });
        break;
      }
    }
  }
  return m;
})();


/** The speed-table row (`deeper`: extra depth shifts, for a pattern vibrato, which the player swings about 4 times deeper than an instrument's model; `left` $80 | compare value, `right` the depth shift) of a swing of `period` frames and `span` semitones peak to peak. */
export function vibratoFor(period: number, span: number, deeper = 0): { left: number; right: number } {
  let speed = 1;
  let bestErr = Infinity;
  for (const [s, shape] of VIBRATO_SHAPES) {
    const err = Math.abs(shape.period - period);
    if (err < bestErr) [speed, bestErr] = [s, err];
  }
  const shape = VIBRATO_SHAPES.get(speed)!;
  // One step of the calculated speed is 1 / 2^shift of the note step.
  const shift = Math.max(0, Math.min(8, Math.round(Math.log2(shape.span / span))));
  return { left: 0x80 | speed, right: Math.min(8, shift + deeper) };
}
