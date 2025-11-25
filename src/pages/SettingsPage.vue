<template>
  <q-page class="settings-page q-pa-xl">
    <div class="settings-container">
      <!-- Theme Section -->
      <section class="settings-section">
        <div class="section-header">
          <h2>Theme</h2>
          <div class="current-theme-badge" role="button">
            <span class="badge-label">Current:</span>
            <span class="badge-value">{{ currentTheme.name }}</span>
            <q-icon name="expand_more" size="18px" class="badge-icon" />
            <q-menu anchor="bottom right" self="top right" class="theme-menu">
              <q-list>
                <q-item
                  v-for="theme in themePresets"
                  :key="theme.id"
                  clickable
                  v-close-popup
                  :active="currentThemeId === theme.id"
                  active-class="theme-menu-active"
                  @click="setTheme(theme.id)"
                >
                  <q-item-section side>
                    <div
                      class="menu-color-dot"
                      :style="{ background: theme.colors.accentPrimary }"
                    />
                  </q-item-section>
                  <q-item-section>
                    <q-item-label>{{ theme.name }}</q-item-label>
                    <q-item-label caption>{{ theme.description }}</q-item-label>
                  </q-item-section>
                  <q-item-section v-if="currentThemeId === theme.id" side>
                    <q-icon name="check" color="positive" size="18px" />
                  </q-item-section>
                </q-item>
              </q-list>
            </q-menu>
          </div>
        </div>
        <div class="settings-content">
          <p class="section-description">
            Choose a color theme for the interface.
          </p>
          <div class="theme-grid">
            <div
              v-for="theme in themePresets"
              :key="theme.id"
              class="theme-card"
              :class="{ active: currentThemeId === theme.id }"
              @click="setTheme(theme.id)"
            >
              <div class="theme-preview">
                <div
                  class="preview-bar"
                  :style="{
                    background: theme.colors.accentPrimary
                  }"
                />
              </div>
              <div class="theme-info">
                <div class="theme-name">{{ theme.name }}</div>
              </div>
              <div v-if="currentThemeId === theme.id" class="theme-check">
                <q-icon name="check_circle" size="20px" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Fonts Section -->
      <section class="settings-section">
        <div class="section-header">
          <h2>Fonts</h2>
        </div>
        <div class="settings-content">
          <p class="section-description">
            Customize the fonts used throughout the application.
          </p>

          <div class="font-settings">
            <!-- UI Font Selection -->
            <div class="font-setting">
              <div class="font-setting-header">
                <label class="font-label">Interface Font</label>
                <span class="font-preview-text" :style="{ fontFamily: `'${currentUiFont}', sans-serif` }">
                  {{ currentUiFont }}
                </span>
              </div>
              <div class="font-grid">
                <div
                  v-for="font in uiFonts"
                  :key="font.id"
                  class="font-card"
                  :class="{ active: currentUiFont === font.id }"
                  @click="setUiFont(font.id)"
                >
                  <span class="font-name" :style="{ fontFamily: `'${font.id}', sans-serif` }">
                    {{ font.name }}
                  </span>
                  <div v-if="currentUiFont === font.id" class="font-check">
                    <q-icon name="check_circle" size="16px" />
                  </div>
                </div>
              </div>
            </div>

            <!-- Tracker Font Selection -->
            <div class="font-setting">
              <div class="font-setting-header">
                <label class="font-label">Tracker Font</label>
                <span class="font-preview-text mono" :style="{ fontFamily: `'${currentTrackerFont}', monospace` }">
                  {{ currentTrackerFont }}
                </span>
              </div>
              <div class="font-grid">
                <div
                  v-for="font in monospaceFonts"
                  :key="font.id"
                  class="font-card"
                  :class="{ active: currentTrackerFont === font.id }"
                  @click="setTrackerFont(font.id)"
                >
                  <span class="font-name mono" :style="{ fontFamily: `'${font.id}', monospace` }">
                    {{ font.name }}
                  </span>
                  <div v-if="currentTrackerFont === font.id" class="font-check">
                    <q-icon name="check_circle" size="16px" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Visualizers Section -->
      <section class="settings-section">
        <div class="section-header">
          <h2>Visualizers</h2>
        </div>
        <div class="settings-content">
          <p class="section-description">
            Configure audio visualizations in the tracker.
          </p>

          <div class="toggle-settings">
            <label class="toggle-setting">
              <input
                type="checkbox"
                :checked="settings.showSpectrumAnalyzer"
                @change="updateSetting('showSpectrumAnalyzer', ($event.target as HTMLInputElement).checked)"
              />
              <div class="toggle-info">
                <span class="toggle-label">Spectrum Analyzer</span>
                <span class="toggle-description">Show frequency spectrum overlay on the tracker</span>
              </div>
            </label>

            <label class="toggle-setting">
              <input
                type="checkbox"
                :checked="settings.showWaveformVisualizers"
                @change="updateSetting('showWaveformVisualizers', ($event.target as HTMLInputElement).checked)"
              />
              <div class="toggle-info">
                <span class="toggle-label">Track Waveforms</span>
                <span class="toggle-description">Show waveform visualizers for each track</span>
              </div>
            </label>
          </div>
        </div>
      </section>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useThemeStore } from 'src/stores/theme-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';

