<template>
  <q-page class="settings-page q-pa-xl">
    <div class="settings-container">
      <div class="tab-bar">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="tab-button"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <transition name="fade-slide" mode="out-in">
        <div :key="activeTab">
          <template v-if="activeTab === 'appearance'">
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
                        v-for="theme in allThemes"
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
                    v-for="theme in allThemes"
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
                      <div class="theme-name">
                        <span>{{ theme.name }}</span>
                      </div>
                      <button
                        v-if="theme.id === 'custom'"
                        type="button"
                        class="edit-theme-button"
                        title="Edit custom theme"
                        @click.stop="openThemeEditor"
                      >
                        <q-icon name="edit" size="16px" />
                      </button>
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
          </template>

          <template v-else>
            <!-- Preferences Section -->
            <section class="settings-section">
              <div class="section-header">
                <h2>Preferences</h2>
              </div>
              <div class="settings-content">
                <p class="section-description">
                  Configure visualizers and MIDI input.
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

                  <label class="toggle-setting">
                    <input
                      type="checkbox"
                      :checked="settings.enableMidi"
                      @change="updateSetting('enableMidi', ($event.target as HTMLInputElement).checked)"
                    />
                    <div class="toggle-info">
                      <span class="toggle-label">Enable MIDI Input</span>
                      <span class="toggle-description">Request MIDI access for external controllers (requires browser permission)</span>
                    </div>
                  </label>
                </div>
              </div>
            </section>
          </template>
        </div>
      </transition>
    </div>
  </q-page>

  <!-- Custom Theme Editor -->
  <div v-if="showThemeEditor" class="theme-editor-overlay">
    <div class="theme-editor-dialog">
      <div class="dialog-header">
        <h3>Edit Custom Theme</h3>
        <button class="dialog-close" type="button" @click="closeThemeEditor">×</button>
      </div>
        <div class="dialog-body">
          <div class="theme-editor-row">
            <label class="dialog-label">Theme name</label>
            <input
              class="dialog-input"
              type="text"
              :value="themeDraft.name"
              disabled
            />
          </div>
          <div class="theme-editor-row">
            <label class="dialog-label">Copy colors from</label>
            <q-select
              class="dialog-select"
              v-model="copySourceId"
              :options="copyThemeOptions"
              dense
              outlined
              emit-value
              map-options
              dropdown-icon="expand_more"
              popup-content-class="dialog-select-menu"
              @update:model-value="applyCopySource"
            />
          </div>

          <div class="color-grid">
            <div v-for="field in colorFields" :key="field.key" class="color-row">
              <label class="color-label">{{ field.label }}</label>
              <div class="color-input-wrapper">
                <label class="color-swatch">
                  <input
                    class="color-picker"
                    type="color"
                    :value="coerceColor(themeDraft.colors[field.key])"
                    @input="onPickColor(field.key, ($event.target as HTMLInputElement).value)"
                  />
                  <span class="color-preview" :style="{ background: themeDraft.colors[field.key] }"></span>
                </label>
              </div>
            </div>
          </div>
        </div>
      <div class="dialog-footer">
        <button type="button" class="dialog-button ghost" @click="closeThemeEditor">Cancel</button>
        <button type="button" class="dialog-button" @click="saveCustomTheme">Save Theme</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { ref, computed } from 'vue';
import { useThemeStore, type ThemeColors, type TrackerTheme } from 'src/stores/theme-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';

const themeStore = useThemeStore();
const {
  currentThemeId,
  currentTheme,
  currentUiFont,
  currentTrackerFont,
  allThemes,
  customTheme
} = storeToRefs(themeStore);
const {
  setTheme,
  setUiFont,
  setTrackerFont,
  uiFonts,
  monospaceFonts,
  setCustomTheme,
  getThemeById
} = themeStore;

const userSettingsStore = useUserSettingsStore();
const { settings } = storeToRefs(userSettingsStore);
const { updateSetting } = userSettingsStore;

const tabs = [
  { id: 'appearance' as const, label: 'Appearance' },
  { id: 'preferences' as const, label: 'Preferences' }
];
type TabId = (typeof tabs)[number]['id'];
const activeTab = ref<TabId>('appearance');

type ColorFieldKey = keyof ThemeColors;
const colorFields: { key: ColorFieldKey; label: string; placeholder?: string }[] = [
  { key: 'appBackground', label: 'App Background' },
  { key: 'appBackgroundAlt', label: 'App Background Alt' },
  { key: 'headerBackground', label: 'Header Background' },
  { key: 'panelBackground', label: 'Panel Background' },
  { key: 'panelBackgroundAlt', label: 'Panel Background Alt' },
  { key: 'panelBorder', label: 'Panel Border' },
  { key: 'textPrimary', label: 'Text Primary' },
  { key: 'textSecondary', label: 'Text Secondary' },
  { key: 'textMuted', label: 'Text Muted' },
  { key: 'buttonBackground', label: 'Button Background' },
  { key: 'buttonBackgroundHover', label: 'Button Hover' },
  { key: 'inputBackground', label: 'Input Background' },
  { key: 'inputBorder', label: 'Input Border' },
  { key: 'entryBase', label: 'Entry Base' },
  { key: 'entryFilled', label: 'Entry Filled' },
  { key: 'entryFilledAlt', label: 'Entry Filled Alt' },
  { key: 'entryRowSub', label: 'Row Sub' },
  { key: 'entryRowBeat', label: 'Row Beat' },
  { key: 'entryRowBar', label: 'Row Bar' },
  { key: 'borderDefault', label: 'Border Default' },
  { key: 'borderHover', label: 'Border Hover' },
  { key: 'borderBeat', label: 'Border Beat' },
  { key: 'borderBar', label: 'Border Bar' },
  { key: 'accentPrimary', label: 'Accent Primary' },
  { key: 'accentSecondary', label: 'Accent Secondary' },
  { key: 'activeBackground', label: 'Active Background' },
  { key: 'activeBorder', label: 'Active Border' },
  { key: 'selectedBorder', label: 'Selected Border' },
  { key: 'selectedBackground', label: 'Selected Background' },
  { key: 'cellActiveBg', label: 'Cell Active BG', placeholder: 'Supports gradients' },
  { key: 'cellActiveText', label: 'Cell Active Text' },
  { key: 'noteText', label: 'Note Text' },
  { key: 'instrumentText', label: 'Instrument Text' },
  { key: 'volumeText', label: 'Volume Text' },
  { key: 'effectText', label: 'Effect Text' },
  { key: 'defaultText', label: 'Default Text' }
];

