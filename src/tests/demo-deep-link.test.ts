import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDemoLink,
  readDemoLinkParam,
  findDemoSongByFile,
} from 'src/composables/demo-deep-link';
import { copyTextToClipboard } from 'src/composables/clipboard';
import type { DemoCollection } from 'src/composables/useDemoManifest';

/**
 * Demo deep links: the URL a right-clicked demo song copies, and the lookup
 * that turns a link's path back into a manifest entry. The `file` path is
 * the identity under test — it must survive manifest regeneration, which
 * titles and index positions do not.
 */

const collections: DemoCollection[] = [
  {
    id: 'amiga',
    name: 'Amiga',
    songs: [
      {
        file: 'amiga/12TH.MOD',
        title: '12Th Warrior',
        format: 'MOD',
        channels: 4,
        bytes: 143039,
      },
    ],
  },
  {
    id: 's3m',
    name: 'S3M',
    songs: [
      {
        file: 's3m/2nd_reality.s3m',
        title: '2nd Reality',
        format: 'S3M',
        channels: 16,
        bytes: 1000,
      },
    ],
  },
];

describe('buildDemoLink', () => {
  it('points at the tracker route on the given origin and base', () => {
    const link = buildDemoLink('amiga/12TH.MOD', {
      origin: 'https://another-synth.example',
      base: '/synth/',
    });
    expect(link).toBe(
      'https://another-synth.example/synth/tracker?demo=amiga%2F12TH.MOD',
    );
  });

  it('adds a trailing slash to a bare base', () => {
    const link = buildDemoLink('s3m/2nd_reality.s3m', {
      origin: 'https://x.example',
      base: '/synth',
    });
    expect(link).toBe('https://x.example/synth/tracker?demo=s3m%2F2nd_reality.s3m');
  });

  it('encodes characters a query string cannot carry raw', () => {
    const link = buildDemoLink('amiga/a & b.mod', {
      origin: 'https://x.example',
      base: '/',
    });
    expect(link).toBe('https://x.example/tracker?demo=amiga%2Fa+%26+b.mod');
    expect(readDemoLinkParam(link.slice(link.indexOf('?')))).toBe(
      'amiga/a & b.mod',
    );
  });
});

describe('readDemoLinkParam', () => {
  it('reads the demo path out of a query string', () => {
    expect(readDemoLinkParam('?demo=amiga/12TH.MOD')).toBe('amiga/12TH.MOD');
  });

  it('is null when the parameter is missing or empty', () => {
    expect(readDemoLinkParam('?other=1')).toBeNull();
    expect(readDemoLinkParam('?demo=')).toBeNull();
  });
});

describe('findDemoSongByFile', () => {
  it('finds a song in any collection by its manifest path', () => {
    expect(findDemoSongByFile(collections, 's3m/2nd_reality.s3m')?.title).toBe(
      '2nd Reality',
    );
  });

  it('is null for an unknown or removed song, rather than throwing', () => {
    expect(findDemoSongByFile(collections, 'amiga/gone.mod')).toBeNull();
    expect(findDemoSongByFile([], 'amiga/12TH.MOD')).toBeNull();
  });
});

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).clipboard;
  });

  it('prefers the async Clipboard API and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when the Clipboard API fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec as unknown as typeof document.execCommand;
    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('is false when nothing works', async () => {
    const exec = vi.fn().mockReturnValue(false);
    document.execCommand = exec as unknown as typeof document.execCommand;
    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });
});
