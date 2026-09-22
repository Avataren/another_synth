<template>
  <section
    class="ahx-position-panel"
    data-testid="ahx-position-panel"
    :data-position="position"
  >
    <header class="ahx-position-panel__header">
      <span class="ahx-position-panel__title">Position {{ position + 1 }}</span>
      <span class="ahx-position-panel__hint" title="The transpose byte shifts every note this position plays on that channel, held notes included; it applies even where the slot is empty.">transpose per channel</span>
    </header>
    <div class="ahx-position-panel__rows">
      <div
        v-for="(channel, index) in channels"
        :key="index"
        class="ahx-position-panel__row"
      >
        <span class="ahx-position-panel__channel">Ch {{ index + 1 }}</span>
        <span
          class="ahx-position-panel__track"
          :title="`This position's track on channel ${index + 1}. Track reassignment is not editable here yet.`"
        >track {{ channel.track }}</span>
        <AhxNumberField
          :ref="(el) => setFieldRef(index, el)"
          class="ahx-position-panel__transpose"
          :model-value="channel.transpose"
          :min="-128"
          :max="127"
          :title="ahxTransposeTitle(position, index, channel.transpose)"
          :testid="`ahx-pos-transpose-${index}`"
          suffix="st"
          @update:model-value="(value: number) => emit('set-transpose', index, value)"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import { ahxTransposeTitle } from 'src/audio/tracker/ahx-position-display';

export interface AhxPositionChannel {
  /** The doc track number this position's channel plays (display only here). */
  track: number;
  /** The signed transpose byte, -128..127. */
  transpose: number;
}

defineProps<{
  /** Zero-based position index shown in the header and the tooltips. */
  position: number;
  /** One entry per channel of the current position, doc order. */
  channels: readonly AhxPositionChannel[];
}>();

const emit = defineEmits<{
  (event: 'set-transpose', channel: number, value: number): void;
}>();

/**
 * The badge hand-off: the grid's transpose badge focuses this panel's input
 * for that channel (the page's one habit between display and editor).
 */
type FieldInstance = { $el: HTMLLabelElement | null } | null;
const fields: FieldInstance[] = [];
function setFieldRef(index: number, el: unknown): void {
  fields[index] = (el as FieldInstance) ?? null;
}
function focusChannel(channel: number): void {
  const field = fields[channel];
  const input = field?.$el?.querySelector('input');
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
  }
}
defineExpose({ focusChannel });
</script>

<style scoped>
.ahx-position-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--tracker-border, rgba(255, 255, 255, 0.12));
}

.ahx-position-panel__header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.ahx-position-panel__title {
  font-weight: 600;
  font-size: 12px;
}

.ahx-position-panel__hint {
  color: var(--tracker-dim, rgba(255, 255, 255, 0.55));
  font-size: 11px;
}

.ahx-position-panel__rows {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px 10px;
}

.ahx-position-panel__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ahx-position-panel__channel {
  font-size: 11px;
  color: var(--tracker-dim, rgba(255, 255, 255, 0.55));
  flex: none;
}

.ahx-position-panel__track {
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ahx-position-panel__transpose {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
