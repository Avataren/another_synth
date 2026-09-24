// S5.10 scratch (throwaway, disclosed in .ai/sid-transpose-verdict.md): the
// orderlist markers of the 83 corpus .sng files, read from the RAW bytes
// (every subtune, every channel: +100 subtunes, +101 per-list length byte n,
// then n data bytes + the restart byte; GTS5 and GTS! share that layout), plus
// what the S5.10 player changes touch, read from the imported doc (first pass
// of every subtune). Run with `npx vite-node .ai/s510-corpus-sweep.ts`.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importGtSong } from '../src/audio/tracker/sid-doc/gt-sng-read';

const root = resolve(__dirname, '../src/tests/fixtures/gt-songs');
const files: string[] = [];
for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of readdirSync(join(root, dir.name))) if (f.endsWith('.sng')) files.push(join(dir.name, f));
}
files.sort();

interface Row {
  file: string;
  trans: number;
  rep: number;
  lo: number;
  hi: number;
  reps: string;
  noteOut: number;
  waveDiff: number;
  cmd4: number;
  cmd4Small: number;
  cmd4Fine: number;
  insVib: number;
  persist: number;
}
const out: Row[] = [];
const kinds = new Map<string, number>();
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(root, f)));
  let at = 101;
  let trans = 0;
  let rep = 0;
  let lo = 0;
  let hi = 0;
  const repHist = new Map<number, number>();
  for (let s = 0; s < bytes[100]!; s++) {
    for (let c = 0; c < 3; c++) {
      const n = bytes[at]!;
      const data = bytes.subarray(at + 1, at + n); // n bytes, the last the $FF endmark
      for (const v of data) {
        if (v >= 0xe0 && v <= 0xfe) {
          trans++;
          lo = Math.min(lo, v - 0xf0);
          hi = Math.max(hi, v - 0xf0);
        } else if (v >= 0xd0 && v <= 0xdf) {
          rep++;
          repHist.set(v, (repHist.get(v) ?? 0) + 1);
        }
      }
      at += n + 2;
    }
  }
  const r = importGtSong(bytes);
  if (!r.ok) throw new Error(`${f}: ${r.reason}`);
  const doc = r.doc;
  // Row notes whose index under the entry's transpose leaves C-0..G#7 (the
  // old player clamped them), and wave-table steps whose note the old and
  // new arithmetic disagree on (triggered instrument x note pairs).
  let noteOut = 0;
  let waveDiff = 0;
  let cmd4 = 0;
  let cmd4Small = 0;
  let cmd4Fine = 0;
  let persist = 0;
  const seenPair = new Set<string>();
  const wave = doc.tables.wave;
  const oldNote = (base: number, right: number) =>
    right <= 0x5f ? base + right : right <= 0x7f ? base + right - 0x80 : right & 0x7f;
  const clamp = (n: number) => Math.max(0, Math.min(92, n));
  const tableReg = (i: number) => (i & 0x7f) >= 96 ? -1 : i & 0x7f; // -1 = register 0
  for (const sub of doc.subsongs) {
    for (const list of sub.orderlists) {
      for (const e of list.entries) {
        const rows = doc.patterns[e.pattern]!.rows;
        let ins = 0;
        let running = 0;
        for (const row of rows) {
          if (row.instrument) ins = row.instrument;
          // GT's running command: a note resets it to 0, 0-4 set it, 5-F keep it.
          if (row.note >= 1 && row.note <= 93) running = 0;
          if (row.command <= 4) running = row.command;
          else if (running === 4) persist++;
          if (row.command === 4) {
            cmd4++;
            const sp = doc.tables.speed[row.param - 1];
            if (sp && sp.left < 0x80 && sp.left <= 2) cmd4Small++;
            if (sp && sp.left >= 0x80) cmd4Fine++;
          }
          if (row.note < 1 || row.note > 93) continue;
          const idx = row.note - 1 + e.transpose;
          if (idx < 0 || idx > 92) noteOut++;
          const base = idx & 0xff;
          const key = `${ins},${base}`;
          if (seenPair.has(key) || ins === 0) continue;
          seenPair.add(key);
          const insObj = doc.instruments[ins - 1];
          if (!insObj) continue;
          const visited = new Set<number>();
          let p = insObj.wavePtr;
          while (p > 0 && p <= wave.length && !visited.has(p)) {
            visited.add(p);
            const w = wave[p - 1]!;
            if (w.left === 0xff) {
              p = w.right;
              continue;
            }
            if (w.left < 0xf0 && w.right !== 0x80) {
              const before = clamp(oldNote(clamp(idx), w.right));
              const after = tableReg(w.right < 0x80 ? base + w.right : w.right);
              if (before !== after) {
                waveDiff++;
                const kind = w.right >= 0x81 ? 'absolute past G#7' : base + w.right >= 128 && w.right >= 0x60 ? 'relative down (in range both ways?)' : base + w.right >= 128 ? 'relative wraps past 127' : 'relative past G#7';
                kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
                if (w.right >= 0x60 && w.right <= 0x7f && base + w.right - 0x80 < 0) kinds.set('down below C-0', (kinds.get('down below C-0') ?? 0) + 1);
                if (after === -1) kinds.set('lands on a zero entry (silence)', (kinds.get('lands on a zero entry (silence)') ?? 0) + 1);
              }
            }
            p++;
          }
        }
      }
    }
  }
  const insVib = doc.instruments.filter((i) => i.vibratoDelay > 0 && i.speedPtr > 0).length;
  const reps = [...repHist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, k]) => `$${v.toString(16).toUpperCase()}x${k}`)
    .join(' ');
  out.push({ file: f, trans, rep, lo, hi, reps, noteOut, waveDiff, cmd4, cmd4Small, cmd4Fine, insVib, persist });
}

