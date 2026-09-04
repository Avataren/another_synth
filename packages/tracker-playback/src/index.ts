/**
 * A standalone tracker replay core: parse a MOD, XM or S3M, schedule it, and
 * hand the scheduled events to whatever makes the sound.
 *
 * The package has no runtime dependencies. Its replay core is node-agnostic:
 * it stops at "play this note, on this track, at this time" -- see the
 * `Scheduled*Handler` types in ./types for the whole surface a host has to
 * implement. The one Web-Audio-touching piece ships here too as an optional
 * extra for hosts that build their graph on Web Audio: the post-fx rack
 * (./postfx) of master-bus effect stages, ending in the Amiga-style low-pass
 * filter. It is plain node code -- no engine core depends on it.
 */

// Transport: the engine, the clocks that drive it, and the shared vocabulary.
export * from './types';
export * from './engine';
export * from './timing-system';
export * from './scheduler';
export * from './clock';
export * from './instrument-resolver';
export * from './instrument-ids';
export * from './sink';

// Post-fx: master-bus effect stages a host wires between its mix bus and its
// speakers. The rack and stages construct Web Audio nodes; the engine core
// above stays node-agnostic and only calls the injected `Scheduled*Handler`s.
export * from './postfx/post-fx-stage';
export * from './postfx/amiga-filter-math';
export * from './postfx/amiga-lpf-stage';
export * from './postfx/post-fx-rack';
export * from './postfx/registry';

// Sample conditioning and the quality settings that drive it.
export * from './sample-conditioning';
export * from './sample-quality';
export * from './sampler-instrument';
export * from './standalone-sink';

// Replay behaviour: per-tick effect processing, the pitch domain each format
// slides in, and the dialect differences between trackers.
export * from './effect-processor';
export * from './format-profile';
export * from './pitch-model';

// The song model's own constants: slot count and file version.
export * from './song-constants';
export * from './tracker-sample';

// The row model the importers emit and the pattern editor edits, and the
// parsing of a row's note, volume and effect text into decoded commands.
export * from './tracker-types';
export * from './note-utils';

// Format importers: a parsed module's patterns into that row model. The
// sample half of each importer stays with its host, since a sample becomes
// whatever that host's instrument is.
export * from './import/mod-patterns';
export * from './import/mod-samples';
export * from './import/xm-patterns';
export * from './import/xm-samples';
export * from './import/s3m-patterns';
export * from './import/s3m-samples';

// The conversion from that row model into a schedulable `Song`.
export * from './playback-song-builder';

// Binary parsers. `looksLike*` sniff a buffer; `parse*` decode one.
export * from './mod-parser';
export * from './mod-vblank';
export * from './formats/xm';
export * from './formats/s3m';
