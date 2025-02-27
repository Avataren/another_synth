import { defineBoot } from '#q-app/wrappers';
import { useAudioSystemStore } from 'stores/audio-system-store';

export default defineBoot(async () => {
    const audioSystemStore = useAudioSystemStore();

    // Initialize the AudioSystem instance
    audioSystemStore.initializeAudioSystem();

    // Set up the AudioSystem (e.g., load WASM, create AudioWorklet, etc.)
    try {
        await audioSystemStore.setupAudio();
        console.log('AudioSystem successfully set up');
    } catch (error) {
        console.error('Error setting up AudioSystem:', error);
    }
});
