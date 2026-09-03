// Track voice registry for TrackerSongBank.
//
// Extracted verbatim from song-bank.ts (P2, D95): the per-track voice maps
// (lastTrackVoice, trackVoiceOwner, trackReleasingVoices) and the helpers
// that read and maintain them, including `resolveCommandVoice` -- D78's
// single resolution path for every per-voice command. Moved as ONE gated
// unit with the maps it reads; the voice-replacement policy itself
// (`channelsAreMonophonic`, gate-off policy, getGateLeadTime) stays in the
// bank and is injected here (D78 / review wait list: do not abstract the
// policy yet).

import type { ActiveInstrument } from './song-bank';

export interface TrackVoiceRegistryDeps {
  /** All live instruments, by id. Shared with the bank. */
  readonly instruments: Map<string, ActiveInstrument>;
  /** Per-instrument, per-track active note sets. Shared with the bank. */
  readonly activeNotes: Map<string, Map<number, Set<number>>>;
  readonly audioContext: AudioContext;
  /** Whether a track is a monophonic module channel (replacement policy). */
  readonly isMonophonicChannel: () => boolean;
  readonly getGateLeadTime: (instrument: ActiveInstrument['instrument']) => number;
}

export class TrackVoiceRegistry {
  private readonly lastTrackVoice: Map<string, Map<number, number>> = new Map();
  /** Track owner voice per track across instruments: trackIndex -> { instrumentId, voiceIndex } */
  private readonly trackVoiceOwner: Map<
    number,
    { instrumentId: string; voiceIndex: number }
  > = new Map();
  /**
   * Voices still sounding out a release on each track, across instruments.
   *
   * A key-off releases a voice and stops tracking it as the track's current
   * voice -- correctly, since it is no longer what the track is playing. But
   * on a MOD or XM channel the next note has to *kill* it, and something that
   * is not tracked anywhere cannot be killed: the released note went on
   * sounding underneath the new one for its whole fadeout, which on XM can be
   * seconds. `ModInstrument` already cuts a releasing voice occupying the slot
   * it is about to reuse, so this only ever bit when the channel changed
   * instrument -- exactly the case the reporter heard.
   */
  private readonly trackReleasingVoices: Map<
    number,
    Array<{ instrumentId: string; voiceIndex: number }>
  > = new Map();

  constructor(private readonly deps: TrackVoiceRegistryDeps) {}

  /** Drop all voice tracking (the three maps this registry owns). */
  clearAll() {
    this.lastTrackVoice.clear();
    this.trackVoiceOwner.clear();
    this.trackReleasingVoices.clear();
  }

  /** Purge every trace of one instrument from the maps (teardown path). */
  removeInstrument(instrumentId: string) {
    this.lastTrackVoice.delete(instrumentId);
    // Clear any per-track voice tracking so stale voice IDs don't linger when
    // the instrument is rebuilt for a new song/patch. `trackVoiceOwner` is now
    // the authority for module playback, so an entry naming a torn-down
    // instrument would silently swallow every per-voice command on that
    // channel until the next note replaced it.
    for (const [track, owner] of Array.from(this.trackVoiceOwner.entries())) {
      if (owner.instrumentId === instrumentId)
        this.trackVoiceOwner.delete(track);
    }
    for (const [track, list] of Array.from(
      this.trackReleasingVoices.entries(),
    )) {
      const remaining = list.filter((v) => v.instrumentId !== instrumentId);
      if (remaining.length === 0) this.trackReleasingVoices.delete(track);
      else this.trackReleasingVoices.set(track, remaining);
    }
  }

  getTrackNotes(
    instrumentId: string,
    trackIndex: number | undefined,
  ): Set<number> {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    let byTrack = this.deps.activeNotes.get(instrumentId);
    if (!byTrack) {
      byTrack = new Map();
      this.deps.activeNotes.set(instrumentId, byTrack);
    }
    let notes = byTrack.get(trackKey);
    if (!notes) {
      notes = new Set<number>();
      byTrack.set(trackKey, notes);
    }
    return notes;
  }

  setLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    // Ensure this voice isn't marked against other tracks for the same instrument.
    const existing = this.lastTrackVoice.get(instrumentId);
    if (existing) {
      for (const [key, val] of Array.from(existing.entries())) {
        if (
          val === voiceIndex &&
          key !== (Number.isFinite(trackIndex) ? (trackIndex as number) : -1)
        ) {
          existing.delete(key);
        }
      }
    }

    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    let byTrack = this.lastTrackVoice.get(instrumentId);
    if (!byTrack) {
      byTrack = new Map();
      this.lastTrackVoice.set(instrumentId, byTrack);
    }

    byTrack.set(trackKey, voiceIndex);
    // Record a global last voice for this instrument (trackKey = -1) so an
    // effect-driven update with no track index can target the most recently
    // used voice instead of all voices.
    //
    // Native songs only. On a module channel this key is a cross-channel leak
    // by construction: it lets a command that failed to resolve on its own
    // track land on whatever that instrument played most recently, on *any*
    // channel. Module commands resolve through `trackVoiceOwner` instead
    // (see resolveCommandVoice), which has no such escape hatch.
    if (!this.deps.isMonophonicChannel()) {
      byTrack.set(-1, voiceIndex);
    }
  }

  peekLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
  ): number | undefined {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.lastTrackVoice.get(instrumentId);
    return byTrack?.get(trackKey);
  }

  clearLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
  ) {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.lastTrackVoice.get(instrumentId);
    byTrack?.delete(trackKey);
  }

  /** The full per-track last-voice map for one instrument (read-only use). */
  lastVoiceMapFor(instrumentId: string): Map<number, number> | undefined {
    return this.lastTrackVoice.get(instrumentId);
  }

  /** Direct access to the per-instrument last-voice map (test hook, D95). */
  get lastVoiceByTrack(): Map<string, Map<number, number>> {
    return this.lastTrackVoice;
  }

  ownerOf(trackIndex: number) {
    return this.trackVoiceOwner.get(trackIndex);
  }

  setOwner(
    trackIndex: number,
    owner: { instrumentId: string; voiceIndex: number },
  ) {
    this.trackVoiceOwner.set(trackIndex, owner);
  }

  deleteOwner(trackIndex: number) {
    this.trackVoiceOwner.delete(trackIndex);
  }

  /** Remember a voice that a key-off left sounding out its release. */
  rememberReleasingVoice(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    if (!Number.isFinite(trackIndex as number)) return;
    const key = trackIndex as number;
    const list = this.trackReleasingVoices.get(key) ?? [];
    if (
      !list.some(
        (v) => v.instrumentId === instrumentId && v.voiceIndex === voiceIndex,
      )
    ) {
      list.push({ instrumentId, voiceIndex });
    }
    this.trackReleasingVoices.set(key, list);
  }

  /**
   * Silence anything still ringing on a track from an earlier key-off, because
   * a new note is taking the channel.
   *
   * Module formats only: on a native song those releases are meant to ring
   * through the next note.
   */
  cutReleasingVoicesForTrack(trackIndex: number | undefined, time: number) {
    if (!Number.isFinite(trackIndex as number)) return;
    const key = trackIndex as number;
    const list = this.trackReleasingVoices.get(key);
    if (!list || list.length === 0) return;
    if (!this.deps.isMonophonicChannel()) return;

    const now = this.deps.audioContext.currentTime;
    for (const { instrumentId, voiceIndex } of list) {
      const active = this.deps.instruments.get(instrumentId);
      if (!active) continue;
      const gateLead = this.deps.getGateLeadTime(active.instrument);
      let gateTime = time - gateLead;
      if (gateTime < now) gateTime = now + 0.001;
      if (gateTime >= time) gateTime = Math.max(now, time - 0.0005);
      this.endVoiceForReplacement(active.instrument, voiceIndex, gateTime);
    }
    this.trackReleasingVoices.delete(key);
  }

  /**
   * End a voice because a *new note* is taking over its channel.
   *
   * On a module channel this is a cut, not a release: the channel has one
   * voice and the new note takes it, so the previous note stops making sound
   * outright. Going through the release path here left it ringing under the
   * new note for the whole envelope fadeout.
   *
   * A song authored in this tracker has no such constraint -- overlapping
   * notes on a track are allowed -- so there the previous note is released and
   * allowed to ring out.
   */
  endVoiceForReplacement(
    instrument: ActiveInstrument['instrument'],
    voiceIndex: number,
    time: number,
  ) {
    if (!this.deps.isMonophonicChannel()) {
      instrument.gateOffVoiceAtTime(voiceIndex, time);
      return;
    }
    const cuttable = instrument as { cutVoiceAtTime?: (v: number, t: number) => void };
    if (typeof cuttable.cutVoiceAtTime === 'function') {
      cuttable.cutVoiceAtTime(voiceIndex, time);
      return;
    }
    instrument.gateOffVoiceAtTime(voiceIndex, time);
  }

  /**
   * Resolve the voice a per-voice command should address.
   *
   * This is the single resolution path for every command that modifies a
   * *sounding* voice -- pitch, volume, pan, envelope position, sample offset,
   * retrigger. It exists because the obvious reading of a pattern row is
   * wrong: the instrument number written on a row says what a *new note*
   * should use, and is not a name for what the channel is currently playing.
   * When the two disagree -- an XM tone-portamento row, a MOD sample latch, a
   * key-off carrying the next note's instrument -- an instrument-first lookup
   * finds no voice and the command is dropped, having been computed
   * perfectly. See D29/D55/D65/D68/D77 in PLAN-module-format-support.md.
   *
   * The rule, stated once: *only a row that starts a note changes what a
   * channel is playing, and every per-voice command must address the voice
   * that is sounding.*
   *
   * Order of resolution:
   *   1. An explicit `voiceIndex >= 0` from the effect processor wins.
   *   2. On a module channel (monophonic), resolve *only* through
   *      `trackVoiceOwner`. `requestedInstrumentId` is advisory -- good for
   *      logging, never for lookup. No owner means no voice: drop the command
   *      rather than falling back to the instrument.
   *   3. On a native song a track is polyphonic, so "the track's voice" is not
   *      unique and `trackVoiceOwner` cannot answer. Keep the historical
   *      instrument-first lookup there.
   *
   * Returns undefined when nothing is sounding for this command to apply to,
   * which callers must treat as "drop it" -- never as "guess".
   */
  resolveCommandVoice(
    requestedInstrumentId: string,
    voiceIndex: number,
    trackIndex: number | undefined,
  ):
    | { instrumentId: string; active: ActiveInstrument; voiceIndex: number }
    | undefined {
    const within = (
      active: ActiveInstrument | undefined,
      index: number,
    ): active is ActiveInstrument =>
      !!active && index >= 0 && index < active.instrument.getVoiceLimit();

    // 1. The effect processor named a voice outright.
    if (voiceIndex >= 0) {
      const active = this.deps.instruments.get(requestedInstrumentId);
      if (!within(active, voiceIndex)) return undefined;
      return { instrumentId: requestedInstrumentId, active, voiceIndex };
    }

    // 2. Module channel: the channel owns the voice, whatever the row says.
    if (this.deps.isMonophonicChannel()) {
      if (!Number.isFinite(trackIndex as number)) return undefined;
      const owner = this.trackVoiceOwner.get(trackIndex as number);
      if (!owner) return undefined;
      const active = this.deps.instruments.get(owner.instrumentId);
      if (!within(active, owner.voiceIndex)) return undefined;
      return {
        instrumentId: owner.instrumentId,
        active,
        voiceIndex: owner.voiceIndex,
      };
    }

    // 3. Native song: polyphonic track, so look the instrument's own voice up.
    const active = this.deps.instruments.get(requestedInstrumentId);
    if (!active) return undefined;
    const trackKey = Number.isFinite(trackIndex as number)
      ? (trackIndex as number)
      : -1;
    const resolved = this.lastTrackVoice
      .get(requestedInstrumentId)
      ?.get(trackKey);
    if (resolved === undefined || !within(active, resolved)) return undefined;
    return {
      instrumentId: requestedInstrumentId,
      active,
      voiceIndex: resolved,
    };
  }
}
