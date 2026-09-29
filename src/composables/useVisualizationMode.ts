import { computed, type ComputedRef } from 'vue';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import {
  sanitizeVisualizationMode,
  type VisualizationMode,
} from 'src/components/tracker/visualization-modes';

/**
 * The view picked with the visualization picker, and a way to change it.
 *
 * One setting behind both the tracker and the jukebox, so the choice follows
 * the user between them. A stored value this build does not know reads as the
 * default rather than as a blank page.
 */
export function useVisualizationMode(): {
  mode: ComputedRef<VisualizationMode>;
  setMode: (next: VisualizationMode) => void;
} {
  const settingsStore = useUserSettingsStore();
  const mode = computed(() => sanitizeVisualizationMode(settingsStore.settings.visualizationMode));
  function setMode(next: VisualizationMode): void {
    settingsStore.updateSetting('visualizationMode', next);
  }
  return { mode, setMode };
}
