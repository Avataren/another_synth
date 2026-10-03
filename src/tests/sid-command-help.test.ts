import { describe, expect, it } from 'vitest';
import { SID_COMMANDS, sidCommandHint } from 'src/audio/tracker/sid-command-help';

describe('sidCommandHint', () => {
  it('has all sixteen commands', () => {
    expect(SID_COMMANDS).toHaveLength(16);
  });

  it('names the command under the cursor', () => {
    expect(sidCommandHint('435')).toMatch(/^Command 4: Vibrato/);
    expect(sidCommandHint('F83')).toMatch(/Set tempo/);
    expect(sidCommandHint('d0a')).toMatch(/Set master volume/);
  });

  it('asks for a command when the cell is empty or 0', () => {
    expect(sidCommandHint(undefined)).toMatch(/digit 1-F/);
    expect(sidCommandHint('')).toMatch(/digit 1-F/);
    expect(sidCommandHint('000')).toMatch(/digit 1-F/);
  });
});
