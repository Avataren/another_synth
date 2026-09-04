/**
 * A standalone tracker replay core: parse a MOD, XM or S3M, schedule it, and
 * hand the scheduled events to whatever makes the sound.
 *
 * The package has no runtime dependencies and knows nothing about Web Audio.
 * It stops at "play this note, on this track, at this time" -- see the
 * `Scheduled*Handler` types in ./types for the whole surface a host has to
 * implement.
 */

// Transport: the engine, the clocks that drive it, and the shared vocabulary.
export * from './types';
export * from './engine';
export * from './timing-system';
export * from './scheduler';
export * from './clock';
export * from './instrument-resolver';
export * from './instrument-ids';

// Replay behaviour: per-tick effect processing, the pitch domain each format
// slides in, and the dialect differences between trackers.
export * from './effect-processor';
export * from './format-profile';
export * from './pitch-model';

// The song model's own constants: slot count and file version.
export * from './song-constants';

// The row model the importers emit and the pattern editor edits, and the
// parsing of a row's note, volume and effect text into decoded commands.
export * from './tracker-types';
export * from './note-utils';

// Format importers: a parsed module's patterns into that row model. The
// sample half of each importer stays with its host, since a sample becomes
// whatever that host's instrument is.
export * from './import/mod-patterns';
export * from './import/xm-patterns';
export * from './import/s3m-patterns';

// The conversion from that row model into a schedulable `Song`.
export * from './playback-song-builder';

// Binary parsers. `looksLike*` sniff a buffer; `parse*` decode one.
export * from './mod-parser';
export * from './mod-vblank';
export * from './formats/xm';
export * from './formats/s3m';
