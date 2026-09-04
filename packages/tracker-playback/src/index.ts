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

// Replay behaviour: per-tick effect processing, the pitch domain each format
// slides in, and the dialect differences between trackers.
export * from './effect-processor';
export * from './format-profile';
export * from './pitch-model';

// Binary parsers. `looksLike*` sniff a buffer; `parse*` decode one.
export * from './mod-parser';
export * from './mod-vblank';
export * from './formats/xm';
export * from './formats/s3m';