const n = (p: (r: Row) => boolean) => out.filter(p).length;
console.log(`songs ${out.length}`);
console.log(`with transpose markers ($E0-$FE): ${n((r) => r.trans > 0)} songs, ${out.reduce((a, r) => a + r.trans, 0)} markers`);
console.log(`with repeat markers ($D0-$DF): ${n((r) => r.rep > 0)} songs, ${out.reduce((a, r) => a + r.rep, 0)} markers`);
console.log(`row notes leaving C-0..G#7 under their transpose (old clamp): ${n((r) => r.noteOut > 0)} songs, ${out.reduce((a, r) => a + r.noteOut, 0)} row-plays`);
console.log(`wave steps old != new (per instrument x note pair): ${n((r) => r.waveDiff > 0)} songs, ${out.reduce((a, r) => a + r.waveDiff, 0)} steps`);
console.log(`command 4 rows: ${n((r) => r.cmd4 > 0)} songs, ${out.reduce((a, r) => a + r.cmd4, 0)} row-plays; turn value <= 2: ${n((r) => r.cmd4Small > 0)} songs, ${out.reduce((a, r) => a + r.cmd4Small, 0)}; fine mode: ${n((r) => r.cmd4Fine > 0)} songs, ${out.reduce((a, r) => a + r.cmd4Fine, 0)}`);
console.log(`instruments with vibrato (delay > 0 and speed row): ${n((r) => r.insVib > 0)} songs, ${out.reduce((a, r) => a + r.insVib, 0)} instruments`);
console.log(`rows with command 5-F (no note) under a running 4 (S5.10: vibrato continues): ${n((r) => r.persist > 0)} songs, ${out.reduce((a, r) => a + r.persist, 0)} row-plays`);
console.log('wave diff kinds:', JSON.stringify([...kinds]));
console.log('\nworst: most orderlist markers');
for (const r of [...out].sort((a, b) => b.trans + b.rep - (a.trans + a.rep)).slice(0, 10))
  console.log(`  ${r.file}: ${r.trans} transpose, ${r.rep} repeat (${r.reps})`);
console.log('worst: widest transpose range');
for (const r of [...out].sort((a, b) => b.hi - b.lo - (a.hi - a.lo)).slice(0, 10))
  console.log(`  ${r.file}: ${r.lo}..+${r.hi}`);
console.log('\nper song: file | transpose markers | repeat markers (value x count) | range | notes out | wave diffs | cmd4 (small, fine) | ins vibrato | persist');
for (const r of out)
  console.log(`${r.file} | ${r.trans} | ${r.rep} ${r.reps} | ${r.lo}..+${r.hi} | ${r.noteOut} | ${r.waveDiff} | ${r.cmd4} (${r.cmd4Small}, ${r.cmd4Fine}) | ${r.insVib} | ${r.persist}`);
