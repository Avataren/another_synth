import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Vue from 'vue';
import { ref } from 'vue';
import { compile } from '@vue/compiler-dom';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { importGtSong } from 'src/audio/tracker/sid-doc';
import { importGtSongToTrackerSong } from 'src/audio/tracker/sid-import';
import { canEditSlot, instrumentBadgeLabel, isAhxSlot, listsSongInstrument } from 'src/audio/tracker/instrument-types';
import { useTrackerInstruments, type TrackerInstrumentsContext } from 'src/composables/useTrackerInstruments';
import { setMobileLayoutForTest, useMobileLayout } from 'src/composables/useMobileLayout';
import { SLOTS_PER_PAGE, TOTAL_PAGES, useTrackerStore, type InstrumentSlot } from 'src/stores/tracker-store';

/**
 * plan-sid-tracking.md S5.11, "goatracker instruments are not showing up in
 * our tracker". The store had them all along (`showSidDoc`): what broke is
 * the panel. Most GTS5 songs store no instrument names (Mch and Stinsen blank
 * them), and a nameless SID slot rendered as `—` in a row dimmed as `empty`,
 * which is exactly how an unused slot looks, so a song's instruments were
 * indistinguishable from none. An AHX or MOD instrument without a name is
 * listed as "Instrument NN" and never dimmed; a SID one now is too, the way
 * the SID instrument page already titles it.
 *
 * The panel is the page's own markup: the instruments panel is cut out of
 * TrackerPage.vue and compiled, and it renders against the real store, the
 * real instruments composable and the real slot helpers. A full page mount
 * would drag in the audio host for no gain: the rows are the panel's alone.
 */

const DEMOS = resolve(__dirname, '../../public/demos/goattracker');
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(DEMOS, name)));
const bufferOf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

/** Named (GTS!), all unnamed (GTS5), and a mix of the two (GTS5). */
const STREETS = 'aeuk/metal_warrior_4_streets.sng';
const ATTITUDE = 'mch/attitude_14.sng';
const ALIEN_FUNK = 'mch/alien_funk.sng';

/**
 * The instruments a GTS5 file declares, read straight from its bytes rather
 * than through the importer: magic and three 32-byte texts, a subtune count,
 * three orderlists per subtune (a length byte counting all but the restart
 * byte, so length + 1 bytes follow), then the instrument count and its 25-byte
 * records, the name 16 bytes at +9 (GoatTracker readme §6.1.3).
 */
function gts5Instruments(bytes: Uint8Array): string[] {
  expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('GTS5');
  let at = 4 + 3 * 32;
  const subtunes = bytes[at++]!;
  for (let i = 0; i < subtunes * 3; i++) at += 1 + bytes[at]! + 1;
  const count = bytes[at++]!;
  return Array.from({ length: count }, (_, i) => {
    const name = bytes.subarray(at + i * 25 + 9, at + i * 25 + 25);
    const end = name.indexOf(0);
    return String.fromCharCode(...name.subarray(0, end < 0 ? name.length : end));
  });
}

/** The names the song's doc holds, from the same importer the app uses. */
function docNames(name: string): string[] {
  const imported = importGtSong(bytesOf(name));
  if (!imported.ok) throw new Error(imported.reason);
  return imported.doc.instruments.map((ins) => ins.name);
}

/** What the panel must show for instrument `n` (1-based) named `name`: its name, or its number. */
const expectedLabel = (name: string, n: number): string => name.trim() || `Instrument ${formatInstrumentId(n)}`;

