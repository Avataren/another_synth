#!/usr/bin/env node
/**
 * Stage the demo module collection and describe it for the tracker's demo
 * browser.
 *
 * Modules are copied into an output directory and a manifest is written
 * alongside them. Titles and channel counts come from parsing each file rather
 * than from the filename, so the browser can show what a module actually is.
 *
 * The modules are deliberately NOT part of the repository or the Quasar build:
 * they are third-party music, and several megabytes of it. They are published
 * separately and the deploy step leaves them alone.
 *
 *   node scripts/build-demo-manifest.mjs <source-root> <output-dir>
 *
 * <source-root> holds one directory per collection, e.g. amiga/ and ft2/.
 */
import fs from 'node:fs';
import path from 'node:path';

const COLLECTION_LABELS = {
  amiga: 'Amiga / ProTracker',
  ft2: 'FastTracker 2',
};

const EXTENSIONS = new Set(['.mod', '.xm']);

/** Read a fixed-length, NUL-terminated ASCII string. */
function readAscii(buf, offset, length) {
  let out = '';
  for (let i = offset; i < Math.min(offset + length, buf.length); i++) {
    const code = buf[i];
    if (code === 0) break;
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out.trim();
}

const MOD_4CH = new Set(['M.K.', 'M!K!', 'M&K!', 'N.T.', 'FLT4', '4CHN']);

/** Channels implied by a MOD signature; mirrors channelsForSignature. */
function modChannels(signature) {
  if (MOD_4CH.has(signature)) return 4;
  if (['CD81', 'OKTA', 'OCTA'].includes(signature)) return 8;
  let match = /^(\d)CHN$/.exec(signature);
  if (match) return Number(match[1]);
  match = /^(\d{2})C[HN]$/.exec(signature);
  if (match) return Number(match[1]);
  match = /^TDZ(\d)$/.exec(signature);
  if (match) return Number(match[1]);
  return undefined;
}

function describeModule(buf, file) {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.xm') {
    if (readAscii(buf, 0, 17) !== 'Extended Module:' || buf[37] !== 0x1a) {
      return null;
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      title: readAscii(buf, 17, 20),
      format: 'XM',
      channels: view.getUint16(68, true),
      patterns: view.getUint16(70, true),
      instruments: view.getUint16(72, true),
    };
  }

  const signature = readAscii(buf, 1080, 4);
  const channels = modChannels(signature);
  // Soundtracker modules carry no signature; treat them as 4-channel MODs.
  return {
    title: readAscii(buf, 0, 20),
    format: 'MOD',
    channels: channels ?? 4,
    signature: signature || undefined,
  };
}

function main() {
  const [sourceRoot, outputDir] = process.argv.slice(2);
  if (!sourceRoot || !outputDir) {
    console.error(
      'Usage: node scripts/build-demo-manifest.mjs <source-root> <output-dir>',
    );
    process.exit(1);
  }

  const collections = [];
  let copied = 0;
  let skipped = 0;

  for (const dir of fs.readdirSync(sourceRoot).sort()) {
    const dirPath = path.join(sourceRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const songs = [];
    const targetDir = path.join(outputDir, dir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of fs.readdirSync(dirPath).sort()) {
      if (!EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

      const buf = fs.readFileSync(path.join(dirPath, file));
      let described;
      try {
        described = describeModule(buf, file);
      } catch (error) {
        described = null;
        console.warn(`  ! ${file}: ${error.message}`);
      }
      if (!described) {
        skipped++;
        console.warn(`  ! ${file}: unrecognised, skipped`);
        continue;
      }

      fs.copyFileSync(path.join(dirPath, file), path.join(targetDir, file));
      copied++;

      songs.push({
        file: `${dir}/${file}`,
        // Fall back to the filename when a module has no embedded title.
        title: described.title || path.basename(file, path.extname(file)),
        ...described,
        bytes: buf.length,
      });
    }

    if (songs.length === 0) continue;
    collections.push({
      id: dir,
      name: COLLECTION_LABELS[dir] ?? dir,
      songs,
    });
  }

  const manifest = { version: 1, generated: new Date().toISOString(), collections };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, 'index.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const total = collections.reduce((n, c) => n + c.songs.length, 0);
  console.log(
    `Staged ${copied} module(s) in ${collections.length} collection(s) -> ${outputDir}`,
  );
  console.log(`Manifest lists ${total} song(s)${skipped ? `, ${skipped} skipped` : ''}`);
}

main();
