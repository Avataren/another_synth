import { PAL_FRAME_CIA } from './gt-psid';

/**
 * The plain C64 program (plan-sid-authoring.md phase 5, D4): what a `.prg`
 * holds in front of GoatTracker's player and the song. You LOAD it and RUN it.
 *
 *   $0801  BASIC line `10 SYS 2061`
 *   $080D  the shell (below), then its screen text
 *   ....   zeros up to the player
 *   $1000  player + song (`gt-pack.ts`), the same bytes as the `.sid`; below $D000
 *
 * The shell banks BASIC's ROM out (`$01 = $36`: the song may lie under it,
 * $A000-$BFFF; the KERNAL and I/O stay), writes the text screen straight
 * into screen and colour RAM (lower/upper case set, case switch locked),
 * points the KERNAL's IRQ vector ($0314) at its handler and starts the song:
 *  - at 1x a raster interrupt, once per frame, with CIA 1's interrupts off;
 *  - at a speed of N a CIA 1 timer A interrupt every $4CC7 / N cycles, the
 *    latch GoatTracker's `.sid` sets at the same speed (`gt-psid.ts`).
 * The handler calls play and leaves through the KERNAL's own handler
 * ($EA31: keyboard scan, CIA acknowledge) once per frame, otherwise
 * straight out ($EA81). The main loop reads keys (GETIN); `1`-`9` start that
 * subsong: interrupts off, SID silenced, the player's code and variables
 * copied back as they were loaded, init with the subsong in A.
 *
 * The copy is there because GoatTracker's init resets only part of the
 * player's state (sequencer, filter step); the rest (frequencies, pulse,
 * filter type and cutoff, self-modified operands) is left from the subsong
 * before. A SID player reloads the whole `.sid` for another subsong, so
 * every subsong of the `.prg` starts from the loaded player, as there. The
 * shell copies the player's pages (up to the song data, which is never
 * written) to `backupAddress` once at start, and back on every subsong start.
 * Zero page: the shell uses none; the player its two bytes ($FC/$FD by default).
 */

export const PRG_LOAD_ADDRESS = 0x0801;
/** Where `SYS 2061` lands: right after the BASIC line. */
export const PRG_SHELL_ADDRESS = 0x080d;
/** The raster line the 1x interrupt fires on (any line works once per frame). */
export const PRG_RASTER_LINE = 0x80;
/** The keys pick subsongs 1-9. */
export const PRG_MAX_KEYED_SUBSONGS = 9;

/** KERNAL entry points the shell uses. */
const KERNAL_GETIN = 0xffe4;
const KERNAL_IRQ = 0xea31;
const KERNAL_IRQ_EXIT = 0xea81;

export interface PrgShell {
  /** The player's `.ORG`: init there, play 3 bytes on. */
  readonly playerAddress: number;
  /**
   * Bytes from the player's address to its song data: its code and
   * variables, which play changes (the song data it only reads).
   */
  readonly playerLength: number;
  /** A page-aligned address in free RAM for a copy of those bytes' pages. */
  readonly backupAddress: number;
  readonly songs: number;
  /** 1..16: play calls per frame. */
  readonly speedMultiplier: number;
  readonly name: string;
  readonly author: string;
  readonly released: string;
}

/** The BASIC line `10 SYS <address>` at $0801, with the end-of-program link. */
export function basicSysStub(address: number): number[] {
  const digits = Array.from(String(address), (c) => c.charCodeAt(0));
  const next = PRG_LOAD_ADDRESS + 2 + 2 + 1 + digits.length + 1;
  // Link to the next line, line number 10, SYS token, the digits, end of line; then a zero link.
  return [next & 0xff, next >> 8, 10, 0, 0x9e, ...digits, 0, 0, 0];
}

