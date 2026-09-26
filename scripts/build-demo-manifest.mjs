#!/usr/bin/env node
/**
 * Stage the demo module collection and describe it for the tracker's demo
 * browser.
 *
 * Modules are copied into an output directory and a manifest is written
 * alongside them. Titles and channel counts come from parsing each file rather
 * than from the filename, so the browser can show what a module actually is.
 *
 * public/demos/ is committed and picked up by the Quasar build, and is the
 * source of truth for what the collection contains -- modules are added by
 * dropping them in. Pointing this at that directory as both source and output
 * re-indexes it in place; pointing it at some other source root imports from
 * there instead. Run it through scripts/refresh-demos.sh rather than directly.
 *
 *   node scripts/build-demo-manifest.mjs <source-root> <output-dir>
 *
 * <source-root> holds one directory per collection, e.g. amiga/ and ft2/. A
 * collection may group its songs one directory deeper (goattracker/<artist>/,
 * sid/<composer>/); those keep their subdirectory in the manifest's `file` path.
 */
import fs from 'node:fs';
import path from 'node:path';

const COLLECTION_LABELS = {
  amiga: 'Amiga / ProTracker',
  ft2: 'FastTracker 2',
  s3m: 'Scream Tracker 3',
  ahx: 'AHX / HivelyTracker',
  goattracker: 'GoatTracker',
  sid: 'C64 SID',
};

const EXTENSIONS = new Set(['.mod', '.xm', '.s3m', '.ahx', '.hvl', '.sng', '.sid']);

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

/**
 * AHX (`THX` + version 0..2) and HVL (`HVL` + version 0..1) header, mirroring
 * looksLikeAhx / parseAhxBody / parseHvlBody in packages/tracker-playback.
 *
 * Offsets (formats/ahx.ts): u16be at 4 is the name offset, a NUL-terminated
 * string that is the song title; the low nibble of byte 6 plus byte 7 is the
 * position count; byte 12 is the instrument count. Both formats share those
 * fields; HVL alone gives the channel count, as (byte 8 >> 2) + 4 (AHX is 4).
 * The manifest's `patterns` field is the position count: an AHX song has no
 * pattern objects, one row-model pattern is built per position.
 */
function describeAhx(buf, format) {
  if (buf.length < 16) return null;
  const magic = format === 'AHX' ? 'THX' : 'HVL';
  if (readAscii(buf, 0, 3) !== magic) return null;
  if (buf[3] >= (format === 'AHX' ? 3 : 2)) return null;
  const nameOffset = (buf[4] << 8) | buf[5];
  return {
    title: readAscii(buf, nameOffset, 128),
    format,
    channels: format === 'AHX' ? 4 : (buf[8] >> 2) + 4,
    patterns: ((buf[6] & 0x0f) << 8) | buf[7],
    instruments: buf[12],
  };
}

/**
 * GoatTracker .sng header (GoatTracker v2.72 readme, 6.1.1): a 4-byte magic,
 * then the song name as 32 NUL-padded bytes at 4. Only the two magics the
 * app's importer reads are listed (`GTS5`, GoatTracker 2; `GTS!`, GoatTracker
 * 1); a beta `GTS2`..`GTS4` would be published unloadable, so it is skipped.
 * The chip has three voices, which is also how the tracker lays a SID song
 * out: three tracks per pattern.
 */
function describeSng(buf) {
  if (buf.length < 101) return null;
  const magic = readAscii(buf, 0, 4);
  if (magic !== 'GTS5' && magic !== 'GTS!') return null;
  return {
    title: readAscii(buf, 4, 32),
    format: magic === 'GTS5' ? 'GT2' : 'GT1',
    channels: 3,
  };
}

/** A fixed-length, NUL-terminated Latin-1 string (a SID header's texts: Hülsbeck's ü is $FC). */
function readLatin1(buf, offset, length) {
  let out = '';
  for (let i = offset; i < Math.min(offset + length, buf.length); i++) {
    const code = buf[i];
    if (code === 0) break;
    if ((code >= 32 && code < 127) || code >= 160) out += String.fromCharCode(code);
  }
  return out.trim();
}

