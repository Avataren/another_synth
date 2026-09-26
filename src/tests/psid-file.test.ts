import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { looksLikePsid, parsePsid, psidSongUsesCia, type PsidFile } from 'src/audio/tracker/psid';
import { psidIsPlaySidSpecific } from 'src/audio/tracker/psid/psid-file';
import { buildPsid as sidFile } from './helpers/psid-builder';

/**
 * plan-psid-import.md phase 1: the PSID/RSID header, as HVSC's
 * `SID_file_format.txt` lays it out. The fixtures' facts are the ones
 * `fixtures/psid/README.md` lists; the refusals are the header's own rules.
 */

const FIXTURES = resolve(__dirname, 'fixtures/psid');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
const parsed = (bytes: Uint8Array): PsidFile => {
  const r = parsePsid(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r.file;
};

const refusal = (bytes: Uint8Array): string => {
  const r = parsePsid(bytes);
  if (r.ok) throw new Error('parsed');
  return r.reason;
};

describe('parsePsid: the fixtures', () => {
  // [file, type, songs, start, load, last byte, init, play, name, author, released]
  const table: readonly (readonly [string, 'PSID' | 'RSID', number, number, number, number, number, number, string, string, string])[] = [
    ['hubbard_rob/commando.sid', 'PSID', 19, 1, 0x5000, 0x5fc6, 0x5fb2, 0x5012, 'Commando', 'Rob Hubbard', '1985 Elite'],
    ['hubbard_rob/crazy_comets.sid', 'PSID', 17, 1, 0x5000, 0x610f, 0x6100, 0x500c, 'Crazy Comets', 'Rob Hubbard', '1985 Martech'],
    ['hubbard_rob/knucklebusters.sid', 'PSID', 11, 2, 0x0400, 0x1f8b, 0x1ec0, 0x1ed4, 'Knucklebusters', 'Rob Hubbard', '1986 Melbourne House'],
    ['hubbard_rob/chimera.sid', 'RSID', 4, 1, 0x9f80, 0xcf99, 0x9f80, 0, 'Chimera', 'Rob Hubbard', '1985 Firebird'],
    ['galway_martin/arkanoid.sid', 'RSID', 20, 1, 0x2000, 0x45eb, 0x4000, 0, 'Arkanoid', 'Martin Galway', '1987 Imagine'],
    ['galway_martin/comic_bakery.sid', 'PSID', 14, 1, 0x7f00, 0x9fff, 0x7f00, 0x7f03, 'Comic Bakery', 'Martin Galway', '1986 Imagine'],
    ['galway_martin/ocean_loader_2.sid', 'PSID', 1, 1, 0xa000, 0xacfa, 0xa000, 0xa04e, 'Ocean Loader 2', 'Martin Galway', '1985 Ocean'],
    ['daglish_ben/krakout.sid', 'PSID', 22, 1, 0xe000, 0xf77f, 0xf720, 0xe001, 'Krakout', 'Ben Daglish', '1987 Gremlin Graphics'],
    ['daglish_ben/last_ninja.sid', 'PSID', 11, 3, 0x2000, 0xaaa2, 0x2003, 0x2000, 'The Last Ninja', 'Ben Daglish & Anthony Lees', '1987 System 3'],
    ['huelsbeck_chris/great_giana_sisters.sid', 'RSID', 23, 1, 0x71e3, 0xccf9, 0xcc86, 0, 'The Great Giana Sisters', 'Chris Hülsbeck', '1987 Time Warp'],
    ['huelsbeck_chris/r_type.sid', 'PSID', 14, 1, 0x3194, 0xcfef, 0x3194, 0x6370, 'R-Type', 'Chris Hülsbeck & Ramiro Vaca', '1988 Activision'],
    ['joseph_richard/defender_of_the_crown.sid', 'PSID', 10, 1, 0x804c, 0xaa99, 0xa9b7, 0xa900, 'Defender of the Crown', 'Richard Joseph', '1987 Cinemaware'],
    ['tel_jeroen/golden_axe.sid', 'PSID', 23, 1, 0x1000, 0x46f5, 0x10e8, 0x1074, 'Golden Axe', 'Jeroen Tel', '1990 Probe Software/Virgin'],
    ['tel_jeroen/robocop_3.sid', 'PSID', 20, 1, 0x1fc0, 0x489f, 0x1fc3, 0x1fc0, 'RoboCop 3', 'Jeroen Tel', '1992 Ocean'],
  ];

  it.each(table.map((row) => ({ row, name: row[0] })))('$name', ({ row }) => {
    const [name, type, songs, start, load, last, init, play, title, author, released] = row;
    const bytes = fixture(name);
    expect(looksLikePsid(bytes)).toBe(true);
    const f = parsed(bytes);
    expect(f.type).toBe(type);
    expect(f.version).toBe(2);
    expect(f.songs).toBe(songs);
    expect(f.startSong).toBe(start);
    expect(f.loadAddress).toBe(load);
    expect(f.loadAddress + f.data.length - 1).toBe(last);
    expect(f.initAddress).toBe(init);
    expect(f.playAddress).toBe(play);
    // Latin-1 text: Hülsbeck's ü is one byte, $FC.
    expect([f.name, f.author, f.released]).toEqual([title, author, released]);
    expect(f.extraSids).toEqual([]);
  });

  it('reads the clock and chip model flags', () => {
    expect([parsed(fixture('hubbard_rob/commando.sid')).clock, parsed(fixture('hubbard_rob/commando.sid')).sidModel]).toEqual(['pal', '6581']);
    expect([parsed(fixture('chiptunesak/vibratotest.sid')).clock, parsed(fixture('chiptunesak/vibratotest.sid')).sidModel]).toEqual(['ntsc', '6581']);
    expect([parsed(fixture('tel_jeroen/golden_axe.sid')).clock, parsed(fixture('tel_jeroen/golden_axe.sid')).sidModel]).toEqual(['unknown', '8580']);
    expect([parsed(fixture('tel_jeroen/robocop_3.sid')).clock, parsed(fixture('tel_jeroen/robocop_3.sid')).sidModel]).toEqual(['pal', '8580']);
  });

  it('reads the speed word: every Defender of the Crown subsong is CIA-timed, no Commando one is', () => {
    const defender = parsed(fixture('joseph_richard/defender_of_the_crown.sid'));
    expect(defender.speed).toBe(0x3ff);
    for (let s = 1; s <= defender.songs; s++) expect(psidSongUsesCia(defender, s)).toBe(true);
    const commando = parsed(fixture('hubbard_rob/commando.sid'));
    for (let s = 1; s <= commando.songs; s++) expect(psidSongUsesCia(commando, s)).toBe(false);
  });
});

describe('parsePsid: the header rules', () => {
  it('knows the magic: PSID and RSID, nothing else', () => {
    expect(looksLikePsid(sidFile({}, [0x60]))).toBe(true);
    expect(looksLikePsid(sidFile({ magic: 'RSID', play: 0 }, [0x60]))).toBe(true);
    expect(looksLikePsid(new TextEncoder().encode('GTS5'))).toBe(false);
    expect(looksLikePsid(new Uint8Array([0x50, 0x53]))).toBe(false);
    expect(refusal(new TextEncoder().encode('GTS5 and more'))).toMatch(/not a SID file/);
  });

  it('a version 1 file: data at $76, no flags', () => {
    const f = parsed(sidFile({ version: 1 }, [0x60, 0x60, 0x60, 0x60]));
    expect(f.version).toBe(1);
    expect(f.flags).toBe(0);
    expect(f.clock).toBe('unknown');
    expect(f.data).toEqual(new Uint8Array([0x60, 0x60, 0x60, 0x60]));
  });

  it('a load address of 0 is the data\'s first two bytes, little-endian; an init address of 0 is the load address', () => {
    const f = parsed(sidFile({ load: 0, init: 0 }, [0x00, 0xc0, 0xa9, 0x00, 0x60]));
    expect(f.loadAddress).toBe(0xc000);
    expect(f.initAddress).toBe(0xc000);
    expect(f.data).toEqual(new Uint8Array([0xa9, 0x00, 0x60]));
  });

  it('a start song of 0, or past the last, is song 1', () => {
    expect(parsed(sidFile({ songs: 3, start: 0 }, [0x60])).startSong).toBe(1);
    expect(parsed(sidFile({ songs: 3, start: 4 }, [0x60])).startSong).toBe(1);
    expect(parsed(sidFile({ songs: 3, start: 3 }, [0x60])).startSong).toBe(3);
  });

  it('refuses what the format does not allow, saying why', () => {
    expect(refusal(sidFile({ version: 5 }, [0x60]))).toMatch(/version 5/);
    expect(refusal(sidFile({ dataOffset: 0x80 }, [0x60]))).toMatch(/data starts at \$0080/);
    expect(refusal(sidFile({ songs: 0 }, [0x60]))).toMatch(/0 songs/);
    expect(refusal(sidFile({ songs: 257 }, [0x60]))).toMatch(/257 songs/);
    expect(refusal(sidFile({ load: 0xfffe }, [0x60, 0x60, 0x60]))).toMatch(/run past the end/);
    expect(refusal(sidFile({ magic: 'RSID', version: 1 }, [0x60]))).toMatch(/RSID file of version 1/);
    expect(refusal(sidFile({}, []))).toMatch(/no C64 data/);
    expect(refusal(sidFile({}, []).subarray(0, 0x40))).toMatch(/shorter than a SID header/);
  });

  it('refuses a Compute! Sidplayer (MUS) PSID and an RSID that is a BASIC program: there is nothing it could run', () => {
    expect(refusal(sidFile({ flags: 0x15 }, [0x60]))).toMatch(/Sidplayer \(MUS\)/);
    expect(refusal(sidFile({ magic: 'RSID', play: 0, flags: 0x16 }, [0x60]))).toMatch(/BASIC/);
    // The same bit on a PSID means PlaySID-specific samples: it parses.
    const playSid = parsed(sidFile({ flags: 0x16 }, [0x60]));
    expect(psidIsPlaySidSpecific(playSid)).toBe(true);
    expect(psidIsPlaySidSpecific(parsed(sidFile({}, [0x60])))).toBe(false);
  });

  it('names a second and third SID (v3/v4): $42-$7F and $E0-$FE, even, as $Dxx0', () => {
    expect(parsed(sidFile({ version: 3, second: 0x42 }, [0x60])).extraSids).toEqual([0xd420]);
    expect(parsed(sidFile({ version: 3, second: 0xe0 }, [0x60])).extraSids).toEqual([0xde00]);
    expect(parsed(sidFile({ version: 3, second: 0x43 }, [0x60])).extraSids).toEqual([]);
    expect(parsed(sidFile({ version: 3, second: 0x80 }, [0x60])).extraSids).toEqual([]);
    // A third only in v4, and only beside a second.
    expect(parsed(sidFile({ version: 3, second: 0x50, third: 0x60 }, [0x60])).extraSids).toEqual([0xd500]);
    expect(parsed(sidFile({ version: 4, second: 0x50, third: 0x60 }, [0x60])).extraSids).toEqual([0xd500, 0xd600]);
    expect(parsed(sidFile({ version: 4, second: 0x50, third: 0x50 }, [0x60])).extraSids).toEqual([0xd500]);
    // v2 has no second SID byte to read.
    expect(parsed(sidFile({ version: 2, second: 0x42 }, [0x60])).extraSids).toEqual([]);
  });

  it('a speed bit per song; songs past 32 share bit 31; an RSID times itself', () => {
    const f = parsed(sidFile({ songs: 40, speed: 0x80000002 }, [0x60]));
    expect(psidSongUsesCia(f, 1)).toBe(false);
    expect(psidSongUsesCia(f, 2)).toBe(true);
    expect(psidSongUsesCia(f, 31)).toBe(false);
    expect(psidSongUsesCia(f, 32)).toBe(true);
    expect(psidSongUsesCia(f, 40)).toBe(true);
    expect(psidSongUsesCia(parsed(sidFile({ magic: 'RSID', play: 0, speed: 0xffffffff }, [0x60])), 1)).toBe(false);
  });
});
