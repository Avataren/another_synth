/**
 * Smoke-test the *built* @another-synth/tracker-playback artifact.
 *
 * Why this exists: the app resolves the package to source, not `dist` --
 * aliased in vitest.config.ts, quasar.config.ts and tsconfig.json -- so the
 * 1599-test suite never touches the one artifact an external consumer
 * actually gets. A broken `exports` map, a name dropped by `export *`, a
 * module that only works because the bundler papered over it: none of that
 * shows up in `npm test`.
 *
 * This runs under plain Node with no DOM, which is also the point. The
 * package is not DOM-free (engine.ts listens for `visibilitychange`,
 * scheduler.ts reaches for AudioContext), but everything except the
 * AudioContext scheduler is supposed to survive its absence. If that stops
 * being true, this fails.
 *
 * Node resolves the bare specifier through the npm-workspace symlink in
 * node_modules/@another-synth/, and the package's own `exports` map sends it
 * to dist/. So importing by package name here really does load the build, not
 * the source.
 *
 * Usage: npm run check:dist   (builds first, then runs this)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'packages', 'tracker-playback', 'dist');

let failures = 0;

function check(label, fn) {
  try {
    const detail = fn();
    console.log(`  ok   ${label}${detail ? ` -- ${detail}` : ''}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${label}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** First file in `dir` matching `re`, or null when the directory is absent. */
function firstFile(dir, re) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return null;
  const name = fs.readdirSync(abs).find((f) => re.test(f));
  return name ? path.join(abs, name) : null;
}

const bytesOf = (p) => new Uint8Array(fs.readFileSync(p));

if (!fs.existsSync(path.join(distDir, 'index.js'))) {
  console.error(
    `No build found at ${distDir}.\nRun: npm run build:tracker-playback`,
  );
  process.exit(1);
}

console.log('tracker-playback dist smoke test\n');

// --- the artifact loads at all, through the package name -------------------

const lib = await import('@another-synth/tracker-playback');

console.log('module resolution');
check('ESM entry resolves to dist', () => {
  const resolved = import.meta.resolve('@another-synth/tracker-playback');
  assert(
    resolved.includes('/dist/'),
    `resolved to ${resolved}, expected something under dist/ -- the exports ` +
      'map may be wrong, or a stale alias is in play',
  );
  return resolved.slice(resolved.indexOf('packages/'));
});

check('CJS entry loads', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('@another-synth/tracker-playback');
  assert(
    typeof cjs.parseMod === 'function',
    'require() gave a module without parseMod',
  );
  return `${Object.keys(cjs).length} exports`;
});

check('no DOM present (so the rest of this proves headless operation)', () => {
  assert(typeof document === 'undefined', 'document is defined; not a headless run');
  assert(typeof window === 'undefined', 'window is defined; not a headless run');
});

// --- the public surface is actually exported -------------------------------

console.log('\npublic surface');
const required = [
  // parsers
  'looksLikeMod', 'parseMod', 'looksLikeXm', 'parseXm', 'looksLikeS3m', 'parseS3m',
  // pattern importers
  'buildModTrackerPatterns', 'buildXmTrackerPatterns', 'buildS3mTrackerPatterns',
  // row model -> song
  'buildPlaybackSong', 'buildPlaybackPatterns',
  // parsing, ids, constants
  'parseTrackerNoteSymbol', 'midiToTrackerNote', 'parseEffectCommand', 'decodeRawEffect',
  'formatInstrumentId', 'normalizeInstrumentId',
  'TOTAL_SLOTS', 'CURRENT_SONG_FILE_VERSION', 'clampPatternRows',
  // pitch + profiles + transport
  'createLinearPitchModel', 'createXmAmigaPitchModel', 'createS3mPitchModel',
  'profileForFormat', 'PlaybackEngine', 'createVisibilityClock',
];
check(`${required.length} expected exports present`, () => {
  const missing = required.filter((name) => lib[name] === undefined);
  assert(
    missing.length === 0,
    `missing from dist: ${missing.join(', ')}. An \`export *\` collision in ` +
      'index.ts silently drops a name -- check for duplicate export names.',
  );
  return `${Object.keys(lib).length} exported in total`;
});

// --- bytes all the way to a schedulable song, per format -------------------

