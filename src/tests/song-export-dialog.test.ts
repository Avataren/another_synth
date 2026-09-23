import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const download = vi.hoisted(() => ({ calls: [] as Array<[Uint8Array, string, string]> }));
vi.mock('src/audio/tracker/song-export/download', () => ({
  downloadBytes: (bytes: Uint8Array, name: string, mime: string) => download.calls.push([bytes, name, mime]),
}));

import SongExportDialog from 'src/components/tracker/SongExportDialog.vue';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { parseAhx } from '@another-synth/tracker-playback';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { fittingHvlModel, hvlBytesOf } from './helpers/fitting-hvl';
import {
  ahxExporter,
  exportFileName,
  HVL_MIX_NOTE,
  SONG_EXPORTERS,
  SongExportError,
  type SongExporter,
  type SongExportFormatId,
} from 'src/audio/tracker/song-export';

const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(DEMOS, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const ahxSong = (): TrackerSongFile => importAhxToTrackerSong(demo('karma.ahx'));
const withoutSource = (song: TrackerSongFile): TrackerSongFile => ({ ...song, data: { ...song.data } });

const mounted: VueWrapper[] = [];
function mountDialog(getSong: () => TrackerSongFile, extra: Record<string, unknown> = {}) {
  const wrapper = mount(SongExportDialog, {
    props: { open: true, getSong, ...extra },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const byId = (w: VueWrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const button = (w: VueWrapper, testid: string) => byId(w, testid).element as HTMLButtonElement;

/** A writer that exists, for the rows the real registry does not have. */
const fakeExporter = (over: Partial<SongExporter> = {}): SongExporter => ({
  id: 'flac' as unknown as SongExportFormatId,
  label: 'Fake Format',
  extension: '.fk',
  mimeType: 'application/x-fake',
  description: 'A format made up for this test.',
  available: true,
  check: () => ({ ok: true }),
  serialize: () => new Uint8Array([9, 9, 9]),
  ...over,
});

beforeEach(() => {
  download.calls.length = 0;
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('SongExportDialog: what each row says', () => {
  it('lists the registry in order; for an AHX song AHX is enabled, HVL, mod, xm, s3m are disabled with a visible reason', () => {
    const w = mountDialog(ahxSong);
    expect(w.findAll('[data-testid^="song-export-row-"]').map((row) => row.attributes('data-testid'))).toEqual([
      'song-export-row-ahx',
      'song-export-row-hvl',
      'song-export-row-mod',
      'song-export-row-xm',
      'song-export-row-s3m',
    ]);
    expect(button(w, 'song-export-download-ahx').disabled).toBe(false);
    expect(w.find('[data-testid="song-export-reason-ahx"]').exists()).toBe(false);
    expect(byId(w, 'song-export-reason-hvl').text()).toBe("AHX songs can't be saved as HVL.");
    for (const id of ['hvl', 'mod', 'xm', 's3m']) {
      const btn = button(w, `song-export-download-${id}`);
      expect(btn.disabled, id).toBe(true);
      expect(btn.getAttribute('aria-disabled'), id).toBe('true');
      expect(w.find(`[data-testid="song-export-filename-${id}"]`).exists(), id).toBe(false);
    }
    for (const id of ['mod', 'xm', 's3m']) {
      expect(byId(w, `song-export-reason-${id}`).text(), id).toBe('Not available yet.');
      // A placeholder has nothing to describe: no description line at all.
      expect(w.find(`[data-testid="song-export-description-${id}"]`).exists(), id).toBe(false);
    }
    expect(byId(w, 'song-export-description-ahx').text()).toBe(ahxExporter.description);
  });

  it('says one short plain thing per row: no Author/BPM lecture anywhere in the dialog', () => {
    const w = mountDialog(ahxSong);
    expect(byId(w, 'song-export-description-ahx').text()).toBe(
      'Saves the song as an .ahx file, with your instrument and title changes.',
    );
    expect(byId(w, 'song-export-description-hvl').text()).toBe('Saves the song as an .hvl file, with your pattern, transpose and title changes.');
    expect(w.text()).not.toMatch(/author|bpm|speed multiplier|tempo|no place/i);
  });

  it('enables the HVL row and disables the AHX row for a song with more than 4 tracks, with the reason shown', () => {
    // chiprolled.hvl left the corpus 2026-09-23 (byte-identical dupe);
    // illuminated.hvl is the replacement wide-HVL fixture (also reaches track 6).
    const w = mountDialog(() => importAhxToTrackerSong(demo('illuminated.hvl')));
    expect(button(w, 'song-export-download-hvl').disabled).toBe(false);
    expect(byId(w, 'song-export-filename-hvl').text()).toBe('Saves as: illuminated.hvl');
    expect(button(w, 'song-export-download-ahx').disabled).toBe(true);
    expect(byId(w, 'song-export-reason-ahx').text()).toBe(
      'AHX files have 4 tracks; this song reaches track 6. Export it as HVL instead.',
    );
    expect(w.text()).not.toMatch(/author|bpm|speed multiplier|tempo|no place/i);
  });

  it('enables the AHX row for an HVL song that fits 4 tracks, says the mix is not kept, and downloads an AHX file', async () => {
    const model = fittingHvlModel();
    const w = mountDialog(() => importAhxToTrackerSong(hvlBytesOf(model)));
    expect(button(w, 'song-export-download-ahx').disabled).toBe(false);
    expect(w.find('[data-testid="song-export-reason-ahx"]').exists()).toBe(false);
    expect(button(w, 'song-export-download-hvl').disabled).toBe(false);
    expect(byId(w, 'song-export-warning-ahx').text()).toBe(HVL_MIX_NOTE);
    expect(w.find('[data-testid="song-export-warning-hvl"]').exists()).toBe(false);

    await byId(w, 'song-export-download-ahx').trigger('click');
    expect(download.calls).toHaveLength(1);
    const [bytes, name] = download.calls[0]!;
    expect(name.endsWith('.ahx')).toBe(true);
    expect(byId(w, 'song-export-status').text()).toBe(`Download started: ${name}`);
    const back = parseAhx(bytes);
    expect(back.format).toBe('ahx');
    expect(back.tracks).toEqual(model.tracks);
  });

  it('downloads the HVL file byte for byte for an HVL song', async () => {
    const w = mountDialog(() => importAhxToTrackerSong(demo('illuminated.hvl')));
    await byId(w, 'song-export-download-hvl').trigger('click');
    expect(download.calls).toHaveLength(1);
    expect(download.calls[0]![0]).toEqual(new Uint8Array(demo('illuminated.hvl')));
    expect(download.calls[0]![1]).toBe('illuminated.hvl');
    expect(byId(w, 'song-export-status').text()).toBe('Download started: illuminated.hvl');
  });

  it('is a modal dialog labelled by its heading, with the heading text "Export song file"', () => {
    const w = mountDialog(ahxSong);
    const dialog = w.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    const label = document.getElementById(dialog.attributes('aria-labelledby')!);
    expect(label?.textContent).toBe('Export song file');
  });

  it.each([
    [
      'an XM song',
      () => ({ ...withoutSource(ahxSong()), data: { ...ahxSong().data, moduleFormat: 'xm' as const } }),
      "XM songs can't be saved as AHX.",
    ],
    [
      'an HVL song with more than 4 tracks',
      () => importAhxToTrackerSong(demo('illuminated.hvl')),
      'AHX files have 4 tracks; this song reaches track 6. Export it as HVL instead.',
    ],
    [
      'an AHX song without its source',
      () => withoutSource(ahxSong()),
      'This song has no original file to export from.',
    ],
  ])('disables the AHX row for %s and says why', async (_name, song, reason) => {
    const w = mountDialog(song);
    await flushPromises();
    expect(button(w, 'song-export-download-ahx').disabled).toBe(true);
    expect(byId(w, 'song-export-reason-ahx').text()).toBe(reason);
    expect(w.find('[data-testid="song-export-filename-ahx"]').exists()).toBe(false);
    // Focus starts on the first enabled download, or on Close when none is (only the HVL row is enabled here).
    const enabled = w.find('.song-export-download:not([disabled])');
    expect(document.activeElement).toBe(enabled.exists() ? enabled.element : byId(w, 'song-export-close').element);
    await byId(w, 'song-export-download-ahx').trigger('click');
    expect(download.calls).toEqual([]);
  });

  it('shows the file name each enabled row would save as', () => {
    const song = ahxSong();
    song.data.currentSong.title = 'My  Great: Song!';
    const w = mountDialog(() => song);
    expect(byId(w, 'song-export-filename-ahx').text()).toBe('Saves as: My_Great_Song.ahx');
  });
});

describe('SongExportDialog: downloading', () => {
  it('downloads the exporter output under the sanitized title and says a download started', async () => {
    const song = ahxSong();
    song.data.currentSong.title = 'Some Title';
    const w = mountDialog(() => song);
    const expectedBytes = ahxExporter.serialize(song);
    const shown = byId(w, 'song-export-filename-ahx').text().replace('Saves as: ', '');

    await byId(w, 'song-export-download-ahx').trigger('click');

    expect(download.calls).toHaveLength(1);
    const [bytes, name, mime] = download.calls[0]!;
    expect(bytes).toEqual(expectedBytes);
    expect(name).toBe('Some_Title.ahx');
    expect(name).toBe(shown);
    expect(mime).toBe('application/octet-stream');
    expect(byId(w, 'song-export-status').attributes('role')).toBe('status');
    expect(byId(w, 'song-export-status').text()).toBe('Download started: Some_Title.ahx');
    expect(w.find('[data-testid="song-export-error"]').exists()).toBe(false);
    expect(w.emitted('close')).toBeUndefined();
  });

  it('shows a SongExportError inline, downloads nothing, and stays open', async () => {
    const exporter = fakeExporter({
      serialize: () => {
        throw new SongExportError('cannot write this song: it is too big');
      },
    });
    const w = mountDialog(ahxSong, { exporters: [exporter] });
    await byId(w, 'song-export-download-flac').trigger('click');
    expect(byId(w, 'song-export-error').text()).toBe('cannot write this song: it is too big');
    expect(w.find('[data-testid="song-export-status"]').exists()).toBe(false);
    expect(download.calls).toEqual([]);
    expect(w.find('[data-testid="song-export-dialog"]').exists()).toBe(true);
    expect(w.emitted('close')).toBeUndefined();
  });

  it('also shows an unexpected error, without throwing out of the click', async () => {
    const exporter = fakeExporter({
      serialize: () => {
        throw new TypeError('bad thing');
      },
    });
    const w = mountDialog(ahxSong, { exporters: [exporter] });
    await byId(w, 'song-export-download-flac').trigger('click');
    expect(byId(w, 'song-export-error').text()).toBe('Export failed: bad thing');
    expect(download.calls).toEqual([]);
  });

  it('asks for the song again at click time: a title changed after opening is the file name', async () => {
    let title = 'Before';
    const getSong = vi.fn(() => {
      const song = ahxSong();
      song.data.currentSong.title = title;
      return song;
    });
    const w = mountDialog(getSong);
    expect(getSong).toHaveBeenCalledTimes(1);
    expect(byId(w, 'song-export-filename-ahx').text()).toBe('Saves as: Before.ahx');

    title = 'After';
    await byId(w, 'song-export-download-ahx').trigger('click');

    expect(getSong).toHaveBeenCalledTimes(2);
    expect(download.calls[0]![1]).toBe('After.ahx');
    expect(byId(w, 'song-export-filename-ahx').text()).toBe('Saves as: After.ahx');
  });

  it('refuses at click time when the song became unexportable after opening', async () => {
    let song = ahxSong();
    const w = mountDialog(() => song);
    expect(button(w, 'song-export-download-ahx').disabled).toBe(false);
    song = withoutSource(song);
    await byId(w, 'song-export-download-ahx').trigger('click');
    expect(download.calls).toEqual([]);
    expect(byId(w, 'song-export-error').text()).toBe('This song has no original file to export from.');
    expect(byId(w, 'song-export-reason-ahx').text()).toBe('This song has no original file to export from.');
  });

  it('gives the title-character note only when the title has characters the format cannot hold', async () => {
    const song = ahxSong();
    song.data.currentSong.title = 'Caf\u00e9 Mix';
    const plain = mountDialog(() => song);
    expect(plain.find('[data-testid="song-export-warning-ahx"]').exists()).toBe(false);
    plain.unmount();
    mounted.length = 0;

    song.data.currentSong.title = 'Caf\u00e9 \u20ac Mix';
    const odd = mountDialog(() => song);
    expect(byId(odd, 'song-export-warning-ahx').text()).toBe(
      "Some characters in the title can't be saved and are replaced or removed.",
    );
    // What the note promises is what the file holds.
    await byId(odd, 'song-export-download-ahx').trigger('click');
    expect(download.calls).toHaveLength(1);
  });

  it('renders whatever warnings() returns, verbatim, for any exporter', () => {
    const w = mountDialog(ahxSong, { exporters: [fakeExporter({ warnings: () => ['Line one.', 'Line two.'] })] });
    expect(w.findAll('[data-testid="song-export-warning-flac"]').map((p) => p.text())).toEqual(['Line one.', 'Line two.']);
    const none = mountDialog(ahxSong, { exporters: [fakeExporter()] });
    expect(none.find('[data-testid="song-export-warning-flac"]').exists()).toBe(false);
  });
});

describe('SongExportDialog: the registry is the only thing it knows', () => {
  it('renders and downloads an extra exporter with no component change', async () => {
    const w = mountDialog(ahxSong, { exporters: [...SONG_EXPORTERS, fakeExporter()] });
    expect(w.findAll('[data-testid^="song-export-row-"]')).toHaveLength(6);
    expect(byId(w, 'song-export-row-flac').text()).toContain('Fake Format');
    expect(byId(w, 'song-export-row-flac').text()).toContain('A format made up for this test.');
    await byId(w, 'song-export-download-flac').trigger('click');
    expect(download.calls[0]![0]).toEqual(new Uint8Array([9, 9, 9]));
    expect(download.calls[0]![2]).toBe('application/x-fake');
    expect(download.calls[0]![1]).toBe(exportFileName(ahxSong().data.currentSong.title, '.fk'));
  });

  it('turns a placeholder into an enabled row the moment its writer is available', async () => {
    const [ahx, hvl, mod, ...rest] = SONG_EXPORTERS;
    const written: SongExporter = { ...mod!, available: true, check: () => ({ ok: true }), serialize: () => new Uint8Array([1]) };
    const w = mountDialog(ahxSong, { exporters: [ahx!, hvl!, written, ...rest] });
    expect(button(w, 'song-export-download-mod').disabled).toBe(false);
    expect(w.find('[data-testid="song-export-reason-mod"]').exists()).toBe(false);
    expect(button(w, 'song-export-download-xm').disabled).toBe(true);
    await byId(w, 'song-export-download-mod').trigger('click');
    expect(download.calls[0]![1]).toMatch(/\.mod$/);
  });

  it('uses native controls only: no Quasar element anywhere in it', () => {
    const w = mountDialog(ahxSong);
    const html = w.html();
    expect(html).not.toMatch(/q-(dialog|btn|slider|toggle|card|icon|item)/);
    expect(w.findAll('*').some((el) => el.element.tagName.toLowerCase().startsWith('q-'))).toBe(false);
    for (const el of w.findAll('button')) expect(el.attributes('type')).toBe('button');
    for (const el of w.findAll('button')) expect(el.attributes('data-testid'), el.text()).toBeTruthy();
  });
});

describe('SongExportDialog: closing and focus', () => {
  it('closes on Escape, on the backdrop and on Close, but not on a click inside the dialog', async () => {
    const w = mountDialog(ahxSong);
    await w.get('.song-export-dialog').trigger('click');
    expect(w.emitted('close')).toBeUndefined();

    await byId(w, 'song-export-close').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);

    await byId(w, 'song-export-dialog').trigger('click');
    expect(w.emitted('close')).toHaveLength(2);

    button(w, 'song-export-download-ahx').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(w.emitted('close')).toHaveLength(3);
  });

  it('starts focus on the first enabled download button', async () => {
    const w = mountDialog(ahxSong);
    await flushPromises();
    expect(document.activeElement).toBe(button(w, 'song-export-download-ahx'));
  });

  it('gives focus back to what opened it, and takes nothing when it is closed', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const w = mount(SongExportDialog, { props: { open: false, getSong: ahxSong }, attachTo: document.body });
    mounted.push(w);
    expect(w.find('[data-testid="song-export-dialog"]').exists()).toBe(false);
    expect(document.activeElement).toBe(opener);

    await w.setProps({ open: true });
    await flushPromises();
    expect(document.activeElement).toBe(button(w, 'song-export-download-ahx'));

    await w.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
    expect(w.find('[data-testid="song-export-dialog"]').exists()).toBe(false);
  });

  it('reads the song afresh each time it opens and clears the last result', async () => {
    let title = 'One';
    const getSong = () => {
      const song = ahxSong();
      song.data.currentSong.title = title;
      return song;
    };
    const w = mountDialog(getSong);
    await byId(w, 'song-export-download-ahx').trigger('click');
    expect(w.find('[data-testid="song-export-status"]').exists()).toBe(true);
    await w.setProps({ open: false });
    title = 'Two';
    await w.setProps({ open: true });
    await flushPromises();
    expect(w.find('[data-testid="song-export-status"]').exists()).toBe(false);
    expect(byId(w, 'song-export-filename-ahx').text()).toBe('Saves as: Two.ahx');
  });

  it('keeps Tab inside the dialog and keeps keys from reaching the page underneath', async () => {
    const w = mountDialog(ahxSong);
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    const dl = button(w, 'song-export-download-ahx');
    const close = button(w, 'song-export-close');

    close.focus();
    close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(dl);

    dl.focus();
    dl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(close);

    dl.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener('keydown', heard);
  });
});
