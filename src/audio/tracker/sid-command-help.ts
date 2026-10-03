/**
 * What a GoatTracker pattern command does, for the cursor hint and the Help
 * page. A command is one hex digit (1-F) and a two-digit hex parameter; 0 is
 * "no command". The meanings are GoatTracker 2's own (its readme, "Pattern commands").
 */
export interface SidCommandHelp {
  readonly name: string;
  /** What the two parameter digits mean. */
  readonly param: string;
}

export const SID_COMMANDS: readonly SidCommandHelp[] = [
  { name: 'No command', param: 'ignored' },
  { name: 'Portamento up', param: 'speed table row' },
  { name: 'Portamento down', param: 'speed table row' },
  { name: 'Tone portamento', param: 'speed table row (00 = tie the note)' },
  { name: 'Vibrato', param: 'speed table row (left: ticks per direction, right: depth)' },
  { name: 'Set attack/decay', param: 'AD byte' },
  { name: 'Set sustain/release', param: 'SR byte' },
  { name: 'Set waveform', param: 'waveform byte' },
  { name: 'Set wave table pointer', param: 'wave table row (00 stops)' },
  { name: 'Set pulse table pointer', param: 'pulse table row (00 stops)' },
  { name: 'Set filter table pointer', param: 'filter table row (00 stops)' },
  { name: 'Set filter control', param: 'X resonance, Y voice bitmask (00 = filter off)' },
  { name: 'Set filter cutoff', param: 'cutoff byte' },
  { name: 'Set master volume', param: '0Y: volume 0-F' },
  { name: 'Funk tempo', param: 'speed table row (its two values alternate as the tempo)' },
  { name: 'Set tempo', param: '03-7F all voices, 83-FF this voice only (minus 80), 00-01 recall the funk tempo' },
];

/** The hint line for a pattern command cell holding `macro` (`''` when empty), e.g. `435`. */
export function sidCommandHint(macro: string | undefined): string {
  const first = (macro ?? '').trim()[0]?.toUpperCase() ?? '';
  const code = /^[0-9A-F]$/.test(first) ? Number.parseInt(first, 16) : 0;
  if (code === 0) return 'Command: a digit 1-F, then a two-digit parameter (see Help for the list).';
  const command = SID_COMMANDS[code]!;
  return `Command ${first}: ${command.name}. Parameter: ${command.param}.`;
}
