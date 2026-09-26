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
    <select
      v-if="model === '6581'"
      class="sid-revision-select"
      aria-label="6581 revision"
      :title="REVISION_TITLE"
      :value="revision"
      :disabled="disabled === true"
      data-testid="sid-revision"
      @change="chooseRevision(($event.target as HTMLSelectElement).value as Sid6581Revision)"
    >
      <option v-for="option in REVISIONS" :key="option.value" :value="option.value" :title="option.title">
        {{ option.label }}
      </option>
    </select>
  </div>
</template>

<script setup lang="ts">
import type { SidChipModel } from 'src/audio/tracker/sid-doc';
import type { Sid6581Revision } from 'src/audio/worklets/sid-core';

interface Props {
  /** The song's tagged model (its doc's `chipModel`). */
  model: SidChipModel;
  /** Which 6581 plays it (the user's setting, not the song's); shown only on a 6581 song. */
  revision: Sid6581Revision;
  /** The phone toolbar's strip: pill-sized. */
  compact?: boolean;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { compact: false, disabled: false });
const emit = defineEmits<{ select: [model: SidChipModel]; 'select-revision': [revision: Sid6581Revision] }>();

const SID_CHIP_MODELS: readonly SidChipModel[] = ['8580', '6581'];

/** The 6581 revisions offered, in the order of the chips' brightness after the default. */
const REVISIONS: readonly { value: Sid6581Revision; label: string; title: string }[] = [
  { value: 'gt', label: 'GT', title: "GoatTracker's reSID filter, what most GT songs were mixed against" },
  { value: 'r3', label: 'R3', title: 'Real R3 chip (1983), bright' },
  { value: 'r2', label: 'R2', title: 'Real R2 chip (1982), bright' },
  { value: 'r4', label: 'R4', title: 'Real R4 chip (1987), dark' },
];

const REVISION_TITLE =
  "Which 6581 plays the song. The 6581's filter differed from chip to chip: GT is GoatTracker's " +
  'filter; R2, R3 and R4 are real chips measured from recordings. Heard at once, for every 6581 song.';

function chooseRevision(revision: Sid6581Revision): void {
  if (revision !== props.revision) emit('select-revision', revision);
}

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

.sid-revision-select {
  height: 34px;
  padding: 0 4px;
  border-radius: 8px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--tracker-accent-primary, #4df2c5);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.sid-revision-select option {
  background: var(--panel-background, #1a1f2b);
  color: var(--text-primary, #eaf6ff);
}

.sid-chip-toggle.compact .sid-revision-select {
  height: 30px;
}

.sid-chip-toggle.compact .sid-chip-option {
  min-width: 44px;
  height: 30px;
}
</style>
