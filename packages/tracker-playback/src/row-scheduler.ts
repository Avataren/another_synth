/**
 * `scheduleRow`, moved out of `PlaybackEngine` (arch-review §5). The body is
 * unchanged and still runs with the engine as `this`; `ScheduleRowHost` names
 * the engine members it reads and writes.
 */
import {
  type MacroHandler,
  type ModuleFormat,
  type Pattern,
  type ScheduledAutomationHandler,
  type ScheduledFilterHandler,
  type ScheduledGlobalVolumeHandler,
  type ScheduledMacroHandler,
  type ScheduledNoteEvent,
  type ScheduledNoteHandler,
  type ScheduledPitchHandler,
  type ScheduledVolumeHandler,
  type Step,
} from './types';
import {
  type TrackEffectState,
  processEffectTick0,
  processEffectTickN,
  processVolumeColumnTick0,
  processVolumeColumnTickN,
  volumeCommandIsTickBased,
  resetEffectStateForNote,
  type ProcessorCommand,
} from './effect-processor';
import type { TimingSystem } from './timing-system';
import type { FormatProfile } from './format-profile';

export interface ScheduleRowHost {
  dispatchCommands(
    commands: ProcessorCommand[],
    context: {
      instrumentId: string;
      row: number;
      trackIndex: number;
      time: number;
      voiceIndex: number;
    },
  ): void;
  isTickBasedEffect(type: string): boolean;
  canUseAutomationRamp(type: string): boolean;
  getTrackEffectState(trackIndex: number): TrackEffectState;
  getMsPerTick(): number;
  getMsPerRow(): number;
  readonly scheduledNoteHandler: ScheduledNoteHandler | undefined;
  stepIndex: Map<number, PlaybackPatternStep[]>;
  pendingPosCommand: {
    type: 'posJump' | 'patBreak';
    value: number;
  } | null;
  patternLoopCount: number;
  patternLoopStart: number;
  patternLoopPending: boolean;
  patternDelayCount: number;
  pendingSongStop: boolean;
  lastTrackNote: Map<number, { midi: number; velocity: number }>;
  tracksWithStepsScratch: Set<number>;
  trackEffectStates: (TrackEffectState | undefined)[];
  formatProfile: FormatProfile;
  moduleFormat: ModuleFormat;
  timingSystem: TimingSystem;
  globalVolume: number;
  readonly scheduledVolumeHandler: ScheduledVolumeHandler | undefined;
  readonly scheduledGlobalVolumeHandler:
    | ScheduledGlobalVolumeHandler
    | undefined;
  readonly scheduledPitchHandler: ScheduledPitchHandler | undefined;
  readonly scheduledAutomationHandler:
    | ScheduledAutomationHandler
    | undefined;
  readonly scheduledFilterHandler: ScheduledFilterHandler | undefined;
  readonly scheduledMacroHandler: ScheduledMacroHandler | undefined;
  readonly macroHandler: MacroHandler | undefined;
}

export type PlaybackPatternStep = Pattern['tracks'][number]['steps'][number] & {
  trackIndex: number;
};

export function shouldRetriggerLastNote(
  newNote: number | undefined,
  step: Pick<
    Step,
    'instrumentId' | 'velocity' | 'effect' | 'speedCommand' | 'tempoCommand'
  >,
  /**
   * Whether the song is one authored here.
   *
   * "A naked instrument number revives the last note" is this tracker's own
   * convention. No module format has it: in ProTracker and FT2 alike a sample
   * or instrument number on its own selects the sample and reloads the channel
   * volume, and never retriggers (D15, D29).
   *
   * It went unnoticed for MOD because mod-import stamps a volume on those rows
   * for unrelated reasons, and `velocity` being present bails out below. XM has
   * no such accident, so every row carrying nothing but a volume-column command
   * revived the channel's last note -- 26 spurious retriggers per channel on
   * three channels of elw-sick.xm, and 18 on another. Those rows only started
   * reaching the engine at all when the volume column landed (D50), which is
   * what turned a latent wrong rule into an audible one.
   */
  isNativeSong = true,
): boolean {
  if (newNote !== undefined) return false;
  if (!isNativeSong) return false;
  if (!step.instrumentId) return false;
  if (step.velocity !== undefined) return false;
  // Fxx (speed/tempo) is tracked on its own step fields, not step.effect,
  // so a row carrying *only* a speed/tempo change (no note, no other
  // effect) falls through to the "naked instrument number" case below and
  // looks identical to it. But a bare speed/tempo change is never a
  // note-retrigger convention in any tracker format -- and
  // useTrackerSongBuilder stamps instrumentId onto every row sticky, so
  // real-world patterns that alternate speed every row (a common
  // shuffle/groove trick, e.g. repeated F05/F06) used to replay the
  // track's last note from scratch on every single row instead of letting
  // it sustain, which is audible as a sample retriggering nonstop instead
  // of playing normally.
  if (step.speedCommand !== undefined || step.tempoCommand !== undefined) {
    return false;
  }
  const effectType = step.effect?.type;
  if (effectType === undefined) return true;
  if (effectType === 'volSlide') {
    // Only retrigger on vol slides when the row also carries a note.
    // Naked Axx rows should not revive the last note.
    return (
      (step as { midi?: number; note?: string }).midi !== undefined ||
      (step as { midi?: number; note?: string }).note !== undefined
    );
  }
  return false;
}

