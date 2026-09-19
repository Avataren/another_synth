/**
 * Native Web MIDI input (no dependency): note on / note off from every input
 * port, with hot-plug.
 *
 * The legacy editors reach MIDI through the `webmidi` package
 * (`keyboard-store.ts`), which enables sysex, takes over every port once and
 * is not told when a device comes or goes. This is the small part an
 * instrument editor needs, on `navigator.requestMIDIAccess` itself: it
 * listens to the ports that exist, follows `statechange`, and reports what it
 * is doing so a page can show it.
 */

/** What the input is doing, for a status chip. */
export type MidiInputState =
  /** Not started. */
  | 'idle'
  /** The browser has no Web MIDI. */
  | 'unsupported'
  /** Waiting for the permission prompt. */
  | 'requesting'
  /** The user (or the browser's policy) refused. */
  | 'denied'
  /** Listening; see `devices` for what is plugged in. */
  | 'ready';

export interface MidiInputStatus {
  state: MidiInputState;
  /** Names of the connected input ports. */
  devices: string[];
}

export interface MidiInputHandlers {
  noteOn(midi: number, velocity: number): void;
  noteOff(midi: number): void;
  /** Let go of every MIDI-held note: a controller's CC 123 / 120, or a device that went away. */
  allNotesOff?(): void;
  onStatus?(status: MidiInputStatus): void;
}

/** The slice of the Web MIDI API this uses, so a test can stand in for it. */
export interface MidiPortLike {
  id: string;
  name?: string | null;
  type?: string;
  state?: string;
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null;
}
export interface MidiAccessLike {
  inputs: { forEach(callback: (port: MidiPortLike) => void): void };
  onstatechange: ((event: unknown) => void) | null;
}
export type RequestMidiAccess = () => Promise<MidiAccessLike>;

/** The browser's `requestMIDIAccess`, or `undefined` where there is none. */
export function nativeRequestMidiAccess(): RequestMidiAccess | undefined {
  if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
    return undefined;
  }
  // No sysex: it would put up a scarier prompt for nothing an editor uses.
  return () => navigator.requestMIDIAccess() as unknown as Promise<MidiAccessLike>;
}

/**
 * Decode one MIDI message into what an instrument does with it. A note-on with
 * velocity 0 is a note-off; every channel is taken.
 */
export type MidiMessage =
  | { kind: 'on'; midi: number; velocity: number }
  | { kind: 'off'; midi: number }
  | { kind: 'allOff' };

export function decodeMidiMessage(data: ArrayLike<number> | null | undefined): MidiMessage | null {
  if (!data || data.length < 2) return null;
  const status = data[0]! & 0xf0;
  const a = data[1]! & 0x7f;
  const b = (data[2] ?? 0) & 0x7f;
  if (status === 0x90) return b > 0 ? { kind: 'on', midi: a, velocity: b } : { kind: 'off', midi: a };
  if (status === 0x80) return { kind: 'off', midi: a };
  // Controller 120 (all sound off) and 123 (all notes off).
  if (status === 0xb0 && (a === 123 || a === 120)) return { kind: 'allOff' };
  return null;
}

export class MidiInput {
  private access: MidiAccessLike | null = null;
  private attached = new Set<MidiPortLike>();
  private status: MidiInputStatus = { state: 'idle', devices: [] };
  private generation = 0;

  constructor(
    private readonly handlers: MidiInputHandlers,
    private readonly request: RequestMidiAccess | undefined = nativeRequestMidiAccess(),
  ) {}

  get current(): MidiInputStatus {
    return this.status;
  }

  /**
   * Ask for access and start listening. Safe to call again (a denial is
   * retried, which is how "try again" works). Never throws: a refusal or a
   * failure is a state.
   */
  async start(): Promise<void> {
    if (this.access) return;
    if (!this.request) {
      this.setStatus('unsupported', []);
      return;
    }
    const generation = ++this.generation;
    this.setStatus('requesting', []);
    let access: MidiAccessLike;
    try {
      access = await this.request();
    } catch {
      if (generation === this.generation) this.setStatus('denied', []);
      return;
    }
    // Stopped (or superseded) while the prompt was up.
    if (generation !== this.generation) return;
    this.access = access;
    access.onstatechange = () => this.sync();
    this.sync();
  }

  /** Stop listening and let go of the ports. */
  stop(): void {
    this.generation++;
    this.detachAll();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.setStatus('idle', []);
  }

  /** Attach to the inputs that are connected now, detach from the ones that are gone. */
  private sync(): void {
    const access = this.access;
    if (!access) return;
    const live = new Set<MidiPortLike>();
    const names: string[] = [];
    access.inputs.forEach((port) => {
      if (port.state === 'disconnected') return;
      live.add(port);
      names.push(port.name || port.id);
    });
    let lost = false;
    for (const port of [...this.attached]) {
      if (live.has(port)) continue;
      this.detach(port);
      lost = true;
    }
    // A device pulled out with a key down never sends its note-off.
    if (lost) this.handlers.allNotesOff?.();
    for (const port of live) {
      if (this.attached.has(port)) continue;
      port.onmidimessage = (event) => this.handle(event.data);
      this.attached.add(port);
    }
    this.setStatus('ready', names);
  }

  private handle(data: Uint8Array | null): void {
    const message = decodeMidiMessage(data);
    if (!message) return;
    if (message.kind === 'on') this.handlers.noteOn(message.midi, message.velocity);
    else if (message.kind === 'off') this.handlers.noteOff(message.midi);
    else this.handlers.allNotesOff?.();
  }

  private detach(port: MidiPortLike): void {
    port.onmidimessage = null;
    this.attached.delete(port);
  }

  private detachAll(): void {
    for (const port of [...this.attached]) this.detach(port);
  }

  private setStatus(state: MidiInputState, devices: string[]): void {
    this.status = { state, devices };
    this.handlers.onStatus?.(this.status);
  }
}
