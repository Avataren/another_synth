// S5.9 scratch: which corpus instruments' wave tables write a gate-off
// waveform byte (GT: $10-$DF with bit 0 clear, or $E0-$EF with bit 0 clear),
// and which of those instruments are triggered in playback. Run with
// `npx vite-node .ai/s59-corpus-scan.ts`.
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

const gateOff = (l: number) => (l >= 0x10 && l <= 0xef && (l & 1) === 0);
const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

let songsWithRows = 0;
let songsReached = 0;
let cmd7Off = 0;
const lines: string[] = [];
for (const f of files) {
  const r = importGtSong(new Uint8Array(readFileSync(join(root, f))));
  if (!r.ok) {
    lines.push(`${f}: IMPORT FAILED ${r.reason}`);
    continue;
  }
  const doc = r.doc;
  const wave = doc.tables.wave;
  // Instruments triggered by a note row in a pattern some orderlist plays.
  const played = new Set<number>();
  const usedPatterns = new Set<number>();
  for (const s of doc.subsongs) for (const o of s.orderlists) for (const e of o.entries) usedPatterns.add(e.pattern);
  let cmd7 = 0;
  // Instrument selection is running state per channel; approximate "reached"
  // as: an instrument number appears on a pattern row the song plays, or a
  // note row inherits it (the importer keeps instrument 0 = no change).
  for (const p of usedPatterns) {
    const pat = doc.patterns[p];
    if (!pat) continue;
    for (const row of pat.rows) {
      if (row.instrument > 0) played.add(row.instrument);
      if (row.command === 7 && (row.param & 1) === 0) cmd7++;
    }
  }
  if (cmd7) cmd7Off++;
  const hits: string[] = [];
  let reachedHit = false;
  doc.instruments.forEach((ins, i) => {
    if (!ins.wavePtr) return;
    const seen = new Set<number>();
    let ptr = ins.wavePtr;
    const off: string[] = [];
    while (ptr > 0 && ptr <= wave.length && !seen.has(ptr)) {
      seen.add(ptr);
      const row = wave[ptr - 1]!;
      if (row.left === 0xff) {
        ptr = row.right;
        continue;
      }
      if (gateOff(row.left)) off.push(`${hex(ptr)}:${hex(row.left)}`);
      ptr++;
    }
    if (off.length) {
      const reached = played.has(i + 1);
      if (reached) reachedHit = true;
      hits.push(`  ins ${i + 1} "${ins.name}" first=$${hex(ins.firstWave)} ${reached ? 'PLAYED' : 'unused'} gate-off rows [${off.join(' ')}]`);
    }
  });
  if (hits.length || cmd7) {
    if (hits.length) songsWithRows++;
    if (reachedHit) songsReached++;
    lines.push(`${f}${cmd7 ? ` (cmd 7 gate-off params on ${cmd7} played rows)` : ''}`);
    lines.push(...hits);
  }
}
console.log(lines.join('\n'));
console.log(`\n${files.length} songs; ${songsWithRows} with an instrument wave table that writes a gate-off byte; ${songsReached} where such an instrument is used on a played pattern; ${cmd7Off} with a cmd-7 gate-off param on a played pattern`);
