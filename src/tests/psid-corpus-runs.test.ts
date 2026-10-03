import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePsid } from 'src/audio/tracker/psid';
import { PsidRunner } from 'src/audio/tracker/psid/psid-runner';

/**
 * Every `.sid` of the fixture corpus (the famous-tunes set of
 * `fixtures/psid/README.md` and the older fixtures) runs on the native player:
 * it parses, its start song initialises, and in two seconds of emulated time
 * its code writes the SID without stopping.
 */

const ROOT = resolve(__dirname, 'fixtures/psid');
const files: string[] = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(ROOT, d.name)).filter((f) => f.endsWith('.sid')).map((f) => `${d.name}/${f}`));

describe('the .sid corpus on the native player', () => {
  it('has the famous-tunes set', () => {
    expect(files.length).toBeGreaterThanOrEqual(150);
  });

  it('runs every tune: init returns, the code writes the SID, nothing jams', () => {
    const failures: string[] = [];
    for (const name of files) {
      const parsed = parsePsid(new Uint8Array(readFileSync(join(ROOT, name))));
      if (!parsed.ok) {
        failures.push(`${name}: ${parsed.reason}`);
        continue;
      }
      const made = PsidRunner.create(parsed.file, parsed.file.startSong - 1);
      if (!made.ok) {
        failures.push(`${name}: ${made.reason}`);
        continue;
      }
      const cycles = made.runner.clockHz * 2;
      made.runner.advance(cycles);
      let writes = 0;
      made.runner.drain(cycles, () => writes++);
      if (made.runner.ended !== null) failures.push(`${name}: ${made.runner.ended}`);
      else if (writes === 0) failures.push(`${name}: wrote nothing to the SID`);
    }
    expect(failures).toEqual([]);
  }, 120000);
});