/** Letters with their accents stripped: what the C64's character set has. */
function plain(c: string): string {
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * `text` as screen codes of the C64's lower/upper case set, and whether a
 * character had to become `?` (or lost its accent).
 */
export function c64ScreenCodes(text: string): { codes: number[]; altered: boolean } {
  let altered = false;
  const codes = Array.from(text, (ch) => {
    const c = plain(ch);
    if (c !== ch) altered = true;
    const k = c.length === 1 ? c.charCodeAt(0) : -1;
    if (k >= 0x61 && k <= 0x7a) return k - 0x60; // a-z
    if (k >= 0x41 && k <= 0x5a) return k; // A-Z
    if (k >= 0x20 && k <= 0x3f) return k; // space, digits, punctuation
    if (k === 0x40) return 0; // @
    if (k === 0x5b) return 0x1b; // [
    if (k === 0x5d) return 0x1d; // ]
    if (k === 0x5f) return 0x64; // _ (the bottom-line graphic)
    altered = true;
    return 0x3f;
  });
  return { codes, altered };
}

/** A screen line: its text and colour, centred on row `row`. */
interface ScreenLine {
  readonly row: number;
  readonly text: string;
  readonly colour: number;
}

const SCREEN = 0x0400;
const COLOUR_RAM = 0xd800;
const WIDTH = 40;
const WHITE = 1;
const LIGHT_BLUE = 14;
const GREY = 12;
const LIGHT_GREY = 15;
/** Row of "Playing subsong N of M"; the digit is written by `newsong`. */
const STATUS_ROW = 10;

function lines(shell: PrgShell): ScreenLine[] {
  const out: ScreenLine[] = [
    { row: 3, text: shell.name, colour: WHITE },
    { row: 5, text: shell.author, colour: LIGHT_GREY },
    { row: 6, text: shell.released, colour: GREY },
    { row: STATUS_ROW, text: statusText(shell.songs), colour: LIGHT_BLUE },
  ];
  if (shell.songs > 1) {
    const last = Math.min(shell.songs, PRG_MAX_KEYED_SUBSONGS);
    out.push({ row: 12, text: `Press 1-${last} for another subsong`, colour: GREY });
  }
  out.push({ row: 22, text: 'made with another_synth', colour: GREY });
  return out.filter((l) => l.text.trim() !== '');
}

function statusText(songs: number): string {
  return songs > 1 ? `Playing subsong 1 of ${songs}` : 'Playing';
}

/** Whether the screen shows every character of the texts as it is. */
export function prgTextsAltered(shell: PrgShell): boolean {
  return lines(shell).some((l) => c64ScreenCodes(l.text.slice(0, WIDTH)).altered || l.text.length > WIDTH);
}

const hex = (v: number): string => `$${v.toString(16)}`;

/**
 * The shell's source (`asm6502.ts` dialect), from $0801: the BASIC line,
 * the code, the text. Exported labels: `start`, `loop` (the main loop's
 * key poll), `newsong`, `irq`.
 */
export function prgShellSource(shell: PrgShell): string {
  const init = shell.playerAddress;
  const play = shell.playerAddress + 3;
  const mult = shell.speedMultiplier;
  const keyed = Math.min(shell.songs, PRG_MAX_KEYED_SUBSONGS);
  const screen = lines(shell);
  const status = screen.find((l) => l.row === STATUS_ROW)!;
  // "Playing subsong 1 of M": the 1 sits after "Playing subsong ".
  const statusDigit = shell.songs > 1 ? SCREEN + STATUS_ROW * WIDTH + column(status.text) + 16 : undefined;

  const s: string[] = [];
  const o = (line: string): void => {
    s.push(line);
  };
  o(`        .ORG (${hex(PRG_LOAD_ADDRESS)})`);
  o(`        .BYTE (${basicSysStub(PRG_SHELL_ADDRESS).join(',')})`);
  o('start:  sei');
  o('        lda #$36');
  o('        sta <$01');
  o('        lda #$7f');
  o('        sta $dc0d');
  o('        lda $dc0d');
  o('        lda #$00');
  o('        sta $d020');
  o('        sta $d021');
  o('        lda #$17');
  o('        sta $d018');
  o('        lda #$80');
  o('        sta $0291');
  o('        ldx #$00');
  o('clear:  lda #$20');
  for (const page of [0, 0x100, 0x200, 0x2e8]) o(`        sta ${hex(SCREEN + page)},x`);
  o(`        lda #${GREY}`);
  for (const page of [0, 0x100, 0x200, 0x2e8]) o(`        sta ${hex(COLOUR_RAM + page)},x`);
  o('        inx');
  o('        bne clear');
  screen.forEach((l, i) => {
    const text = c64ScreenCodes(l.text.slice(0, WIDTH)).codes;
    const at = l.row * WIDTH + column(l.text);
    o(`        ldx #${text.length - 1}`);
    o(`text${i}l: lda text${i},x`);
    o(`        sta ${hex(SCREEN + at)},x`);
    o(`        lda #${l.colour}`);
    o(`        sta ${hex(COLOUR_RAM + at)},x`);
    o('        dex');
    o(`        bpl text${i}l`);
  });
  o('        lda #(irq % 256)');
  o('        sta $0314');
  o('        lda #(irq / 256)');
  o('        sta $0315');
  if (mult === 1) {
    o('        lda #$01');
    o('        sta $d01a');
    o(`        lda #${hex(PRG_RASTER_LINE)}`);
    o('        sta $d012');
    o('        lda $d011');
    o('        and #$7f');
    o('        sta $d011');
    o('        lda #$ff');
    o('        sta $d019');
  } else {
    const latch = Math.trunc(PAL_FRAME_CIA / mult);
    o(`        lda #${hex(latch & 0xff)}`);
    o('        sta $dc04');
    o(`        lda #${hex(latch >> 8)}`);
    o('        sta $dc05');
    o('        lda #$81');
    o('        sta $dc0d');
    o('        lda #$11');
    o('        sta $dc0e');
    o(`        lda #${mult}`);
    o('        sta count');
  }
  const pages = Math.ceil(shell.playerLength / 256);
  o(`        lda #${hex(shell.playerAddress >> 8)}`);
  o(`        ldx #${hex(shell.backupAddress >> 8)}`);
  o('        jsr copy');
  o('        lda #$00');
  o('        jsr newsong');
  o(`loop:   jsr ${hex(KERNAL_GETIN)}`);
  o('        beq loop');
  o('        sec');
  o('        sbc #$31');
  o(`        cmp #${keyed}`);
  o('        bcs loop');
  o('        jsr newsong');
  o('        jmp loop');
  // A = subsong. Interrupts stay off while the SID is silenced and the player re-initialized.
  o('newsong: sei');
  o('        pha');
  o('        ldx #$18');
  o('        lda #$00');
  o('silence: sta $d400,x');
  o('        dex');
  o('        bpl silence');
  o(`        lda #${hex(shell.backupAddress >> 8)}`);
  o(`        ldx #${hex(shell.playerAddress >> 8)}`);
  o('        jsr copy');
  o('        pla');
  if (statusDigit !== undefined) {
    o('        pha');
    o('        clc');
    o('        adc #$31');
    o(`        sta ${hex(statusDigit)}`);
    o('        pla');
  }
  o(`        jsr ${hex(init)}`);
  o('        cli');
  o('        rts');
  // Copy `pages` pages from page A to page X.
  o('copy:   sta copyrd+2');
  o('        stx copywr+2');
  o(`        ldx #${pages}`);
  o('        ldy #$00');
  o('copyrd: lda $0000,y');
  o('copywr: sta $0000,y');
  o('        iny');
  o('        bne copyrd');
  o('        inc copyrd+2');
  o('        inc copywr+2');
  o('        dex');
  o('        bne copyrd');
  o('        rts');
  o('irq:');
  if (mult === 1) {
    o('        lda #$01');
    o('        sta $d019');
    o(`        jsr ${hex(play)}`);
    o(`        jmp ${hex(KERNAL_IRQ)}`);
  } else {
    o(`        jsr ${hex(play)}`);
    o('        dec count');
    o('        beq frame');
    o('        lda $dc0d');
    o(`        jmp ${hex(KERNAL_IRQ_EXIT)}`);
    o(`frame:  lda #${mult}`);
    o('        sta count');
    o(`        jmp ${hex(KERNAL_IRQ)}`);
    o('count:  .BYTE (0)');
  }
  screen.forEach((l, i) => {
    o(`text${i}: .BYTE (${c64ScreenCodes(l.text.slice(0, WIDTH)).codes.join(',')})`);
  });
  return s.join('\n') + '\n';
}

/** The column that centres `text` on a 40-column line. */
function column(text: string): number {
  return Math.max(0, Math.floor((WIDTH - Math.min(text.length, WIDTH)) / 2));
}
