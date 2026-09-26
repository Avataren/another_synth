import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importPsid } from 'src/audio/tracker/psid';
import type { PsidWorkerReply, PsidWorkerRequest } from 'src/audio/tracker/psid/psid-import-worker';
import { importPsidToTrackerSong, importPsidToTrackerSongAsync, psidImportSummaryOf } from 'src/audio/tracker/psid-import';

/**
 * plan-psid-import.md: the app imports a `.sid` in a worker (seconds for a
 * big tune would freeze the page). The worker's protocol, and the main
 * thread's side of it: the same song as an import done in place, and an
 * import done in place when there is no worker or it fails.
 */

const bytes = new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/psid/galway_martin/ocean_loader_2.sid')));
const buffer = (): ArrayBuffer => bytes.slice().buffer;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the SID import worker', () => {
  it('answers a request with the import, without the register captures', async () => {
    const posted: PsidWorkerReply[] = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((m: PsidWorkerReply) => posted.push(m)) as typeof window.postMessage);
    await import('src/audio/tracker/psid/psid-import-worker');
    const request: PsidWorkerRequest = { id: 7, bytes: buffer() };
    (self as unknown as { onmessage: (e: { data: PsidWorkerRequest }) => void }).onmessage({ data: request });
    expect(posted.length).toBe(1);
    const reply = posted[0]!;
    expect(reply.id).toBe(7);
    if (!reply.result.ok) throw new Error(reply.result.reason);
    expect(reply.result.reports.every((r) => r.trace === undefined)).toBe(true);
    const inPlace = importPsid(bytes);
    if (!inPlace.ok) throw new Error(inPlace.reason);
    expect(reply.result.doc).toEqual(inPlace.doc);
    expect(reply.result.fidelity).toEqual(inPlace.fidelity);
  }, 60_000);
});

describe('importPsidToTrackerSongAsync', () => {
  it('without a worker (this test runner has none): the same song as the import in place, its summary attached', async () => {
    expect(typeof Worker).toBe('undefined');
    const a = await importPsidToTrackerSongAsync(buffer(), 'Ocean_Loader_2.sid');
    const b = importPsidToTrackerSong(buffer(), 'Ocean_Loader_2.sid');
    expect(a.song).toEqual(b.song);
    expect(psidImportSummaryOf(a.song)).toBe(a.summary);
    expect(a.summary).toMatch(/^Ocean Loader 2 by Martin Galway: transcribed from its own C64 player/);
  }, 60_000);

  it('through a worker: the request carries the bytes, the reply becomes the song', async () => {
    const { withoutTraces } = await import('src/audio/tracker/psid/psid-import-worker');
    const requests: PsidWorkerRequest[] = [];
    class AnsweringWorker {
      onmessage: ((e: { data: PsidWorkerReply }) => void) | null = null;
      onerror: ((e: { message: string }) => void) | null = null;
      postMessage(request: PsidWorkerRequest): void {
        requests.push(request);
        const result = withoutTraces(importPsid(new Uint8Array(request.bytes)));
        setTimeout(() => this.onmessage?.({ data: { id: request.id, result } }), 0);
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', AnsweringWorker);
    const song = await importPsidToTrackerSongAsync(buffer(), 'Ocean_Loader_2.sid');
    expect(requests.length).toBe(1);
    expect(new Uint8Array(requests[0]!.bytes)).toEqual(bytes);
    expect(song.song).toEqual(importPsidToTrackerSong(buffer(), 'Ocean_Loader_2.sid').song);
  }, 60_000);

  it('a worker that fails: the import is done in place; bytes that are no SID file are refused with the reason', async () => {
    class FailingWorker {
      onmessage: ((e: { data: PsidWorkerReply }) => void) | null = null;
      onerror: ((e: { message: string }) => void) | null = null;
      postMessage(): void {
        setTimeout(() => this.onerror?.({ message: 'failed to load' }), 0);
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FailingWorker);
    const song = await importPsidToTrackerSongAsync(buffer(), 'Ocean_Loader_2.sid');
    expect(song.song.data.currentSong.title).toBe('Ocean Loader 2');
    await expect(importPsidToTrackerSongAsync(new TextEncoder().encode('PSID but short').slice().buffer)).rejects.toThrow(
      /^Cannot import this SID file: the file is 14 bytes, shorter than a SID header\.$/,
    );
  }, 60_000);
});
