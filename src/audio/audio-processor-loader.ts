// src/audio/audio-processor-loader.ts
import { useLayoutStore } from 'src/stores/layout-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import type { LayoutUpdateMessage } from './types/synth-layout';

/**
 * Create the synth worklet node and run the WASM init handshake.
 *
 * The 5 s handshake window is gated on the context actually RUNNING. On a
 * phone the AudioContext is born suspended (autoplay policy: no user gesture
 * yet) and the render thread never runs, so a handshake timer started at node
 * creation would expire before the worklet even gets a chance to post `ready`
 * -- the mobile boot stall. While the context is suspended/interrupted the
 * timer is not started; it starts only when `statechange` reports `running`.
 * A context that is already running behaves exactly as before (5 s from node
 * creation).
 *
 * On any rejection the handshake listeners are removed and the port is
 * closed: the processor's constructor already posted `ready`, and a still-live
 * port would later fetch the WASM and fully initialize a second,
 * never-connected engine graph on the render thread (permanent CPU burn on
 * mobile). Recovery is a fresh `createStandardAudioWorklet` call.
 */
export async function createStandardAudioWorklet(
  audioContext: AudioContext
): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}worklets/synth-worklet.js`
  );

  const workletNode = new AudioWorkletNode(audioContext, 'synth-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2], // Specify stereo output
  });
  const layoutStore = useLayoutStore();
  const nodeStateStore = useNodeStateStore();
  workletNode.port.start();

  return new Promise((resolve, reject) => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Handle messages from the worklet
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (data.type === 'ready') {
        console.log('AudioWorkletProcessor is ready, sending WASM...');
        try {
          const wasmUrl = `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`;
          const response = await fetch(wasmUrl);
          const wasmBytes = await response.arrayBuffer();
          workletNode.port.postMessage(
            { type: 'wasm-binary', wasmBytes },
            [wasmBytes]
          );
          resolveOnce(() => resolve(workletNode));
        } catch (error) {
          rejectAndAbandon(error as Error);
        }
      } else if (data.type === 'synthLayout') {
        console.log('[WASM Message] Received synth layout from WASM');

        const layoutMessage = data as LayoutUpdateMessage;
        layoutStore.updateSynthLayout(layoutMessage.layout);
        nodeStateStore.initializeDefaultStates();
      } else if (data.type === 'stateUpdated') {
        // This is the pushed update from the worklet whenever state changes.
        console.log('[WASM Message] Received automatic state update from WASM');
        layoutStore.updateSynthLayout(data.state);
        nodeStateStore.initializeDefaultStates();
      }
    };
    const handleMessageError = (event: MessageEvent) => {
      rejectAndAbandon(
        event.data instanceof Error
          ? event.data
          : new Error('Message port error while initializing synth worklet')
      );
    };

    const removeHandshakeListeners = () => {
      workletNode.port.removeEventListener('message', handleMessage);
      workletNode.port.removeEventListener(
        'messageerror',
        handleMessageError as EventListener
      );
      audioContext.removeEventListener('statechange', onContextStateChange);
    };

    const resolveOnce = (fn: () => void) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);
      removeHandshakeListeners();
      fn();
    };

    /** Abandon the node on failure: no listeners, no port, no zombie init. */
    const rejectAndAbandon = (error: Error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);
      removeHandshakeListeners();
      try {
        workletNode.port.close();
      } catch {
        // Port may already be closed; nothing to salvage either way.
      }
      try {
        workletNode.disconnect();
      } catch {
        // Not connected yet is the normal case.
      }
      reject(error);
    };

    const startHandshakeTimeout = () => {
      timeoutId = setTimeout(() => {
        rejectAndAbandon(
          new Error('Timeout waiting for synth initialization')
        );
      }, 5000); // 5 second timeout, started only once the context is running
    };

    const onContextStateChange = () => {
      if (resolved) {
        audioContext.removeEventListener('statechange', onContextStateChange);
        return;
      }
      if (audioContext.state === 'running') {
        audioContext.removeEventListener('statechange', onContextStateChange);
        startHandshakeTimeout();
      } else if (audioContext.state === 'closed') {
        rejectAndAbandon(
          new Error('AudioContext closed before synth initialization')
        );
      }
    };

    // Gate the handshake window on the context state. Check-then-subscribe
    // with a re-check: a resume that lands between the first read and the
    // `statechange` attach must not strand the waiter.
    if (audioContext.state === 'closed') {
      rejectAndAbandon(
        new Error('AudioContext closed before synth initialization')
      );
    } else if (audioContext.state === 'running') {
      startHandshakeTimeout();
    } else {
      // `suspended` and iOS's `interrupted` both wait on statechange; the
      // repeating gesture listener in AudioSystem drives the resume.
      audioContext.addEventListener('statechange', onContextStateChange);
      // Fresh read through a full-union helper: the narrowed union from the
      // branches above must not leak into the re-check.
      const readState = (): AudioContextState => audioContext.state;
      if (readState() === 'running' && !resolved) {
        audioContext.removeEventListener('statechange', onContextStateChange);
        startHandshakeTimeout();
      }
    }

    workletNode.port.addEventListener('message', handleMessage);
    workletNode.port.addEventListener('messageerror', handleMessageError as EventListener);
  });
}

export async function createEffectsAudioWorklet(
  audioContext: AudioContext
): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}worklets/effects-worklet.js`
  );
  return new AudioWorkletNode(audioContext, 'effects-audio-processor');
}
