import { shallowRef, type ShallowRef } from 'vue';

/**
 * The preview voice's own post-worklet `GainNode`
 * (`AhxPlayerClient.output`, not the song's mix bus), or `null` when no
 * preview worklet exists. Reactive for the instrument page's analyzer row;
 * written only by the playback store, from the preview's `onOutputNode`.
 *
 * A `shallowRef`, not a `ref`: it is replaced whole, matching the
 * `ahxPListPlayhead` idiom this mirrors — no Proxy ever wraps the node.
 */
export const ahxPreviewOutputNode: ShallowRef<AudioNode | null> = shallowRef(null);

/** Sets the node the analyzer components should tap, or `null` when there is none to tap. */
export function setAhxPreviewOutputNode(node: AudioNode | null): void {
  if (ahxPreviewOutputNode.value === node) return;
  ahxPreviewOutputNode.value = node;
}
