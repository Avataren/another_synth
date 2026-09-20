import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  hasSongFileExtension,
  useTrackerFileIO,
  type TrackerFileIOContext,
} from 'src/composables/useTrackerFileIO';
import { handleSongDragOver, handleSongDrop } from 'src/composables/song-drop';
import { clearLoadedSongHash, getLoadedSongHash } from 'src/composables/song-identity';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';

const DEMOS = path.resolve(__dirname, '../../public/demos');

/** A `File` that reads back the given bytes (jsdom's has no `arrayBuffer`). */
function fileOf(name: string, bytes: Uint8Array): File {
  const copy = bytes.slice().buffer;
  return { name, arrayBuffer: async () => copy } as unknown as File;
}

function makeContext(moduleFormat: string) {
  const notify = vi.fn();
  const serializeSong = vi.fn(() => ({ version: '3', data: {} }));
  const trackerStore = {
    moduleFormat,
    serializeSong,
    loadSongFile: vi.fn(),
    instrumentSlots: [],
    linearFrequency: false,
    amigaLimits: false,
  };
  const ctx: TrackerFileIOContext = {
    trackerStore: trackerStore as unknown as TrackerFileIOContext['trackerStore'],
    songBank: {
      audioContext: { state: 'running', resume: async () => {} },
      resetForNewSong: vi.fn(),
      setModuleFormat: vi.fn(),
    } as unknown as TrackerSongBank,
    currentSong: ref({ title: 'Some Song', author: '', bpm: 125 }),
    playbackMode: ref<'pattern' | 'song'>('song'),
    isLoadingSong: ref(false),
    ensureActiveInstrument: vi.fn(),
    syncSongBankFromSlots: vi.fn().mockResolvedValue(undefined),
    initializePlayback: vi.fn().mockResolvedValue(true),
    stopPlayback: vi.fn(),
    resetSequenceIndex: vi.fn(),
    notify,
  };
  return { ctx, notify, serializeSong, trackerStore };
}

beforeEach(() => {
  setActivePinia(createPinia());
  clearLoadedSongHash();
  vi.unstubAllGlobals();
});

describe('saving', () => {
  it('refuses an AHX/HVL song with a visible notification and writes nothing', async () => {
    const picker = vi.fn();
    vi.stubGlobal('window', { ...window, showSaveFilePicker: picker });
    // jsdom has no createObjectURL; the download fallback would need it.
    const createUrl = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    const { ctx, notify, serializeSong } = makeContext('ahx');

    await useTrackerFileIO(ctx).handleSaveSongFile();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatch(/AHX\/HVL songs cannot be saved/);
    expect(notify.mock.calls[0]![0]).toMatch(/Use Export to write it as an \.ahx file \(AHX songs only\)\.$/);
    expect(serializeSong).not.toHaveBeenCalled();
    expect(picker).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('still saves every other format, without a notification', async () => {
    const write = vi.fn();
    const picker = vi.fn(async () => ({
      createWritable: async () => ({ write, close: async () => {} }),
    }));
    vi.stubGlobal('window', { ...window, showSaveFilePicker: picker });
    const { ctx, notify, serializeSong } = makeContext('protracker');

    await useTrackerFileIO(ctx).handleSaveSongFile();

    expect(serializeSong).toHaveBeenCalledOnce();
    expect(picker).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });

  it('falls back to the log when the host gave no notify', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeContext('ahx');
    delete ctx.notify;
    await useTrackerFileIO(ctx).handleSaveSongFile();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/AHX\/HVL songs cannot be saved/));
  });
});

describe('the loaded-song hash', () => {
  const ahx = new Uint8Array(fs.readFileSync(path.join(DEMOS, 'ahx/karma.ahx')));

  it('is recorded once the bytes parse as a song', async () => {
    const { ctx } = makeContext('ahx');
    await useTrackerFileIO(ctx).loadSongFromFile(fileOf('karma.ahx', ahx));
    await vi.waitFor(() => expect(getLoadedSongHash()).toMatch(/^[0-9a-f]{64}$/));
    expect(ctx.initializePlayback).toHaveBeenCalled();
  });

  it('is left alone by a file that is not a song', async () => {
    const { ctx } = makeContext('ahx');
    const io = useTrackerFileIO(ctx);
    await io.loadSongFromFile(fileOf('karma.ahx', ahx));
    await vi.waitFor(() => expect(getLoadedSongHash()).not.toBeNull());
    const before = getLoadedSongHash();

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The first bytes of a PNG: not a zip, MOD, XM, S3M, AHX or JSON.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    await io.loadSongFromFile(fileOf('cover.png', png));
    // Give a (wrongly) fire-and-forget hash time to land.
    await new Promise((r) => setTimeout(r, 50));

    expect(error).toHaveBeenCalled();
    expect(getLoadedSongHash()).toBe(before);
    expect(ctx.isLoadingSong.value).toBe(false);
  });
});

describe('dropping files on the page', () => {
  function dropEvent(files: File[], types: string[] = ['Files']) {
    const preventDefault = vi.fn();
    return {
      event: { dataTransfer: { types, files }, preventDefault } as unknown as DragEvent,
      preventDefault,
    };
  }
  const handlers = () => ({ isBusy: vi.fn(() => false), load: vi.fn(), reject: vi.fn() });
  const song = fileOf('tune.ahx', new Uint8Array([1]));

  it.each(['a.cmod', 'a.JSON', 'a.mod', 'a.xm', 'a.s3m', 'a.AHX', 'a.hvl'])(
    'opens %s',
    (name) => {
      const h = handlers();
      const { event, preventDefault } = dropEvent([fileOf(name, new Uint8Array([1]))]);
      handleSongDrop(event, h);
      expect(h.load).toHaveBeenCalledOnce();
      expect(h.reject).not.toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
    },
  );

  it.each(['cover.png', 'sample.wav', 'notes.txt', 'noextension', 'song.ahx.bak'])(
    'refuses %s without loading it, and still keeps the tab from navigating to it',
    (name) => {
      const h = handlers();
      const { event, preventDefault } = dropEvent([fileOf(name, new Uint8Array([1]))]);
      handleSongDrop(event, h);
      expect(h.load).not.toHaveBeenCalled();
      expect(h.reject).toHaveBeenCalledOnce();
      expect(preventDefault).toHaveBeenCalled();
    },
  );

  it('swallows a drop while a load is under way', () => {
    const h = handlers();
    h.isBusy.mockReturnValue(true);
    handleSongDrop(dropEvent([song]).event, h);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.reject).not.toHaveBeenCalled();
  });

  it('leaves a drop with no file (dragged text) alone', () => {
    const h = handlers();
    const { event, preventDefault } = dropEvent([], ['text/plain']);
    handleSongDrop(event, h);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
  });

  it('dragover allows a drop only for files', () => {
    const files = dropEvent([song]);
    handleSongDragOver(files.event);
    expect(files.preventDefault).toHaveBeenCalled();
    const text = dropEvent([], ['text/plain']);
    handleSongDragOver(text.event);
    expect(text.preventDefault).not.toHaveBeenCalled();
  });

  it('hasSongFileExtension matches the Open picker list', () => {
    expect(hasSongFileExtension('X.HVL')).toBe(true);
    expect(hasSongFileExtension('x.mp3')).toBe(false);
  });
});
