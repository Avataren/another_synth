/**
 * The Adlib Tracker II song as the app edits it, and the door to the Rust
 * that reads and writes `.a2m` (`rust-wasm/src/opl/a2/write.rs`).
 *
 * The song is a plain JSON model (`A2mSongJson`): `a2m_to_json` parses a file
 * into it and `a2m_from_json` writes one back, so the instrument editor, the
 * pattern grid, the player (which takes the bytes) and the exporter all work
 * on the same song. Patterns cross the boundary sparsely, as the cells that
 * hold something. Nothing here is a `Patch`: an A2M instrument is eleven OPL
 * register bytes and a name.
 *
 * The wasm is initialised on the main thread on first use (the OPL worklet
 * has its own copy). Tests install their own backend.
 */

/** `[row, channel, note, instrument, effect1, param1, effect2, param2]`. */
export type A2mSparseCell = [number, number, number, number, number, number, number, number];

export interface A2mPatternJson {
  rows: number;
  channels: number;
  cells: A2mSparseCell[];
}

export interface A2mInstrumentJson {
  /** CP437 bytes. */
  name: number[];
  /**
   * AM/VIB/EG/KSR/MULT, KSL/TL, AR/DR, SL/RR, WS, each as modulator then
   * carrier, then FB/connection: `a2m-instrument.ts` names the fields.
   */
  fm: number[];
  /** 0 centre, 1 left, 2 right. */
  panning: number;
  finetune: number;
  /** 0 melodic, 1-5 BD, SD, TT, TC, HH. */
  voice_type: number;
}

export interface A2mFmMacroStepJson {
  fm: number[];
  freq_slide: number;
  panning: number;
  duration: number;
}

export interface A2mFmMacroJson {
  length: number;
  loop_begin: number;
  loop_length: number;
  keyoff_pos: number;
  arpeggio_table: number;
  vibrato_table: number;
  /** Trailing default steps are left out. */
  steps: A2mFmMacroStepJson[];
}

export interface A2mArpeggioMacroJson {
  length: number;
  speed: number;
  loop_begin: number;
  loop_length: number;
  keyoff_pos: number;
  data: number[];
}

export interface A2mVibratoMacroJson {
  length: number;
  speed: number;
  delay: number;
  loop_begin: number;
  loop_length: number;
  keyoff_pos: number;
  data: number[];
}

/** The whole song, as `a2m_to_json` makes it and `a2m_from_json` takes it. */
export interface A2mSongJson {
  version: number;
  name: number[];
  composer: number[];
  instruments: A2mInstrumentJson[];
  fm_macros: A2mFmMacroJson[];
  arpeggio_macros: A2mArpeggioMacroJson[];
  vibrato_macros: A2mVibratoMacroJson[];
  /** 128 raw bytes: a pattern number, or 0x80+ for a jump marker. */
  order: number[];
  tempo: number;
  speed: number;
  flags: number;
  pattern_len: number;
  tracks: number;
  macro_speedup: number;
  four_op_tracks: number;
  lock_flags: number[];
  pattern_names: number[][];
  disabled_fm_columns: number[][];
  four_op_instruments: number[];
  rows_per_beat: number | null;
  tempo_finetune: number | null;
  patterns: A2mPatternJson[];
  spare_patterns: A2mPatternJson[];
}

/**
 * What a song file keeps of an A2M song besides its grid: everything but the
 * patterns, which the grid holds (`a2m-grid.ts`).
 */
export type A2mDoc = Omit<A2mSongJson, 'patterns' | 'spare_patterns'>;

/** The wasm functions the codec needs. */
export interface A2mCodecBackend {
  a2m_to_json(bytes: Uint8Array): string;
  a2m_from_json(json: string): Uint8Array;
  a2m_new_json(opl3: boolean): string;
}

let installed: A2mCodecBackend | null = null;
let loading: Promise<A2mCodecBackend> | null = null;

