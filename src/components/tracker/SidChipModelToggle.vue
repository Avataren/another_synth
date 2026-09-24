<template>
  <div
    class="sid-chip-toggle"
    :class="{ compact }"
    role="group"
    aria-label="SID chip model"
    data-testid="sid-chip-toggle"
  >
    <span class="sid-chip-label">SID</span>
    <button
      v-for="option in SID_CHIP_MODELS"
      :key="option"
      type="button"
      class="sid-chip-option"
      :class="{ active: model === option }"
      :aria-pressed="model === option"
      :title="`Play this song on the ${option} chip`"
      :disabled="disabled === true"
      :data-testid="`sid-chip-${option}`"
      @mousedown.prevent
      @click="choose(option)"
    >
      {{ option }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { SidChipModel } from 'src/audio/tracker/sid-doc';

interface Props {
  /** The song's tagged model (its doc's `chipModel`). */
  model: SidChipModel;
  /** The phone toolbar's strip: pill-sized. */
  compact?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { compact: false, disabled: false });
const emit = defineEmits<{ select: [model: SidChipModel] }>();

const SID_CHIP_MODELS: readonly SidChipModel[] = ['8580', '6581'];

function choose(option: SidChipModel): void {
  if (option !== props.model) emit('select', option);
}
</script>

<style scoped>
.sid-chip-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 10px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  align-self: center;
}

.sid-chip-label {
  padding: 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary, #b8c9e0);
}

.sid-chip-option {
  min-width: 48px;
  height: 34px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary, #b8c9e0);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  touch-action: manipulation;
}

.sid-chip-option:hover:not(:disabled) {
  color: var(--text-primary, #eaf6ff);
  background: var(--button-hover, rgba(255, 255, 255, 0.08));
}

.sid-chip-option.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.14));
  color: var(--tracker-accent-primary, #4df2c5);
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.5));
}

.sid-chip-toggle.compact .sid-chip-option {
  min-width: 44px;
  height: 30px;
}
</style>
