class RecordingProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const left = input[0] || new Float32Array(128);
    const right = input[1] || left;
    const frameCount = left.length;
    const interleaved = new Float32Array(frameCount * 2);

    for (let i = 0; i < frameCount; i++) {
      interleaved[i * 2] = left[i] ?? 0;
      interleaved[i * 2 + 1] = right[i] ?? 0;
    }

    this.port.postMessage(interleaved, [interleaved.buffer]);
    return true;
  }
}

registerProcessor('recording-processor', RecordingProcessor);
