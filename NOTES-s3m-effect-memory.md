# Open: ST3's single shared effect memory (S3M)

Status: **found, measured, not implemented.** Split out of the D125 volume-slide
fix (2026-09-06) so it can be picked up on its own. Everything below is quoted
from reference or counted against the vendored corpus in `public/demos/s3m`.

## The behaviour

Every other tracker this engine models gives each command its own parameter
memory: a bare `A00` repeats the last *volume slide*, a bare `100` the last
*portamento up*, and the two never see each other's parameter. That is what
`TrackEffectState` encodes — `lastVolSlide`, `lastTonePorta`, `lastVibrato`,
`lastTremolo`, `lastArpeggio`, `lastTremor`, `lastRetrigger`, one field per
behaviour.

Scream Tracker 3 has **one** memory byte per channel, shared by nearly every
command. OpenMPT models it as the `kST3EffectMemory` play behaviour, and the
whole of it is `UpdateS3MEffectMemory` (`soundlib/Snd_fx.cpp`, fetched
2026-09-06):

```cpp
void CSoundFile::UpdateS3MEffectMemory(ModChannel &chn, ModCommand::PARAM param) const
{
	chn.nOldVolumeSlide = param; // Dxy / Kxy / Lxy
	chn.nOldPortaUp = param;     // Exx / Fxx
	chn.nOldPortaDown = param;   // Exx / Fxx
	chn.nTremorParam = param;    // Ixy
	chn.nArpeggio = param;       // Jxy
	chn.nRetrigParam = param;    // Qxy
	chn.nTremoloDepth = (param & 0x0F) << 2;  // Rxy
	chn.nTremoloSpeed = (param >> 4) & 0x0F;  // Rxy
	chn.nOldCmdEx = param;                    // Sxy
}
```

called after every row's effect is processed, from two places, under the same
guard both times:

```cpp
if(m_playBehaviour[kST3EffectMemory] && cmd != CMD_NONE && param != 0)
	UpdateS3MEffectMemory(chn, static_cast<ModCommand::PARAM>(param));
```

So **any** command with a non-zero parameter overwrites the memory that **every**
listed command will read on its next zero parameter. A `D08` on one row makes a
following `E00` a portamento down by 8; a `J37` arpeggio makes a following `Q00`
a retrigger with parameter 0x37.

Note what is *not* in the list: tone portamento (`Gxx`) and vibrato (`Hxy`) keep
their own memories, and sample offset (`Oxx`) is absent too. So this is not
"one memory for everything" — it is one memory for that specific set.

## How much it matters here

Counted over the 40 vendored `.s3m` demos, restricted to the commands in the
list above, comparing the parameter ST3's shared memory would supply against the
one our per-command memories supply:

| | cells |
|---|---|
| zero-parameter cells on those commands | 60317 |
| …where the shared memory differs from the per-command memory | **1511** |

It is not spread evenly. Two modules carry most of it:

| module | zero-param cells | differ | share |
|---|---|---|---|
| `energia.s3m` | 1142 | 320 | **28%** |
| `point_of_departure.s3m` | 7537 | 647 | **9%** |
| `escape_from_pori.s3m` | 2402 | 151 | 6% |
| `astraying_voyages.s3m` | 3531 | 130 | 4% |
| `cool_city_volume_1_2.s3m` | 425 | 20 | 5% |
| `satellite_one.s3m` | 735 | 38 | 5% |
| everything else | — | ≤ 32 each | ≤ 3% |

`energia.s3m` is the module to listen to first.

## Why it was not done with D125

It cannot simply be switched on for `format === 's3m'`. OpenMPT gates it on the
file having actually been written by Scream Tracker 3, and turns it off again
for the trackers that write S3M files while disguising themselves as ST3
(`Load_s3m.cpp`, fetched 2026-09-06):

```cpp
if(nonCompatTracker)
{
	m_playBehaviour.reset(kST3NoMutedChannels);
	m_playBehaviour.reset(kST3EffectMemory);
	m_playBehaviour.reset(kST3PortaSampleChange);
	m_playBehaviour.reset(kST3VibratoMemory);
	m_playBehaviour.reset(KST3PortaAfterArpeggio);
	m_playBehaviour.reset(kST3OffsetWithoutInstrument);
	m_playBehaviour.reset(kApplyUpperPeriodLimit);
}
```

`nonCompatTracker` is set for the Imago Orpheus, Impulse Tracker, Schism and
OpenMPT branches of the `cwtv & 0xF000` switch, and — inside the Scream Tracker
branch itself — for ModPlug Tracker, Velvet Studio, PlayerPRO and Impulse
Tracker < 1.03, which are told apart by a fingerprint over `special`,
`ultraClicks`, `ordNum`, `flags`, `globalVol`, `masterVolume`, whether the
panning table is present, and whether the pattern parapointers sit after the
sample ones. `formats/s3m.ts` computes none of that today.

In our corpus the coarse split is already informative — `cwtv` high nibble 1 is
Scream Tracker (most files), 3 is Impulse Tracker (`2nd_reality`, `babylon`,
`insanity_unnamed`, `kraaap`, `riverflow`, `the_probe_maintheme`), 5 is OpenMPT
(`sun`) — but the fingerprint is the part that needs writing, and it is what
several *other* open ST3 behaviours in that same `if` block will need too.

## Shape of the work

1. **Parser (`packages/tracker-playback/src/formats/s3m.ts`).** Reproduce
   OpenMPT's tracker identification and expose it as `S3mSong.isST3` (D23: the
   parser reports, it does not interpret). The header fields it needs are all
   already read or trivially readable; `offsetsAreCanonical` needs the raw
   parapointer arrays, which the parser has.
2. **Importer (`src/audio/tracker/s3m-import.ts`).** Emit the flag on the song
   file, threaded exactly like `fastVolumeSlides` and `amigaLimits` before it
   (the D59 chain: importer → song file → store → `buildPlaybackSong` →
   `profileForFormat`). It composes with the existing S3M options the same way
   `fastVolumeSlides` does, so no new profile constants.
3. **Profile.** One field — `sharedEffectMemory: boolean` — false on every
   profile but the S3M ones this selects.
4. **Effect processor.** After a tick-0 effect with a non-zero parameter, stamp
   the raw byte into `lastVolSlide`, the porta memories, `lastTremor`,
   `lastArpeggio`, `lastRetrigger` and the tremolo speed/depth pair, gated on
   the profile field. The `(param & 0x0F) << 2` on tremolo depth is ST3's own
   scaling and must be reproduced, not normalised away. Leave tone portamento,
   vibrato and sample offset alone — they are deliberately absent from ST3's
   list.
5. **Tests.** The corpus-scale check is cheap to write as a pin: an `energia.s3m`
   event stream is the natural regression net, and it will change. Expect the
   S3M goldens to move again.

## Neighbours in the same `if` block

Worth auditing together, since they arrive with the same `isST3` flag and none
of them is implemented:

- `kST3VibratoMemory` — ST3 does not distinguish vibrato types in the memory and
  multiplies the depth by 4 (`Vibrato()` in Snd_fx.cpp; test case
  `VibratoTypeChange.s3m`). Our vibrato already scales by
  `profile.portamentoUnitScale` (4 for S3M), so this may already be equivalent —
  verify before touching it.
- `kST3OffsetWithoutInstrument` — `Oxx` applies on a row with no instrument
  number.
- `kST3PortaSampleChange`, `KST3PortaAfterArpeggio`, `kST3NoMutedChannels` (the
  importer already drops muted channels, which matches), `kApplyUpperPeriodLimit`.
