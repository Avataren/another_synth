#!/usr/bin/env node
/**
 * Writes the format-branding art to src/assets/format-brands/: for each brand
 * a mark (48x48 tile), a badge label and a wordmark.
 *
 * Every drawing here is our own: a period tribute to the platform a format
 * comes from (Amiga, PC DOS, C64), never a copy or tracing of a real
 * program's logo. The lettering is a 5x7 pixel font drawn for this file.
 *
 * Badge labels and wordmarks draw their letters in `currentColor`, so the
 * component colours them from the brand palette and one file serves every
 * theme. Marks carry their own ground and fixed colours. No SVG has an `id`
 * (the same file can be inlined many times on one page) or any external
 * reference. Re-run after changing a drawing:
 *
 *   node scripts/generate-format-brand-art.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'format-brands');

// ------------------------------------------------------------------ pixel font
const FONT = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', C: '.####|#....|#....|#....|#....|#....|.####',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.', E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####', K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####', M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  3: '####.|....#|....#|.###.|....#|....#|####.',
};

/** Every cell of `text` on the 5x7 grid (1 column gap), lit or not. */
function cells(text) {
  const out = [];
  let x = 0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for "${ch}"`);
    glyph.split('|').forEach((row, y) => {
      [...row].forEach((c, dx) => out.push({ x: x + dx, y, on: c === '#' }));
    });
    x += 6;
  }
  return { cells: out, cols: x - 1 };
}

const n = (v) => Number(v.toFixed(2));
const rects = (pts, pw, ph, dx = 0, dy = 0) =>
  pts.map((p) => `M${n(p.x * pw + dx)} ${n(p.y * ph + dy)}h${pw}v${ph}h-${pw}z`).join('');
const svg = (viewBox, body, label, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${label}"${extra}>${body}</svg>\n`;

/** Letters lit on the grid, and those on the rim of a stroke (a lit neighbour missing). */
function litSets(all) {
  const lit = all.filter((c) => c.on);
  const key = new Set(lit.map((c) => `${c.x},${c.y}`));
  const rim = lit.filter((c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !key.has(`${c.x + dx},${c.y + dy}`)));
  return { lit, rim };
}

// ------------------------------------------------------------------ lettering styles
/**
 * The era's lettering at pixel size `pw` x `ph`: returns the body and its size.
 * Letters are `currentColor`; effects are fixed alphas of black/white or `alt`.
 */
function lettering(text, style, pw, ph, alt) {
  const { cells: all, cols } = cells(text);
  const { lit, rim } = litSets(all);
  const W = cols * pw;
  const H = 7 * ph;
  const off = Math.max(1, pw / 2);
  switch (style) {
    case 'amiga': // hard drop shadow
      return { W: W + off, H: H + off, body:
        `<path d="${rects(lit, pw, ph, off, off)}" fill="${alt ?? 'currentColor'}"${alt ? '' : ' opacity=".35"'}/>` +
        `<path d="${rects(lit, pw, ph)}" fill="currentColor"/>` };
    case 'copper': // raster bands through the letters
      return { W, H, body:
        `<path d="${rects(lit.filter((c) => c.y % 2 === 0), pw, ph)}" fill="currentColor"/>` +
        `<path d="${rects(lit.filter((c) => c.y % 2 === 1), pw, ph)}" fill="currentColor" opacity=".62"/>` };
    case 'hive': // hollow strokes
      return { W, H, body:
        `<path d="${rects(lit, pw, ph)}" fill="currentColor" opacity=".3"/>` +
        `<path d="${rects(rim, pw, ph)}" fill="currentColor"/>` };
    case 'bevel': // DOS-GUI bevel
      return { W: W + 2 * off, H: H + 2 * off, body:
        `<path d="${rects(lit, pw, ph, 2 * off, 2 * off)}" fill="#000" opacity=".4"/>` +
        `<path d="${rects(lit, pw, ph)}" fill="#fff" opacity=".45"/>` +
        `<path d="${rects(lit, pw, ph, off, off)}" fill="currentColor"/>` };
    case 'textmode': { // inverse video: an ink block with the letters cut out
      const p = pw;
      return { W: W + 2 * p, H: H + 2 * p, body:
        `<path d="M0 0h${W + 2 * p}v${H + 2 * p}h-${W + 2 * p}z${rects(lit, pw, ph, p, p)}" fill="currentColor" fill-rule="evenodd"/>` };
    }
    case 'c64': // wide strokes, the C64 screen font's weight
      return { W, H, body: `<path d="${rects(lit, pw, ph)}" fill="currentColor"/>` };
    case 'dotmatrix': { // LEDs, lit and unlit: a tape counter
      const r = n(Math.min(pw, ph) * 0.42);
      const dots = (pts) => pts.map((c) => `<circle cx="${n(c.x * pw + pw / 2)}" cy="${n(c.y * ph + ph / 2)}" r="${r}"/>`).join('');
      return { W, H, body:
        `<g fill="${alt ?? 'currentColor'}" opacity="${alt ? '.35' : '.22'}">${dots(all.filter((c) => !c.on))}</g>` +
        `<g fill="currentColor">${dots(lit)}</g>` };
    }
    default:
      throw new Error(`Unknown style ${style}`);
  }
}

/** The badge's label: small, letters in the ink colour. */
function badgeLabel(text, style) {
  const pw = style === 'c64' ? 3 : 2;
  const { W, H, body } = lettering(text, style, pw, 2);
  const pad = 1;
  return svg(`${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`, body, text,
    style === 'dotmatrix' ? '' : ' shape-rendering="crispEdges"');
}

/** The wordmark: large lettering in the accent; FerroTracker adds its second line. */
function wordmark(text, style, alt, label) {
  const [top, sub] = text.split(' ');
  const pw = style === 'c64' ? 5 : 4;
  const main = lettering(top, style, pw, 4, alt);
  if (style === 'c64') { // the screen inside its border
    const b = 6;
    const W = main.W + 4 * b;
    const H = main.H + 4 * b;
    return svg(`0 0 ${W} ${H}`,
      `<rect width="${W}" height="${H}" fill="${alt}"/><rect x="${b}" y="${b}" width="${W - 2 * b}" height="${H - 2 * b}" fill="#352879"/>` +
      `<g transform="translate(${2 * b} ${2 * b})">${main.body}</g>`, label, ' shape-rendering="crispEdges"');
  }
  if (!sub) {
    return svg(`0 0 ${main.W} ${main.H}`, main.body, label, style === 'dotmatrix' ? '' : ' shape-rendering="crispEdges"');
  }
  const small = lettering(sub, style, 2, 2, alt);
  const gap = 6;
  const W = Math.max(main.W, small.W);
  const H = main.H + gap + small.H;
  return svg(`0 0 ${W} ${H}`,
    `<g transform="translate(${n((W - main.W) / 2)} 0)">${main.body}</g>` +
    `<g transform="translate(${n((W - small.W) / 2)} ${main.H + gap})">${small.body}</g>`, label);
}

// ------------------------------------------------------------------ marks (48x48)
const mark = (body, label) => svg('0 0 48 48', body, label);
const MARKS = {
  // Two spoked reels and a strip of oxide tape over the head.
  native: mark('<rect width="48" height="48" rx="10" fill="#10161f"/>' +
    '<path d="M8 27Q8 38 15 38H33Q40 38 40 27" fill="none" stroke="#b5653a" stroke-width="3"/>' +
    '<rect x="20" y="35" width="8" height="6" rx="1" fill="#e9eef7"/>' +
    [[14, 0], [34, 40]].map(([cx, turn]) => `<g transform="translate(${cx} 20)"><circle r="10" fill="#1b2430" stroke="#b8f35a" stroke-width="2.6"/>` +
      [0, 120, 240].map((a) => `<rect x="-1.3" y="-8.4" width="2.6" height="5" rx="1" fill="#b8f35a" transform="rotate(${a + turn})"/>`).join('') +
      '<circle r="2.6" fill="#b8f35a"/></g>').join(''), 'FerroTracker'),
  // A 3.5" disk whose label is four channel meters.
  mod: mark('<rect width="48" height="48" rx="6" fill="#1f4f9c"/>' +
    '<path d="M9 7h26l6 6v28H9z" fill="#e9eef7"/><rect x="16" y="7" width="15" height="11" fill="#1f4f9c"/>' +
    '<rect x="25" y="9" width="4" height="7" fill="#e9eef7"/><rect x="13" y="22" width="24" height="16" fill="#0e2146"/>' +
    '<g fill="#ff7a2e"><rect x="15" y="30" width="4" height="7"/><rect x="20" y="25" width="4" height="12"/>' +
    '<rect x="25" y="28" width="4" height="9"/><rect x="30" y="32" width="4" height="5"/></g>', 'Amiga MOD'),
  // Copper bars under a square wave.
  ahx: mark('<rect width="48" height="48" rx="6" fill="#241034"/>' +
    [['12', '#7a1e5c'], ['16', '#c2366f'], ['20', '#ff5f87'], ['24', '#ffb86b'], ['28', '#ff5f87'], ['32', '#c2366f']]
      .map(([y, c]) => `<rect x="0" y="${y}" width="48" height="4" fill="${c}"/>`).join('') +
    '<path d="M5 30V18h10v12h10V18h10v12h8" fill="none" stroke="#fff" stroke-width="3"/>', 'AHX'),
  // A hive cell holding a triangle wave.
  hvl: mark('<rect width="48" height="48" rx="6" fill="#062a24"/>' +
    '<path d="M24 5l17 10v18L24 43 7 33V15z" fill="none" stroke="#4fe0b0" stroke-width="3"/>' +
    '<path d="M11 28l6-9 7 11 7-11 6 9" fill="none" stroke="#e6fff6" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>',
    'HivelyTracker HVL'),
  // A bevelled panel with a volume envelope and its square nodes.
  xm: mark('<rect width="48" height="48" rx="3" fill="#2a3150"/>' +
    '<path d="M3 45V3h42" fill="none" stroke="#8d97c2" stroke-width="2"/><path d="M45 3v42H3" fill="none" stroke="#12162a" stroke-width="2"/>' +
    '<rect x="8" y="8" width="32" height="32" fill="#0d1124"/>' +
    '<path d="M10 37l6-24 8 9 10 4 4 11" fill="none" stroke="#ffe14d" stroke-width="2"/>' +
    '<g fill="#fff"><rect x="8" y="35" width="4" height="4"/><rect x="14" y="11" width="4" height="4"/>' +
    '<rect x="22" y="20" width="4" height="4"/><rect x="32" y="24" width="4" height="4"/><rect x="36" y="35" width="4" height="4"/></g>',
    'FastTracker 2 XM'),
  // Text-mode pattern rows and a block cursor.
  s3m: mark('<rect width="48" height="48" rx="2" fill="#000"/>' +
    '<g fill="#55e6ff"><rect x="6" y="9" width="10" height="3"/><rect x="18" y="9" width="6" height="3"/><rect x="26" y="9" width="14" height="3"/>' +
    '<rect x="6" y="17" width="10" height="3"/><rect x="26" y="17" width="6" height="3"/>' +
    '<rect x="6" y="33" width="10" height="3"/><rect x="18" y="33" width="6" height="3"/><rect x="26" y="33" width="10" height="3"/></g>' +
    '<rect x="3" y="23" width="42" height="7" fill="#ff5fd7"/>' +
    '<g fill="#000"><rect x="6" y="25" width="10" height="3"/><rect x="18" y="25" width="6" height="3"/></g>' +
    '<rect x="38" y="24" width="4" height="5" fill="#fff"/>', 'Scream Tracker 3 S3M'),
  // A 28-pin chip with a pulse wave, on the C64's blue screen inside its border.
  goat: mark('<rect width="48" height="48" rx="6" fill="#8a7fff"/><rect x="4" y="4" width="40" height="40" rx="3" fill="#352879"/>' +
    '<g fill="#c9c3ff">' + Array.from({ length: 7 }, (_, i) =>
      `<rect x="${11 + i * 4}" y="9" width="2" height="4"/><rect x="${11 + i * 4}" y="35" width="2" height="4"/>`).join('') + '</g>' +
    '<rect x="9" y="13" width="30" height="22" rx="1" fill="#111"/><circle cx="13" cy="24" r="1.6" fill="#352879"/>' +
    '<path d="M16 29v-10h6v10h6v-10h6" fill="none" stroke="#a59bff" stroke-width="2.5"/>', 'GoatTracker C64 SID'),
};

// ------------------------------------------------------------------ per brand
const BRANDS = [
  { id: 'native', label: 'FERRO', style: 'dotmatrix', word: 'FERRO TRACKER', name: 'FerroTracker', alt: '#b5653a' },
  { id: 'mod', label: 'MOD', style: 'amiga', word: 'MOD', name: 'Amiga MOD', alt: '#1f5fb8' },
  { id: 'ahx', label: 'AHX', style: 'copper', word: 'AHX', name: 'AHX' },
  { id: 'hvl', label: 'HVL', style: 'hive', word: 'HVL', name: 'HivelyTracker HVL' },
  { id: 'xm', label: 'XM', style: 'bevel', word: 'XM', name: 'FastTracker 2 XM' },
  { id: 's3m', label: 'S3M', style: 'textmode', word: 'S3M', name: 'Scream Tracker 3 S3M' },
  { id: 'goat', label: 'SID', style: 'c64', word: 'SID', name: 'GoatTracker C64 SID', alt: '#8a7fff' },
];

mkdirSync(OUT, { recursive: true });
for (const b of BRANDS) {
  writeFileSync(join(OUT, `${b.id}-mark.svg`), MARKS[b.id]);
  writeFileSync(join(OUT, `${b.id}-badge.svg`), badgeLabel(b.label, b.style));
  // The wordmark's shadow/unlit colour is only a fixed colour where the era asks for one.
  writeFileSync(join(OUT, `${b.id}-wordmark.svg`), wordmark(b.word, b.style, b.style === 'amiga' || b.style === 'c64' || b.style === 'dotmatrix' ? b.alt : undefined, b.name));
}
console.log(`Wrote ${BRANDS.length * 3} SVGs to ${OUT}`);