function loadIntoStore(name: string) {
  const store = useTrackerStore();
  store.loadSongFile(importGtSongToTrackerSong(bufferOf(bytesOf(name)), name.replace(/^.*\//, '')));
  return store;
}

// ---------------------------------------------------------------------------
// The page's instruments panel, compiled from TrackerPage.vue
// ---------------------------------------------------------------------------

const PAGE = readFileSync(resolve(__dirname, '../pages/TrackerPage.vue'), 'utf8');

/** The `<div>` that opens at the instruments panel's `v-show`, to its matching close. */
function instrumentPanelMarkup(): string {
  const anchor = PAGE.indexOf("mobilePanel === 'instruments'\"");
  expect(anchor).toBeGreaterThan(0);
  const start = PAGE.lastIndexOf('<div', anchor);
  const tags = /<\/?div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(PAGE); m; m = tags.exec(PAGE)) {
    depth += m[0] === '<div' ? 1 : -1;
    if (depth === 0) return PAGE.slice(start, PAGE.indexOf('>', m.index) + 1);
  }
  throw new Error('unbalanced instruments panel');
}

/** A runtime-compiled render function over the page's markup, as Vue's full build makes one. */
function compilePanel() {
  const { code } = compile(instrumentPanelMarkup(), { mode: 'function', hoistStatic: false });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function('Vue', code)(Vue) as ((...args: unknown[]) => unknown) & { _rc?: boolean };
  render._rc = true;
  return render;
}

const stub = (name: string) => Vue.defineComponent({ name, render: () => Vue.h('span', { class: `stub-${name}` }) });

function mountPanel(mobilePanel: 'instruments' | 'song' | null) {
  const render = compilePanel();
  return mount({
    render,
    components: {
      PatchPicker: stub('PatchPicker'),
      AudioKnobComponent: stub('AudioKnobComponent'),
      StereoLevelMeter: stub('StereoLevelMeter'),
      QIcon: stub('QIcon'),
    },
    setup() {
      const trackerStore = useTrackerStore();
      const instruments = useTrackerInstruments({ trackerStore, formatInstrumentId } as unknown as TrackerInstrumentsContext);
      const noop = () => {};
      return {
        // Layout (TrackerPage's own refs).
        isMobileLayout: useMobileLayout(),
        mobilePanel: ref(mobilePanel),
        // The store, as the page reads it.
        trackerStore,
        currentInstrumentPage: Vue.computed(() => trackerStore.currentInstrumentPage),
        currentPageSlots: Vue.computed(() => trackerStore.currentPageSlots),
        activeInstrumentId: Vue.computed(() => trackerStore.activeInstrumentId),
        visibleInstrumentPages: Vue.computed(() => [0, 1, 2, 3, 4]),
        TOTAL_PAGES,
        // The page's real display logic.
        formatInstrumentId,
        isAhxSlot,
        instrumentBadgeLabel,
        canEditSlot,
        listsSongInstrument,
        ...instruments,
        // Page state and handlers the rows only bind (never called here).
        isReadOnly: false,
        readOnlyHint: '',
        hasDocStructure: true,
        isSidSong: Vue.computed(() => trackerStore.isSidSong),
        canAddSidInstrumentAt: () => false,
        canPickSidPresetAt: () => false,
        sidPresetList: [],
        onSidPresetSelect: noop,
        onAddInstrumentClick: noop,
        ahxInstrumentsHint: '',
        masterOutputNode: null,
        audioContext: null,
        isPlaying: false,
        formatGainAsDb: (v: number) => String(v),
        stepInstrumentPage: noop,
        setActiveInstrument: noop,
        refocusTracker: noop,
        blurAndRefocusTracker: noop,
        onSlotVolumeChange: noop,
      };
    },
  });
}

type Row = { label: string; empty: boolean };
function rowsOf(wrapper: ReturnType<typeof mountPanel>): Row[] {
  return wrapper.findAll('.instrument-row').map((row) => ({
    label: row.find('.patch-name').text(),
    empty: row.classes().includes('empty'),
  }));
}

/** Every page of the panel that holds one of the song's `count` instruments, then the first page after them. */
async function allRows(wrapper: ReturnType<typeof mountPanel>, count: number): Promise<Row[]> {
  const store = useTrackerStore();
  const rows: Row[] = [];
  for (let page = 0; page * SLOTS_PER_PAGE < count + SLOTS_PER_PAGE; page++) {
    store.setInstrumentPage(page);
    await Vue.nextTick();
    rows.push(...rowsOf(wrapper));
  }
  return rows;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setActivePinia(createPinia());
  setMobileLayoutForTest(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn');
});
afterEach(() => {
  // A binding the page's markup uses and this harness does not provide shows up as a Vue warning.
  const missing = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('was accessed during render'));
  expect(missing).toEqual([]);
  setMobileLayoutForTest(false);
  vi.restoreAllMocks();
});

describe('the ground truth: what the files declare', () => {
  it(`${ATTITUDE}: 10 instruments, none named, in the file's own bytes and in the doc`, () => {
    const raw = gts5Instruments(bytesOf(ATTITUDE));
    expect(raw).toHaveLength(10);
    expect(raw.every((n) => n === '')).toBe(true);
    expect(docNames(ATTITUDE)).toEqual(raw);
  });

  it(`${ALIEN_FUNK}: 19 instruments, some named, in the bytes and in the doc`, () => {
    const raw = gts5Instruments(bytesOf(ALIEN_FUNK));
    expect(raw).toHaveLength(19);
    expect(raw.filter((n) => n !== '').length).toBeGreaterThan(0);
    expect(raw.filter((n) => n === '').length).toBeGreaterThan(0);
    expect(docNames(ALIEN_FUNK)).toEqual(raw);
  });

  it(`${STREETS}: 16 named instruments`, () => {
    const names = docNames(STREETS);
    expect(names).toHaveLength(16);
    expect(names.every((n) => n.trim() !== '')).toBe(true);
    expect(names[0]).toBe('Saw main');
  });
});

describe('the store after loadSongFile (importGtSongToTrackerSong -> loadSongFile)', () => {
  for (const song of [STREETS, ATTITUDE, ALIEN_FUNK]) {
    it(`${song}: one SID slot per doc instrument, in order, carrying its name`, () => {
      const names = docNames(song);
      const store = loadIntoStore(song);
      expect(store.moduleFormat).toBe('sid');
      names.forEach((name, i) => {
        expect(store.instrumentSlots[i]?.instrumentName).toBe(name);
        expect(store.instrumentSlots[i]?.instrumentFormat).toBe('sid');
      });
      expect(store.instrumentSlots[names.length]?.instrumentFormat).toBeUndefined();
    });
  }
});

describe("the tracker page's instruments panel lists a GoatTracker song's instruments", () => {
  for (const song of [STREETS, ATTITUDE, ALIEN_FUNK]) {
    it(`${song}, desktop: every instrument is listed by name (or number), and none looks empty`, async () => {
      const names = docNames(song);
      loadIntoStore(song);
      const wrapper = mountPanel(null);
      expect(wrapper.find('.instrument-panel').isVisible()).toBe(true);
      const rows = await allRows(wrapper, names.length);
      expect(rows.slice(0, names.length)).toEqual(names.map((name, i) => ({ label: expectedLabel(name, i + 1), empty: false })));
      // The slots past the song's instruments are the unused ones, and look it.
      expect(rows.slice(names.length).every((row) => row.label === '—' && row.empty)).toBe(true);
      expect(rows.length).toBeGreaterThan(names.length);
    });
  }

  it(`${ATTITUDE}, phone: the Instr sheet lists the same rows; closed, it shows nothing`, async () => {
    const names = docNames(ATTITUDE);
    loadIntoStore(ATTITUDE);
    setMobileLayoutForTest(true);
    const closed = mountPanel(null);
    expect(closed.find('.instrument-panel').isVisible()).toBe(false);
    expect(mountPanel('song').find('.instrument-panel').isVisible()).toBe(false);
    const open = mountPanel('instruments');
    expect(open.find('.instrument-panel').isVisible()).toBe(true);
    const rows = await allRows(open, names.length);
    expect(rows.slice(0, names.length)).toEqual(names.map((name, i) => ({ label: expectedLabel(name, i + 1), empty: false })));
    expect(rows[0]).toEqual({ label: 'Instrument 01', empty: false });
  });

  it(`${STREETS}, phone: the named instruments are listed by name`, async () => {
    const names = docNames(STREETS);
    loadIntoStore(STREETS);
    setMobileLayoutForTest(true);
    const rows = await allRows(mountPanel('instruments'), names.length);
    // The rendered text is trimmed: the file pads some names ('Weird ').
    expect(rows.slice(0, names.length).map((r) => r.label)).toEqual(names.map((n) => n.trim()));
    expect(rows.slice(0, names.length).some((r) => r.empty)).toBe(false);
  });
});

describe('the other formats list as before', () => {
  const display = () => useTrackerInstruments({ trackerStore: useTrackerStore(), formatInstrumentId } as unknown as TrackerInstrumentsContext).getInstrumentDisplayName;
  const slot = (extra: Partial<InstrumentSlot>): InstrumentSlot => ({ slot: 3, bankName: '', patchName: '', instrumentName: '', ...extra });

  it('an unused slot is a dash and empty; a patch slot, an AHX, an HVL, a MOD sample and an OPL slot keep their names and fills', () => {
    const name = display();
    expect(name(slot({}))).toBe('—');
    expect(listsSongInstrument(slot({}))).toBe(false);
    // AHX/HVL (both tagged 'ahx'): import names an unnamed instrument (`buildAhxSlots`), and the row is filled without a patch.
    const ahx = slot({ patchName: 'Instrument 03', instrumentName: 'Instrument 03', instrumentType: 'ahx', instrumentFormat: 'ahx' });
    expect(name(ahx)).toBe('Instrument 03');
    expect(listsSongInstrument(ahx)).toBe(true);
    // A MOD sample and a synth patch are filled by their patch; their names are unchanged.
    expect(name(slot({ patchId: 'p', patchName: 'Instrument 07', instrumentType: 'sampler', instrumentFormat: 'protracker' }))).toBe('Instrument 07');
    expect(listsSongInstrument(slot({ patchId: 'p', instrumentType: 'sampler', instrumentFormat: 'protracker' }))).toBe(false);
    expect(name(slot({ patchId: 'p', patchName: 'Lead' }))).toBe('Lead');
    // An OPL instrument has no patch and stays dimmed, as before.
    expect(listsSongInstrument(slot({ instrumentType: 'opl', instrumentFormat: 's3m', oplData: {} as NonNullable<InstrumentSlot['oplData']> }))).toBe(false);
    // A SID slot: its name, else its number.
    expect(name(slot({ instrumentFormat: 'sid', instrumentName: 'Bass' }))).toBe('Bass');
    expect(name(slot({ instrumentFormat: 'sid' }))).toBe('Instrument 03');
  });
});
