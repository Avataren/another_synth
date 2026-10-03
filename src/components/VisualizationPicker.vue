<template>
  <!--
    Picks what fills the space under the toolbar (see visualization-modes.ts).
    Sits beside the post-fx control, so it is styled as its sibling: the same
    small bordered button as LIM, opening a menu of the modes.
  -->
  <button
    type="button"
    class="viz-picker-btn"
    data-testid="visualization-picker"
    :title="`View: ${current.title}`"
  >
    <q-icon :name="current.icon" size="14px" />
    <span class="viz-picker-label">{{ current.label }}</span>
    <q-icon name="arrow_drop_down" size="14px" />
    <q-menu class="viz-picker-menu" anchor="bottom right" self="top right">
      <q-list dense class="viz-picker-list">
        <q-item
          v-for="option in VISUALIZATION_MODES"
          :key="option.id"
          v-close-popup
          clickable
          :active="option.id === mode"
          active-class="viz-picker-active"
          :data-testid="`visualization-option-${option.id}`"
          :title="option.title"
          @click="select(option.id)"
        >
          <q-item-section avatar class="viz-picker-icon">
            <q-icon :name="option.icon" size="18px" />
          </q-item-section>
          <q-item-section>{{ option.label }}</q-item-section>
        </q-item>
        <template v-if="showPlacement">
          <q-separator dark />
          <q-item-label header class="viz-picker-header">Show in</q-item-label>
          <q-item
            v-for="option in PLACEMENT_OPTIONS"
            :key="option.id"
            v-close-popup
            clickable
            :active="option.id === placement"
            active-class="viz-picker-active"
            :data-testid="`visualization-placement-${option.id}`"
            :title="option.title"
            @click="setPlacement(option.id)"
          >
            <q-item-section avatar class="viz-picker-icon">
              <q-icon :name="option.icon" size="18px" />
            </q-item-section>
            <q-item-section>{{ option.label }}</q-item-section>
          </q-item>
        </template>
      </q-list>
    </q-menu>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useVisualizationMode } from 'src/composables/useVisualizationMode';
import {
  VISUALIZATION_MODES,
  type VisualizationMode,
  type VisualizationPlacement,
} from 'src/components/tracker/visualization-modes';

withDefaults(defineProps<{ showPlacement?: boolean }>(), { showPlacement: false });

const { mode, setMode, placement, setPlacement } = useVisualizationMode();

const PLACEMENT_OPTIONS: readonly {
  id: VisualizationPlacement;
  label: string;
  icon: string;
  title: string;
}[] = [
  { id: 'pattern', label: 'Pattern area', icon: 'view_list', title: 'Replace the pattern grid' },
  {
    id: 'top',
    label: 'Top panels',
    icon: 'vertical_align_top',
    title: 'Replace the sequence, song and instrument panels, keeping the pattern visible',
  },
];

// The table is never empty and `mode` is sanitised against it.
const current = computed(
  () => VISUALIZATION_MODES.find((option) => option.id === mode.value) ?? VISUALIZATION_MODES[0]!,
);

function select(next: VisualizationMode): void {
  setMode(next);
}
</script>

<style scoped>
.viz-picker-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 3px 2px 5px;
  cursor: pointer;
}

.viz-picker-btn:hover {
  color: var(--text-primary, rgba(255, 255, 255, 0.95));
}

.viz-picker-label {
  margin: 0 1px 0 3px;
  text-transform: uppercase;
}
</style>

<style>
/* The menu renders in a portal, so it cannot be scoped. */
.viz-picker-list {
  min-width: 150px;
  background: #1d2126;
  color: rgba(255, 255, 255, 0.85);
}

.viz-picker-list .q-item {
  min-height: 32px;
  font-size: 12px;
}

.viz-picker-list .viz-picker-icon {
  min-width: 26px;
  padding-right: 8px;
}

.viz-picker-list .viz-picker-header {
  padding: 6px 16px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.45);
}

.viz-picker-list .viz-picker-active {
  background: rgba(255, 179, 71, 0.16);
  color: #ffcf87;
}
</style>