/** parse -> rows -> PlaybackSong, asserting the shape at each hop. */
function bytesToSong(label, file, parse, buildPatterns, sourceExtra) {
  const mod = parse(bytesOf(file));
  const patterns = buildPatterns(mod);
  assert(patterns.length > 0, 'importer produced no patterns');
  assert(
    patterns[0].tracks.length > 0,
    'first pattern has no tracks',
  );

  const song = lib.buildPlaybackSong({
    currentSong: { title: mod.title ?? label, author: '', bpm: 125 },
    patterns,
    sequence: patterns.map((p) => p.id),
    currentPatternId: patterns[0].id,
    playbackMode: 'song',
    stepSize: 1,
    defaultPatternRows: 64,
    resolveInstrumentId: (slot) => lib.formatInstrumentId(slot),
    normalizeInstrumentId: lib.normalizeInstrumentId,
    ...sourceExtra,
  });

  assert(song.patterns.length === patterns.length, 'song lost patterns');
  const steps = song.patterns.reduce(
    (n, p) => n + p.tracks.reduce((m, t) => m + t.steps.length, 0),
    0,
  );
  assert(steps > 0, 'song has no steps at all');
  const withNotes = song.patterns.some((p) =>
    p.tracks.some((t) => t.steps.some((st) => st.midi !== undefined)),
  );
  assert(withNotes, 'no step carries a note; decoding produced empty rows');

  return `"${(mod.title ?? '').trim()}" ${patterns.length} patterns, ` +
    `${patterns[0].tracks.length} tracks, ${steps} steps`;
}

console.log('\nbytes -> rows -> PlaybackSong');

const modFile = firstFile('public/demos/amiga', /\.mod$/i);
check('MOD', () => {
  assert(modFile, 'no .mod found under public/demos/amiga');
  return bytesToSong('MOD', modFile, lib.parseMod, lib.buildModTrackerPatterns, {
    moduleFormat: 'protracker',
  });
});

const xmFile = firstFile('public/demos/ft2', /\.xm$/i);
check('XM', () => {
  assert(xmFile, 'no .xm found under public/demos/ft2');
  const xm = lib.parseXm(bytesOf(xmFile));
  const pitch = xm.linearFrequency
    ? lib.createLinearPitchModel()
    : lib.createXmAmigaPitchModel();
  const slots = new Map(xm.instruments.map((_, i) => [i + 1, i + 1]));
  return bytesToSong(
    'XM',
    xmFile,
    lib.parseXm,
    (m) => lib.buildXmTrackerPatterns(m, pitch, slots),
    { moduleFormat: 'xm', linearFrequency: xm.linearFrequency },
  );
});

const s3mFile = firstFile('public/demos/s3m', /\.s3m$/i);
check('S3M', () => {
  assert(s3mFile, 'no .s3m found under public/demos/s3m');
  const s3m = lib.parseS3m(bytesOf(s3mFile));
  const pitch = lib.createS3mPitchModel({ amigaLimits: s3m.amigaLimits });
  const slots = new Map(s3m.instruments.map((_, i) => [i + 1, i + 1]));
  return bytesToSong(
    'S3M',
    s3mFile,
    lib.parseS3m,
    (m) => lib.buildS3mTrackerPatterns(m, pitch, slots),
    { moduleFormat: 's3m', amigaLimits: s3m.amigaLimits },
  );
});

// --- the parts a host builds on still construct without a DOM --------------

console.log('\nheadless construction');
check('createVisibilityClock()', () => {
  const clock = lib.createVisibilityClock();
  assert(typeof clock.start === 'function', 'clock has no start()');
  return clock.constructor.name;
});

check('new PlaybackEngine()', () => {
  // engine.ts guards its visibilitychange listener with `typeof document ===
  // "undefined"`; if that guard is ever dropped, this throws.
  const engine = new lib.PlaybackEngine({ playbackClock: lib.createVisibilityClock() });
  assert(engine, 'constructor returned nothing');
  return engine.constructor.name;
});

check('profileForFormat() covers every format', () => {
  const formats = ['native', 'protracker', 'xm', 's3m'];
  for (const f of formats) {
    assert(lib.profileForFormat(f), `no profile for "${f}"`);
  }
  return formats.join(', ');
});

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