export function scheduleRow(
  this: ScheduleRowHost,
  row: number,
  time: number,
) {
    if (!this.scheduledNoteHandler) return;

    const steps = this.stepIndex.get(row);

    // First pass: Apply speed/tempo commands (F commands) and position commands
    if (steps) {
      let rowHasPatDelay = false;
      for (const step of steps) {
        if (step.speedCommand !== undefined) {
          if (step.speedCommand === 0 && this.formatProfile.f00StopsSong) {
            // F00: ProTracker's setSpeed turns a zero parameter into
            // doStopSong = true -- the song stops after this row plays out.
            // Clamping it to speed 1 (as this used to) compressed the rest
            // of the song to six times its tempo instead. FT2 reads F00 as
            // speed 0, which stalls its own replayer; the profile keeps the
            // old clamp there.
            this.pendingSongStop = true;
          } else {
            // F01-F1F: Set speed (1-31, where 6 is normal)
            this.timingSystem.setSpeed(step.speedCommand);
          }
        }
        if (step.tempoCommand !== undefined) {
          // F20-FF: Set BPM directly (32-255)
          this.timingSystem.setBpm(step.tempoCommand);
        }

        // Check for position commands (Bxx, Dxx), pattern flow commands (E6x, EEx),
        // and song-level global volume commands (Gxx/Hxy).
        if (step.effect) {
          if (step.effect.type === 'posJump') {
            // Bxx overrides any earlier Dxx on the same row (PatternJump.mod behavior)
            this.pendingPosCommand = {
              type: 'posJump',
              value: step.effect.paramX * 16 + step.effect.paramY,
            };
          } else if (step.effect.type === 'patBreak') {
            // Only set if no posJump has already claimed this row
            if (
              !this.pendingPosCommand ||
              this.pendingPosCommand.type !== 'posJump'
            ) {
              const rawTarget = step.effect.paramX * 10 + step.effect.paramY; // FT2 uses decimal for Dxx
              const adjustedTarget = rowHasPatDelay ? rawTarget + 1 : rawTarget;
              this.pendingPosCommand = {
                type: 'patBreak',
                value: adjustedTarget,
              };
            }
          } else if (
            step.effect.type === 'extEffect' &&
            step.effect.extSubtype === 'patLoop'
          ) {
            // E6x: Pattern loop.
            //
            // ProTracker and FT2 both keep a single countdown rather than a
            // "how many times have I been here" tally: the first visit to
            // E6x loads the counter, every later visit decrements it, and the
            // jump happens while it is still above zero. Counting upward
            // toward a target instead -- as this did -- re-arms the effect on
            // the row it lands back on and either never jumps or never stops.
            const loopCount = step.effect.paramY;
            if (loopCount === 0) {
              // E60: Set loop start point.
              this.patternLoopStart = row;
            } else {
              if (this.patternLoopCount === 0) {
                this.patternLoopCount = loopCount;
              } else {
                this.patternLoopCount--;
              }
              this.patternLoopPending = this.patternLoopCount > 0;
            }
          } else if (step.effect.type === 'patDelay') {
            // EEx: Pattern delay - repeat this row x times
            const delayCount = step.effect.paramY;
            if (delayCount > 0 && this.patternDelayCount === 0) {
              this.patternDelayCount = delayCount;
              rowHasPatDelay = true;
            }
          } else if (step.effect.type === 'setGlobalVol') {
            // Gxx: Set global volume. FT2's range is 0-64 and it clamps
            // above that: `if (param > 64) param = 64;` (ft2-clone,
            // setGlobalVolume). See D80.
            const raw = step.effect.paramX * 16 + step.effect.paramY;
            const clamped = Math.max(0, Math.min(64, raw));
            this.globalVolume = clamped / 64;
            if (this.scheduledGlobalVolumeHandler) {
              this.scheduledGlobalVolumeHandler(this.globalVolume, time);
            }
          } else if (step.effect.type === 'globalVolSlide') {
            // Hxy: Global volume slide (x=up, y=down), applied once per row.
            // FT2 runs it once per *tick*; see D81 for why that is left alone
            // rather than changed blind.
            const up = step.effect.paramX;
            const down = step.effect.paramY;
            if (up > 0 && down === 0) {
              this.globalVolume = Math.min(1, this.globalVolume + up / 64);
            } else if (down > 0 && up === 0) {
              this.globalVolume = Math.max(0, this.globalVolume - down / 64);
            }
            if (this.scheduledGlobalVolumeHandler) {
              this.scheduledGlobalVolumeHandler(this.globalVolume, time);
            }
          } else if (
            step.effect.type === 'extEffect' &&
            step.effect.extSubtype === 'filterToggle'
          ) {
            // E0x "Set filter" (ProTracker numbering; S3M's S00 decodes to
            // the same subtype). libopenmpt `Snd_fx.cpp` `ExtendedMODCommands`
            // case 0x00, fetched 2026-09-04 (D115):
            //
            //   m_PlayState.Chn[channel].dwFlags.set(CHN_AMIGAFILTER, !(param & 1));
            //
            // inside a loop over every channel -- so the polarity is
            // `!(param & 1)` (E00 = filter ON, E01 = filter OFF; the LED
            // filter is on while the power LED is lit) and the command is
            // global, not per-track. Dispatch is gated per format by
            // `FormatProfile.filterToggleCommand`: MOD and native dispatch,
            // XM (FT2 dummies E0x) and S3M (ST3.21 dummies S0x) do not.
            if (this.formatProfile.filterToggleCommand) {
              this.scheduledFilterHandler?.(
                (step.effect.paramY & 1) === 0,
                time,
              );
            }
          }
        }
      }
    }

    // Compute row/tick durations *after* the first pass above has applied
    // any F05/F06-style speed (or tempo) command carried by this row.
    // ProTracker semantics: a speed/tempo change on a row takes effect
    // immediately -- it governs that same row's own remaining ticks, not
    // just rows after it. Capturing these before the first pass (as this
    // used to) left every per-tick effect on a speed-changing row (note
    // delay, retrigger, vibrato/tremolo, tremor, ramped porta/volslide)
    // using the *previous* row's tick duration paired with the *new*
    // row's tick count from timingSystem.getTicksPerRow() -- a mismatch
    // that scrambled sub-row timing specifically on rows that change
    // speed, e.g. a shuffle/groove pattern alternating F05/F06 every row.
    const msPerRow = this.getMsPerRow();
    const msPerTick = this.getMsPerTick();
    const secPerTick = msPerTick / 1000;
    const secPerRow = msPerRow / 1000;

    // Second pass: Process each step with effects
    //
    // dispatchCommands only reads the context, never retains it (see its
    // body: every handler call gets a freshly built event object holding
    // copied scalar fields), so one mutable context object is reused across
    // the row's steps, and one across the row's ticks, rather than a fresh
    // allocation per step.
    const context: {
      instrumentId: string;
      row: number;
      trackIndex: number;
      time: number;
      voiceIndex: number;
    } = { instrumentId: '', row, trackIndex: 0, time, voiceIndex: 0 };
    const tickContext: {
      instrumentId: string;
      row: number;
      trackIndex: number;
      time: number;
      voiceIndex: number;
    } = { instrumentId: '', row, trackIndex: 0, time, voiceIndex: 0 };
    if (steps) {
      for (const step of steps) {
        const trackIndex = step.trackIndex;
        const effectState = this.getTrackEffectState(trackIndex);

        // Resolve instrumentId: use explicit step.instrumentId, or fall back to
        // the instrument currently playing on this track (for "naked" effects)
        let instrumentId = step.instrumentId;
        if (!instrumentId && effectState.instrumentId) {
          instrumentId = effectState.instrumentId;
        }

        // Skip if no instrument ID is available at all
        if (!instrumentId) continue;

        // Update effect state with current instrument (for future "naked" effects)
        if (step.instrumentId) {
          effectState.instrumentId = step.instrumentId;
        }

        // Handle macros
        if (step.macroIndex !== undefined && step.macroValue !== undefined) {
          if (this.scheduledMacroHandler) {
            const ramp =
              step.macroRamp && step.macroRamp.targetRow > row
                ? {
                    targetValue: step.macroRamp.targetValue,
                    // Nudge the ramp to end just before the target row start to avoid overlapping set/ramp at identical times
                    targetTime: (() => {
                      const ideal =
                        time + (step.macroRamp.targetRow - row) * secPerRow;
                      const epsilon = 1e-5; // 10 microseconds
                      return Math.max(time + epsilon, ideal - epsilon);
                    })(),
                    ...(step.macroRamp.interpolation
                      ? { interpolation: step.macroRamp.interpolation }
                      : {}),
                  }
                : undefined;
            this.scheduledMacroHandler(
              instrumentId,
              step.macroIndex,
              step.macroValue,
              time,
              ramp,
            );
          } else if (this.macroHandler) {
            this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
          }
        }

        context.instrumentId = instrumentId;
        context.trackIndex = step.trackIndex;
        context.voiceIndex = effectState.voiceIndex;
        context.time = time;

        // Handle note-off
        if (step.isNoteOff) {
          const event: ScheduledNoteEvent = {
            type: 'noteOff',
            instrumentId,
            row,
            trackIndex: step.trackIndex,
            time,
          };
          if (step.midi !== undefined) {
            event.midi = step.midi;
          }
          this.scheduledNoteHandler(event);
          effectState.hasActiveVoice = false;
          continue;
        }

        // Check if we have an effect that needs per-tick processing
        const hasTickEffect =
          step.effect && this.isTickBasedEffect(step.effect.type);

        // Handle note-on with effect processing
        let newNote = step.midi;
        let newVelocity = step.velocity;

        // If an instrument is specified but no note/effect/velocity is provided, retrigger the last
        // note played on this track (if any). Skip when velocity is set so volume-only rows
        // don’t restart the sample.
        if (
          shouldRetriggerLastNote(newNote, step, this.moduleFormat === 'native')
        ) {
          const last = this.lastTrackNote.get(step.trackIndex);
          if (last) {
            newNote = last.midi;
            if (newVelocity === undefined) {
              newVelocity = last.velocity;
            }
          } else {
            // Fallback to the track effect state's current note/volume if we
            // don't have an explicit last note recorded yet.
            newNote = Math.round(effectState.currentMidi);
            if (newVelocity === undefined) {
              newVelocity = Math.round(
                Math.max(0, Math.min(1, effectState.currentVolume)) * 255,
              );
            }
          }
        }

        // Reset effect state on new note (unless tone portamento). The
        // volume column's Mx is one too: resetting here would clear
        // hasActiveVoice and so retrigger the sample the note is meant to
        // bend towards.
        const volumeColumnTonePorta = step.volumeCommand?.type === 'tonePorta';
        if (
          newNote !== undefined &&
          step.effect?.type !== 'tonePorta' &&
          step.effect?.type !== 'tonePortaVol' &&
          !volumeColumnTonePorta
        ) {
          resetEffectStateForNote(effectState);
        }

        // Process tick 0 (pass step.frequency for ProTracker MODs)
        const tick0Batch = processEffectTick0(
          effectState,
          step.effect,
          newNote,
          newVelocity,
          step.frequency,
          this.timingSystem.getTicksPerRow(),
          step.pan,
          step.volumeColumnVolume,
          volumeColumnTonePorta,
        );

        // FT2's volume column runs alongside the effect column, after the
        // row's own volume has been established: its fine slides and pan
        // commands adjust the note's volume rather than being overwritten by
        // it, and its tone portamento needs the target the note above just
        // resolved.
        const volume0Batch = processVolumeColumnTick0(
          effectState,
          step.volumeCommand,
        );

        // // Debug the tone porta state for track 3 (fourth track) to investigate 3xx slides.
        // if (step.trackIndex === 3) {
        //   const pitchCmd = tick0Batch.commands.find((cmd) => cmd.kind === 'pitch');
        //   console.log(
        //     `[PitchState] row=${row} track=${step.trackIndex} note=${newNote ?? '—'} ` +
        //       `effect=${step.effect?.type ?? 'none'} speed=${effectState.tonePortaSpeed} ` +
        //       `curr=${effectState.currentFrequency.toFixed(4)}Hz ` +
        //       `target=${effectState.targetFrequency.toFixed(4)}Hz ` +
        //       `period=${effectState.currentPeriod ?? '—'} ` +
        //       `pitchCmd=${pitchCmd && 'frequency' in pitchCmd ? pitchCmd.frequency.toFixed(4) : 'none'} ` +
        //       `voice=${effectState.voiceIndex}`,
        //   );
        // }

        this.dispatchCommands(tick0Batch.commands, context);
        this.dispatchCommands(volume0Batch.commands, context);

        // Handle volume automation (Cxx or step velocity)
        // NOTE: Effects like EA1 (fine volume slide) emit volume commands
        // above, and so do the volume column's own 0x8x/0x9x fine slides --
        // both have already folded step.velocity into their result, so
        // applying it again here would undo them.
        const tick0HasVolumeCommand =
          hasVolumeCommand(tick0Batch.commands) ||
          hasVolumeCommand(volume0Batch.commands);
        if (step.velocity !== undefined && !tick0HasVolumeCommand) {
          const gain = clamp(step.velocity / 255);
          if (this.scheduledVolumeHandler) {
            // Per-track velocity should drive per-voice gain, not global instrument gain.
            this.scheduledVolumeHandler(
              instrumentId,
              -1, // resolve via track voice history
              gain,
              time,
              step.trackIndex,
              // Instantaneous, because that is what a set-volume is. A row's
              // velocity is a Cxx, an XM volume-column set-volume or a sample
              // number's default -- never a slide, which arrives as a command
              // from the batches above and keeps its own ramp.
              //
              // Left unqualified it ramped linearly from the *previous*
              // automation event, i.e. across the whole preceding row. The
              // staccato lead in jaguar_xj220_title.mod (order 6, channel 2)
              // is the case that exposed it: every note is silenced by a bare
              // "C00" a row or two later, and each of those faded the note out
              // over a full row instead of cutting it, turning a clipped
              // melody into a legato one.
              'step',
            );
          } else if (this.scheduledAutomationHandler) {
            // Fallback: legacy global gain path
            this.scheduledAutomationHandler(instrumentId, gain, time);
          }
        }

        // Schedule per-tick effects for ticks 1 to ticksPerRow-1
        const hasTickVolumeCommand = volumeCommandIsTickBased(
          step.volumeCommand,
        );
        if ((hasTickEffect && step.effect) || hasTickVolumeCommand) {
          // The ramp shortcut below collapses the whole row into one
          // automation ramp, so it can only be taken when the effect column is
          // the only thing with per-tick work. A volume-column slide running
          // at the same time needs its own commands at their own times.
          const canUseRamp =
            !!step.effect &&
            hasTickEffect &&
            !hasTickVolumeCommand &&
            this.canUseAutomationRamp(step.effect.type);

          if (canUseRamp && step.effect) {
            // Optimization: Process all ticks to maintain correct state, but use a single
            // ramp to the final value instead of scheduling each tick discretely.
            // This reduces scheduling calls from 5 per row to 1 per row (83% reduction)
            // while maintaining correct effect state progression.
            let finalFrequency: number | undefined;
            let finalVolume: number | undefined;

            const ticksPerRow = this.timingSystem.getTicksPerRow();
            // Process all ticks to advance effect state correctly
            for (let tick = 1; tick < ticksPerRow; tick++) {
              const tickBatch = processEffectTickN(
                effectState,
                step.effect,
                tick,
                ticksPerRow,
              );
              // Keep track of final values
              for (const cmd of tickBatch.commands) {
                if (cmd.kind === 'pitch') finalFrequency = cmd.frequency;
                if (cmd.kind === 'volume') finalVolume = cmd.volume;
              }
            }

            // Schedule smooth ramp to final value (instead of discrete per-tick values)
            const endTime = time + (ticksPerRow - 1) * secPerTick;

            if (this.scheduledPitchHandler && finalFrequency !== undefined) {
              // Use exponential ramp for pitch (frequency is exponential)
              this.scheduledPitchHandler(
                instrumentId,
                effectState.voiceIndex,
                finalFrequency,
                endTime,
                step.trackIndex,
                'exponential',
              );
            }

            if (this.scheduledVolumeHandler && finalVolume !== undefined) {
              // Use linear ramp for volume
              this.scheduledVolumeHandler(
                instrumentId,
                effectState.voiceIndex,
                finalVolume,
                endTime,
                step.trackIndex,
                'linear',
              );
            }
          } else {
            // Complex effects (vibrato, tremolo, arpeggio, etc.) still need per-tick processing
            const ticksPerRow = this.timingSystem.getTicksPerRow();
            tickContext.instrumentId = context.instrumentId;
            tickContext.trackIndex = context.trackIndex;
            tickContext.voiceIndex = context.voiceIndex;
            tickContext.time = time;
            for (let tick = 1; tick < ticksPerRow; tick++) {
              tickContext.time = time + tick * secPerTick;
              if (hasTickEffect && step.effect) {
                const tickBatch = processEffectTickN(
                  effectState,
                  step.effect,
                  tick,
                  ticksPerRow,
                );
                this.dispatchCommands(tickBatch.commands, tickContext);
              }
              if (hasTickVolumeCommand) {
                const volumeBatch = processVolumeColumnTickN(
                  effectState,
                  step.volumeCommand,
                );
                this.dispatchCommands(volumeBatch.commands, tickContext);
              }
            }
          }
        }
      }
    }

    // Tracker patterns omit empty cells altogether, so a track with no step on
    // this row otherwise receives no tick processing. On ProTracker and FT2
    // that is exactly right -- an empty cell is command 0, so an unfinished
    // tone portamento stops where its last 3xx row left it, and running these
    // rows through processEffectTickN sent space_debris.mod's order-1 C-2
    // slide falling far past its target through order 2. S3M keeps the
    // continue-through-blanks behaviour for 2nd Reality's order 45; see
    // `tonePortaContinuesThroughEmptyRows` in format-profile.ts.
    const tracksWithSteps = this.tracksWithStepsScratch;
    tracksWithSteps.clear();
    if (steps) {
      for (const step of steps) {
        tracksWithSteps.add(step.trackIndex);
      }
    }
    for (
      let trackIndex = 0;
      trackIndex < this.trackEffectStates.length;
      trackIndex++
    ) {
      const effectState = this.trackEffectStates[trackIndex];
      if (
        !effectState ||
        tracksWithSteps.has(trackIndex) ||
        !effectState.hasActiveVoice ||
        !effectState.instrumentId
      ) {
        continue;
      }

      // ST3 (st3play digcmd.c docmd1, the `ch->cmd == 0` arm): a cell with no
      // effect command restores the channel period to its base -- so a
      // vibrato (H/U) that has stopped springs the held pitch offset back to
      // the note on this effectless row. `processEffectTick0` guarantees the
      // same for a track that *does* have a (non-vibrato) step this row; this
      // covers the tracks the row omits entirely. Emitted once at row start;
      // a later effectless row finds `vibratoApplied` already cleared, like
      // st3play's `if (ch->aspd != ch->aorgspd)` guard. ProTracker/FT2 hold
      // the offset instead (D75), hence the profile gate.
      if (
        effectState.profile.pitchResetsAfterEffectlessRow === true &&
        effectState.vibratoApplied
      ) {
        effectState.vibratoApplied = false;
        effectState.vibratoHeldWave = 0;
        context.instrumentId = effectState.instrumentId;
        context.trackIndex = trackIndex;
        context.voiceIndex = effectState.voiceIndex;
        context.time = time;
        this.dispatchCommands(
          [
            {
              kind: 'pitch',
              frequency: effectState.currentFrequency,
              voiceIndex: effectState.voiceIndex,
            },
          ],
          context,
        );
      }

      if (
        effectState.profile.tonePortaContinuesThroughEmptyRows !== true ||
        !effectState.tonePortaActive ||
        effectState.tonePortaSpeed <= 0
      ) {
        continue;
      }

      context.instrumentId = effectState.instrumentId;
      context.trackIndex = trackIndex;
      context.voiceIndex = effectState.voiceIndex;
      context.time = time;
      const ticksPerRow = this.timingSystem.getTicksPerRow();
      tickContext.instrumentId = context.instrumentId;
      tickContext.trackIndex = trackIndex;
      tickContext.voiceIndex = context.voiceIndex;
      tickContext.time = time;
      for (let tick = 1; tick < ticksPerRow; tick++) {
        tickContext.time = time + tick * secPerTick;
        const tickBatch = processEffectTickN(
          effectState,
          undefined,
          tick,
          ticksPerRow,
        );
        this.dispatchCommands(tickBatch.commands, tickContext);
      }
    }

    // Note: Position commands (Bxx, Dxx) are now handled in scheduleAhead()
    // after this row is scheduled, so the scheduling loop can react immediately
}

/** Whether a command batch carries a volume command, without building one. */
function hasVolumeCommand(commands: ProcessorCommand[]): boolean {
  for (let i = 0; i < commands.length; i++) {
    if (commands[i]!.kind === 'volume') return true;
  }
  return false;
}

export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}