/** Tests: use `backend` instead of loading the app's wasm. `null` goes back to the default. */
export function setA2mCodecBackend(backend: A2mCodecBackend | null): void {
  installed = backend;
  loading = null;
}

async function loadBackend(): Promise<A2mCodecBackend> {
  const glue = (await import('app/public/wasm/audio_processor.js')) as unknown as Partial<A2mCodecBackend> & {
    initSync?: (options: { module: BufferSource }) => unknown;
  };
  if (!glue.initSync || !glue.a2m_to_json || !glue.a2m_from_json || !glue.a2m_new_json) {
    throw new Error('This build of the audio engine cannot read or write Adlib Tracker II modules.');
  }
  const url = `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load the audio engine (${response.status} ${response.statusText})`);
  glue.initSync({ module: new Uint8Array(await response.arrayBuffer()) });
  return {
    a2m_to_json: glue.a2m_to_json,
    a2m_from_json: glue.a2m_from_json,
    a2m_new_json: glue.a2m_new_json,
  };
}

async function backend(): Promise<A2mCodecBackend> {
  if (installed) return installed;
  loading ??= loadBackend().then(
    (b) => (installed = b),
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Load the codec's wasm now, so the synchronous `a2m...Sync` functions below can run. */
export async function ensureA2mCodec(): Promise<void> {
  await backend();
}

function loaded(): A2mCodecBackend {
  if (!installed) throw new Error('The A2M codec is not loaded yet.');
  return installed;
}

/** `a2mBytesFromSong` for after `ensureA2mCodec()`: the export dialog's `serialize` is synchronous. */
export function a2mBytesFromSongSync(song: A2mSongJson): Uint8Array {
  try {
    return loaded().a2m_from_json(JSON.stringify(song));
  } catch (error) {
    throw new Error(`Cannot write this A2M module: ${errorText(error)}`);
  }
}

/** The song in `bytes`. Rejects with the parser's one sentence for a file it refuses. */
export async function a2mSongFromBytes(bytes: Uint8Array): Promise<A2mSongJson> {
  const b = await backend();
  try {
    return JSON.parse(b.a2m_to_json(bytes)) as A2mSongJson;
  } catch (error) {
    throw new Error(`Cannot read this A2M module: ${errorText(error)}`);
  }
}

/** The `.a2m` file for `song`. Rejects with why the song does not fit the format. */
export async function a2mBytesFromSong(song: A2mSongJson): Promise<Uint8Array> {
  const b = await backend();
  try {
    return b.a2m_from_json(JSON.stringify(song));
  } catch (error) {
    throw new Error(`Cannot write this A2M module: ${errorText(error)}`);
  }
}

/** A new empty song: 9 tracks (OPL2) or 18 (OPL3). */
export async function newA2mSong(opl3: boolean): Promise<A2mSongJson> {
  const b = await backend();
  return JSON.parse(b.a2m_new_json(opl3)) as A2mSongJson;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** DOS text (code page 437) as a string. */
export function a2mText(bytes: ReadonlyArray<number>): string {
  return bytes.map((b) => (b < 0x80 ? String.fromCharCode(b) : (CP437_HIGH[b - 0x80] ?? '?'))).join('');
}

/** `text` as code page 437 bytes, at most `max` of them; what it cannot say becomes `?`. */
export function a2mTextBytes(text: string, max: number): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (out.length >= max) break;
    const code = ch.codePointAt(0) ?? 63;
    if (code >= 0x20 && code < 0x7f) out.push(code);
    else {
      const high = CP437_HIGH.indexOf(ch);
      out.push(high >= 0 ? 0x80 + high : 63);
    }
  }
  return out;
}

/** The song's doc: everything but its patterns. */
export function a2mDocOf(song: A2mSongJson): A2mDoc {
  const { patterns: _patterns, spare_patterns: _spare, ...doc } = song;
  void _patterns;
  void _spare;
  return doc;
}
