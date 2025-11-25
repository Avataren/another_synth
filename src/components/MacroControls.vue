<template>
  <div class="macro-card">
    <div class="macro-card__header">
      <div class="macro-card__title">Macros</div>
      <div class="macro-card__hint">Assign these to modulation targets</div>
    </div>

    <div class="macro-grid">
      <div v-for="index in macroCount" :key="index" class="macro-column">
        <div class="macro-knob">
          <audio-knob-component
            :model-value="getMacroValue(index - 1)"
            :label="`Macro ${index}`"
            :min="0"
            :max="1"
            :decimals="2"
            scale="half"
            :color="'var(--tracker-accent-secondary)'"
            @update:model-value="(val: number) => setMacro(index - 1, val)"
          />
        </div>
        <RoutingComponent
          :source-id="`macro-${index - 1}`"
          :source-type="VoiceNodeType.LFO"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useMacroStore } from 'src/stores/macro-store';
import { useLayoutStore } from 'src/stores/layout-store';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

const instrumentStore = useInstrumentStore();
const macroStore = useMacroStore();
const layoutStore = useLayoutStore();
const macroCount = 4;
const macroValues = computed(() => instrumentStore.macros);

const getMacroValue = (index: number): number =>
  macroValues.value?.[index] ?? 0;

function setMacro(index: number, value: number) {
  instrumentStore.setMacro(index, value);
}

watch(
  () => layoutStore.synthLayout,
  () => {
    macroStore.reapplyAllRoutes();
  },
  { immediate: true },
);
</script>

<style scoped>
.macro-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
}

.macro-card__header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  justify-content: space-between;
}

.macro-card__title {
  font-weight: 700;
  letter-spacing: 0.02em;
}

.macro-card__hint {
  font-size: 12px;
  opacity: 0.7;
}

.macro-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}

.macro-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 10px;
}

.macro-knob {
  display: flex;
  justify-content: center;
}

.macro-routes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.macro-routes__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  font-size: 13px;
}

.macro-routes__add {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--panel-border);
  background: var(--button-background);
  color: var(--text-primary);
  cursor: pointer;
}

.macro-route-row {
  display: grid;
  grid-template-columns: 1.1fr 1.2fr auto auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--button-background);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
}

.macro-select {
  width: 100%;
  background: var(--input-background);
  color: var(--text-primary);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  padding: 6px 8px;
}

.macro-route-row__delete {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--panel-border);
  background: var(--button-background);
  color: var(--tracker-accent-primary);
  cursor: pointer;
}
</style>