const showThemeEditor = ref(false);
const copySourceId = ref('custom');
const copyThemeOptions = computed(() =>
  allThemes.value.map((theme) => ({
    label: theme.name,
    value: theme.id
  }))
);

function cloneTheme(theme: TrackerTheme) {
  return {
    ...theme,
    colors: { ...theme.colors }
  };
}

const themeDraft = ref(cloneTheme(customTheme.value));

function openThemeEditor() {
  themeDraft.value = cloneTheme(customTheme.value);
  copySourceId.value = 'custom';
  showThemeEditor.value = true;
}

function closeThemeEditor() {
  showThemeEditor.value = false;
}

function applyCopySource() {
  const source = getThemeById(copySourceId.value);
  themeDraft.value = cloneTheme({
    ...source,
    id: 'custom',
    name: 'Custom',
    description: 'Your custom colors'
  });
}

function saveCustomTheme() {
  setCustomTheme(themeDraft.value);
  setTheme('custom');
  showThemeEditor.value = false;
}

function coerceColor(value: string | undefined): string {
  if (!value) return '#000000';
  // If value is a gradient or invalid for <input type="color">, fallback to black
  const isSimpleHex =
    typeof value === 'string' &&
    /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(value.trim());
  return isSimpleHex ? value.trim() : '#000000';
}

function onPickColor(key: ColorFieldKey, value: string) {
  themeDraft.value.colors[key] = value;
}
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

.tab-bar {
  display: inline-flex;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.03));
  align-self: flex-start;
}

.tab-button {
  padding: 8px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #c8d9f2);
  cursor: pointer;
  font-weight: 600;
}

.tab-button.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
  color: var(--tracker-accent-primary, #4df2c5);
}

.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 200ms ease;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(6px);
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

.current-theme-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-theme-button {
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  background: var(--panel-background-alt, #121a28);
  color: var(--text-primary, #e8f3ff);
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.edit-theme-button:hover {
  border-color: var(--tracker-accent-primary, #4df2c5);
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

.theme-card .edit-theme-button {
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  background: var(--panel-background-alt, #121a28);
  color: var(--text-primary, #e8f3ff);
  border-radius: 8px;
  padding: 4px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
}

.theme-card .edit-theme-button:hover {
  border-color: var(--tracker-accent-primary, #4df2c5);
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
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
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

.theme-editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
}

.theme-editor-dialog {
  background: var(--panel-background, #0f1621);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  width: min(1100px, 95vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
}

.dialog-body {
  padding: 16px;
  overflow: auto;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
}

.dialog-close {
  border: none;
  background: transparent;
  color: var(--text-primary, #e8f3ff);
  font-size: 18px;
  cursor: pointer;
}

.dialog-input,
.dialog-select {
  width: 100%;
  --q-primary: var(--tracker-accent-primary, #4df2c5);
}

.dialog-input {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--input-background, rgba(0, 0, 0, 0.3));
  color: var(--text-primary, #e8f3ff);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.dialog-input:focus {
  outline: none;
  border-color: var(--tracker-accent-primary, #4df2c5);
  box-shadow: 0 0 0 2px rgba(77, 242, 197, 0.15);
}

.dialog-select .q-field__control {
  border-radius: 6px;
  background: var(--input-background, rgba(0, 0, 0, 0.3));
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  min-height: 38px;
}

.dialog-select .q-field__native,
.dialog-select .q-field__marginal {
  color: var(--text-primary, #e8f3ff);
}

.dialog-select .q-field__append {
  color: var(--text-muted, #9fb3d3);
}

.dialog-select.q-field--focused .q-field__control {
  border-color: var(--tracker-accent-primary, #4df2c5);
  box-shadow: 0 0 0 2px rgba(77, 242, 197, 0.15);
}

.dialog-label {
  font-size: 12px;
  color: var(--text-muted, #9fb3d3);
}

.theme-editor-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dialog-button {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid var(--tracker-accent-primary, #4df2c5);
  background: var(--tracker-accent-primary, #4df2c5);
  color: #0c1624;
  cursor: pointer;
}

.dialog-button.ghost {
  background: transparent;
  color: var(--text-primary, #e8f3ff);
  border-color: var(--panel-border, rgba(255, 255, 255, 0.12));
}

.color-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  margin-top: 8px;
}

.color-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.color-label {
  font-size: 12px;
  color: var(--text-muted, #9fb3d3);
}

.color-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-preview {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
}

.color-swatch {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.color-picker {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.dialog-select-menu {
  background: var(--panel-background, #151d2a) !important;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  color: var(--text-primary, #e8f3ff);
}

.dialog-select-menu .q-item {
  color: var(--text-primary, #e8f3ff);
}

.dialog-select-menu .q-item:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.05));
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
