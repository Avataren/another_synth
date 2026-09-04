// Recorder for TrackerSongBank.
//
// Extracted verbatim from song-bank.ts (P2, D95): captures stereo audio from
// the bank's master bus via a recording AudioWorklet and returns interleaved
// samples on stop. Read-side only -- recording never touches voice state.

import type AudioSystem from 'src/audio/AudioSystem';

export class SongBankRecorder {
  private recorderNode: AudioWorkletNode | null = null;
  private recordedBuffers: Float32Array[] = [];
  private recording = false;

  constructor(
    private readonly audioSystem: AudioSystem,
    /**
     * Where capture taps. The post-fx rack output (what-you-hear) rather
     * than the pre-rack master bus, so recordings and Export MP3 include the
     * post-fx chain -- see D117.
     */
    private readonly tapNode: AudioNode,
  ) {}

  /** Start capturing stereo audio from the master bus */
  async startRecording(): Promise<void> {
    await this.ensureRecorderNode();
    this.recordedBuffers = [];
    this.recording = true;
  }

  /** Stop capture and return interleaved Float32 data */
  async stopRecording(): Promise<{
    interleaved: Float32Array;
    sampleRate: number;
  }> {
    this.recording = false;
    const totalFrames = this.recordedBuffers.reduce(
      (sum, buf) => sum + buf.length,
      0,
    );
    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const buf of this.recordedBuffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    return {
      interleaved: merged,
      sampleRate: this.audioSystem.audioContext.sampleRate,
    };
  }

  dispose(): void {
    this.recorderNode?.disconnect();
    this.recorderNode = null;
  }

  private async ensureRecorderNode(): Promise<void> {
    if (this.recorderNode) return;
    await this.audioSystem.audioContext.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}worklets/recording-worklet.js`,
    );
    this.recorderNode = new AudioWorkletNode(
      this.audioSystem.audioContext,
      'recording-processor',
      { numberOfInputs: 1, numberOfOutputs: 0 },
    );
    this.tapNode.connect(this.recorderNode);
    this.recorderNode.port.onmessage = (event: MessageEvent) => {
      if (!this.recording) return;
      const data = event.data as Float32Array | undefined;
      if (!data) return;
      // Copy to keep buffers alive after transfer
      this.recordedBuffers.push(new Float32Array(data));
    };
  }
}