/**
 * A C64 `.sid` (PSID/RSID, HVSC's SID_file_format.txt): the magic, the song
 * name at $16 and the author at $36 (32 Latin-1 bytes each), the subsong
 * count at $0E. The app transcribes it into a GoatTracker song
 * (plan-psid-import.md), three voices like the chip. SIDs are known by their
 * composer, so the title carries the author too.
 */
function describeSid(buf) {
  if (buf.length < 0x76) return null;
  const magic = readAscii(buf, 0, 4);
  if (magic !== 'PSID' && magic !== 'RSID') return null;
  const name = readLatin1(buf, 0x16, 32);
  const author = readLatin1(buf, 0x36, 32);
  return {
    title: [name, author].filter((x) => x !== '').join(' · '),
    format: magic,
    channels: 3,
    subsongs: (buf[0x0e] << 8) | buf[0x0f],
  };
}

function describeModule(buf, file) {
  const ext = path.extname(file).toLowerCase();

  if (ext === '.ahx') return describeAhx(buf, 'AHX');
  if (ext === '.hvl') return describeAhx(buf, 'HVL');
  if (ext === '.sng') return describeSng(buf);
  if (ext === '.sid') return describeSid(buf);

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

  if (ext === '.s3m') {
    if (readAscii(buf, 0x2c, 4) !== 'SCRM' || buf[0x1d] !== 0x10) {
      return null;
    }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      title: readAscii(buf, 0, 28),
      format: 'S3M',
      channels: buf.slice(0x40, 0x60).filter((c) => c !== 0xff).length,
      patterns: view.getUint16(0x24, true),
      instruments: view.getUint16(0x22, true),
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

/**
 * The song files of a collection, as paths relative to it: its own files and
 * those one subdirectory down, sorted by path.
 */
function listSongFiles(dirPath) {
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const subPath = path.join(dirPath, entry.name);
      for (const sub of fs.readdirSync(subPath, { withFileTypes: true })) {
        if (sub.isFile()) files.push(`${entry.name}/${sub.name}`);
      }
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files
    .filter((file) => EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();
}

function main() {
  const [sourceRoot, outputDir] = process.argv.slice(2);
  if (!sourceRoot || !outputDir) {
    console.error(
      'Usage: node scripts/build-demo-manifest.mjs <source-root> <output-dir>',
    );
    process.exit(1);
  }

  // Re-indexing public/demos in place: the files are already where they need
  // to be, and copyFileSync onto itself is a good way to truncate one.
  const inPlace =
    path.resolve(sourceRoot) === path.resolve(outputDir);

  const collections = [];
  let copied = 0;
  let skipped = 0;

  for (const dir of fs.readdirSync(sourceRoot).sort()) {
    const dirPath = path.join(sourceRoot, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    const songs = [];
    const targetDir = path.join(outputDir, dir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of listSongFiles(dirPath)) {
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

      if (!inPlace) {
        fs.mkdirSync(path.dirname(path.join(targetDir, file)), { recursive: true });
        fs.copyFileSync(path.join(dirPath, file), path.join(targetDir, file));
      }
      copied++;

      songs.push({
        ...described,
        file: `${dir}/${file}`,
        // Fall back to the filename when a module carries no embedded title.
        // This has to come *after* the spread: DOPE.MOD's title field is 20
        // NUL bytes, and spreading `described` last put the empty title back
        // and left the browser showing a blank row.
        title: described.title || path.basename(file, path.extname(file)),
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
    inPlace
      ? `Indexed ${copied} module(s) in ${collections.length} collection(s) in ${outputDir}`
      : `Staged ${copied} module(s) in ${collections.length} collection(s) -> ${outputDir}`,
  );
  console.log(`Manifest lists ${total} song(s)${skipped ? `, ${skipped} skipped` : ''}`);
}

main();
