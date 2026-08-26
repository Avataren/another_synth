import { defineBoot } from '#q-app/wrappers';
import { useInstrumentStore } from 'stores/instrument-store';
import { usePatchStore } from 'stores/patch-store';
import { useNodeStateStore } from 'stores/node-state-store';
import { useMacroStore } from 'stores/macro-store';

export default defineBoot(async () => {
    const instrumentStore = useInstrumentStore();
    const patchStore = usePatchStore();
    const nodeStateStore = useNodeStateStore();
    const macroStore = useMacroStore();

    // Any direct mutation to patch-content state (oscillator/filter/envelope/
    // LFO/sampler/etc. params, macro routes) marks the currently-loaded
    // patch dirty via patchStore.notifyPatchChanged(), so patchStore.isDirty
    // accurately reflects "has something audible changed since this patch
    // was loaded/saved" without scattering notifyPatchChanged() calls across
    // every editor component. notifyPatchChanged() already no-ops while a
    // patch load is in progress, so bulk state restores on load are safe.
    // (nodeStateStore.samplerWaveforms is UI preview data, not patch
    // content, but that map only changes alongside a real sample edit in
    // practice, so an occasional harmless false-positive "dirty" from it is
    // a safe over-approximation, not a missed edit.)
    nodeStateStore.$subscribe(() => patchStore.notifyPatchChanged());
    macroStore.$subscribe(() => patchStore.notifyPatchChanged());

    // Initialize the AudioSystem instance
    instrumentStore.initializeAudioSystem();

    // Set up the AudioSystem (e.g., load WASM, create AudioWorklet, etc.)
    try {
        await instrumentStore.setupAudio();
        console.log('AudioSystem successfully set up');

        // Try to load system bank, otherwise initialize a new patch session
        const systemBankLoaded = await patchStore.loadSystemBankIfPresent();
        if (!systemBankLoaded) {
            await patchStore.initializeNewPatchSession();
        }
    } catch (error) {
        console.error('Error setting up AudioSystem:', error);
    }
});
