<template>
  <q-layout view="lHh Lpr lFf" class="app-layout">
    <q-header elevated class="app-header">
      <q-toolbar class="app-toolbar">
        <q-toolbar-title>Synthesizer</q-toolbar-title>

        <q-tabs
          dense
          active-color="white"
          indicator-color="primary"
          align="center"
          class="main-tabs text-white"
          inline-label
        >
          <q-route-tab to="/tracker" name="tracker" label="Tracker" exact />
          <q-route-tab to="/patch" name="patch" label="Patch editor" exact />
          <q-route-tab to="/settings" name="settings" label="Settings" exact />
          <q-route-tab to="/help" name="help" label="Help" exact />
        </q-tabs>
        <q-space />

        <!-- Playback indicator -->
        <div v-if="isPlaying || isPaused" class="playback-indicator">
          <q-btn
            flat
            dense
            round
            size="sm"
            :icon="isPlaying ? 'pause' : 'play_arrow'"
            :title="isPlaying ? 'Pause' : 'Resume'"
            @click="togglePlayPause"
          />
          <q-btn
            flat
            dense
            round
            size="sm"
            icon="stop"
            title="Stop"
            @click="handleStop"
          />
          <span class="playback-status">
            <span class="playback-dot" :class="{ playing: isPlaying, paused: isPaused }"></span>
            {{ isPlaying ? 'Playing' : 'Paused' }}
          </span>
        </div>

        <div class="cpu"><CpuUsageHeader /></div>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import CpuUsageHeader from 'src/components/CpuUsageHeader.vue';
import { useThemeStore } from 'src/stores/theme-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';

// Initialize theme store - this will automatically apply the saved theme from localStorage
useThemeStore();

// Playback state for header indicator
const playbackStore = useTrackerPlaybackStore();
const { isPlaying, isPaused } = storeToRefs(playbackStore);

function togglePlayPause() {
  if (isPlaying.value) {
    playbackStore.pause();
  } else if (isPaused.value) {
    // Resume - need to call play on the engine directly
    const engine = playbackStore.engine;
    if (engine) {
      void engine.play();
    }
  }
}

function handleStop() {
  playbackStore.stop();
}
</script>
<style scoped>
.cpu {
  width: 250px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}

.playback-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  margin-right: 12px;
}

.playback-indicator :deep(.q-btn) {
  color: var(--text-secondary, rgba(255, 255, 255, 0.75));
}

.playback-indicator :deep(.q-btn:hover) {
  color: var(--text-primary, #ffffff);
}

.playback-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.75));
  padding-left: 4px;
}

.playback-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary, rgba(255, 255, 255, 0.5));
}

.playback-dot.playing {
  background: #4caf50;
  animation: pulse 1s ease-in-out infinite;
}

.playback-dot.paused {
  background: #ff9800;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.app-header {
  --app-header-height: 44px;
  z-index: 1000;
  height: var(--app-header-height);
  min-height: var(--app-header-height);
  background: var(--header-background, #0a0f18) !important;
}

.app-toolbar {
  gap: 10px;
  min-height: var(--app-header-height);
  padding: 4px 10px;
  align-items: center;
  background: transparent;
  color: var(--text-primary, #e8f3ff);
}

.app-toolbar :deep(.q-toolbar__title) {
  color: var(--text-primary, #e8f3ff);
}

.main-tabs {
  flex: 0 1 auto;
}

.main-tabs :deep(.q-tab__label) {
  color: var(--text-secondary, rgba(255, 255, 255, 0.75));
  font-weight: 600;
}

.main-tabs :deep(.q-tab--active .q-tab__label) {
  color: var(--text-primary, #ffffff);
  font-weight: 700;
}

.main-tabs :deep(.q-tab__indicator) {
  background: var(--tracker-accent-primary, currentColor) !important;
}

@media (max-width: 900px) {
  .main-tabs {
    width: 100%;
    justify-content: center;
  }
}

.preset-bar {
  min-height: 64px;
  display: flex;
  align-items: center;
}

.app-layout {
  min-height: 100vh;
  overflow: hidden;
  background: var(--app-background, #0b111a);
}

.app-layout :deep(.q-page-container) {
  height: 100vh;
  padding-top: var(--app-header-height, 44px);
  overflow: hidden;
  box-sizing: border-box;
  background: var(--app-background, #0b111a);
}

.app-layout :deep(.q-page) {
  min-height: calc(100vh - var(--app-header-height, 44px));
  max-height: calc(100vh - var(--app-header-height, 44px));
  overflow: auto;
  background: var(--app-background, #0b111a);
}
</style>
