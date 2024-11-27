// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';

export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
  }),
  actions: {
    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = new AudioSystem();
      }
    },
    async setupAudio() {
      if (this.audioSystem) {
        await this.audioSystem.setupAudio();
        this.destinationNode = this.audioSystem.destinationNode;
      } else {
        console.error('AudioSystem not initialized');
      }
    },
  },
});
