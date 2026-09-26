import { importPsid, type PsidImportResult } from './index';

/**
 * `.sid` import off the main thread (plan-psid-import.md): running a tune on
 * the emulated C64 and transcribing every subsong takes seconds for a big or
 * sample-playing one (Arkanoid's twenty subsongs, Giana's drum samples),
 * which would freeze the page, and the jukebox parses the next song while one
 * plays. One message in, the file's bytes; one out, the import, without the
 * register captures it measured with (large, and nothing reads them after).
 */

export interface PsidWorkerRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
}

export interface PsidWorkerReply {
  readonly id: number;
  readonly result: PsidImportResult;
}

/** `r` without its captures (they stay in the worker). */
export function withoutTraces(r: PsidImportResult): PsidImportResult {
  if (!r.ok) return r;
  return { ...r, reports: r.reports.map(({ trace: _trace, ...rest }) => rest) };
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<PsidWorkerRequest>) => void) | null;
  postMessage(message: PsidWorkerReply): void;
};

scope.onmessage = (e) => {
  const { id, bytes } = e.data;
  let result: PsidImportResult;
  try {
    result = withoutTraces(importPsid(new Uint8Array(bytes)));
  } catch (error) {
    result = { ok: false, reason: `the importer failed (${error instanceof Error ? error.message : String(error)})` };
  }
  scope.postMessage({ id, result });
};
