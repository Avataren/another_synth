import { defineBoot } from '#q-app/wrappers';
import { useAudioSystemStore } from 'stores/audio-system-store';
import { usePatchStore } from 'stores/patch-store';

export default defineBoot(async () => {
    const audioSystemStore = useAudioSystemStore();
    const patchStore = usePatchStore();

    // Initialize the AudioSystem instance
    audioSystemStore.initializeAudioSystem();

    // Set up the AudioSystem (e.g., load WASM, create AudioWorklet, etc.)
    try {
        await audioSystemStore.setupAudio();
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