const themeStore = useThemeStore();
const { currentThemeId, currentTheme, currentUiFont, currentTrackerFont } = storeToRefs(themeStore);
const { setTheme, setUiFont, setTrackerFont, themePresets, uiFonts, monospaceFonts } = themeStore;

const userSettingsStore = useUserSettingsStore();
const { settings } = storeToRefs(userSettingsStore);
const { updateSetting } = userSettingsStore;
</script>

<style scoped>
.settings-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.settings-container {
  max-width: 900px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.settings-section {
  padding: 24px;
  background: var(--panel-background, #0f1621);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.06));
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}

.section-header h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary, #e8f3ff);
}

.current-theme-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--button-background, rgba(77, 242, 197, 0.1));
  border: 1px solid var(--tracker-accent-primary, rgba(77, 242, 197, 0.3));
  border-radius: 20px;
  cursor: pointer;
  transition: all 150ms ease;
}

.current-theme-badge:hover {
  background: var(--button-background-hover, rgba(77, 242, 197, 0.18));
}

.badge-label {
  font-size: 12px;
  color: var(--text-muted, #9fb3d3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.badge-value {
  font-size: 13px;
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
  font-weight: 600;
}

.badge-icon {
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
  margin-left: 2px;
}

.menu-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}

.settings-content {
  color: var(--text-secondary, #c8d9f2);
}

.section-description {
  margin: 0 0 12px 0;
  font-size: 14px;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.theme-card {
  position: relative;
  padding: 12px;
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.03));
  border: 2px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  cursor: pointer;
  transition: all 200ms ease;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.theme-card:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.05));
  border-color: var(--tracker-accent-primary, rgba(255, 255, 255, 0.15));
  transform: translateY(-1px);
}

.theme-card.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.6));
}

.theme-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  background: var(--input-background, rgba(0, 0, 0, 0.3));
  border-radius: 4px;
}

.preview-bar {
  height: 4px;
  border-radius: 2px;
}

.theme-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.theme-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #e8f3ff);
}

.theme-check {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
}

/* Font settings styles */
.font-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.font-setting {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.font-setting-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.font-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e8f3ff);
}

.font-preview-text {
  font-size: 13px;
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
  padding: 4px 10px;
  background: var(--button-background, rgba(77, 242, 197, 0.1));
  border-radius: 4px;
}

.font-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.font-card {
  position: relative;
  padding: 12px 14px;
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.03));
  border: 2px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  cursor: pointer;
  transition: all 200ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.font-card:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.05));
  border-color: var(--tracker-accent-primary, rgba(255, 255, 255, 0.15));
}

.font-card.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.6));
}

.font-name {
  font-size: 14px;
  color: var(--text-primary, #e8f3ff);
  text-align: center;
}

.font-check {
  position: absolute;
  top: 6px;
  right: 6px;
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
}

/* Toggle settings styles */
.toggle-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toggle-setting {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  cursor: pointer;
  transition: all 150ms ease;
}

.toggle-setting:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.05));
  border-color: var(--panel-border, rgba(255, 255, 255, 0.12));
}

.toggle-setting input[type="checkbox"] {
  width: 20px;
  height: 20px;
  accent-color: var(--tracker-accent-primary, rgb(77, 242, 197));
  cursor: pointer;
  flex-shrink: 0;
}

.toggle-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toggle-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e8f3ff);
}

.toggle-description {
  font-size: 12px;
  color: var(--text-muted, #9fb3d3);
}
</style>

<style>
/* Menu styles (not scoped - menu renders in portal) */
.theme-menu {
  background: var(--panel-background, #151d2a) !important;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  min-width: 240px;
}

.theme-menu .q-item {
  padding: 10px 14px;
}

.theme-menu .q-item__label {
  color: var(--text-primary, #e8f3ff);
  font-weight: 500;
}

.theme-menu .q-item__label--caption {
  color: var(--text-muted, #9fb3d3);
}

.theme-menu .q-item:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.05));
}

.theme-menu .theme-menu-active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.1));
}

.theme-menu .theme-menu-active .q-item__label {
  color: var(--tracker-accent-primary, rgb(77, 242, 197));
}
</style>
