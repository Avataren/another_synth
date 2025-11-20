import { defineBoot } from '#q-app/wrappers';
import { useInstrumentStore } from 'stores/instrument-store';
import { usePatchStore } from 'stores/patch-store';

export default defineBoot(async () => {
    const instrumentStore = useInstrumentStore();
    const patchStore = usePatchStore();

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
