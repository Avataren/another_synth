<template>
  <div class="macro-card">
    <div class="macro-card__header">
      <div class="macro-card__title">Macros</div>
      <div class="macro-card__hint">Assign these to modulation targets</div>
    </div>

    <div class="macro-grid">
      <div
        v-for="index in macroCount"
        :key="index"
        class="macro-column"
      >
        <div class="macro-knob">
          <audio-knob-component
            :model-value="getMacroValue(index - 1)"
            :label="`Macro ${index}`"
            :min="0"
            :max="1"
            :decimals="2"
            scale="half"
            color="#66d9ff"
            @update:model-value="(val: number) => setMacro(index - 1, val)"
          />
        </div>

        <div class="macro-routes">
          <div class="macro-routes__header">
            <span>Routes</span>
            <button type="button" class="macro-routes__add" @click="addRoute(index - 1)">
              +
            </button>
          </div>
          <div
            v-for="route in routesForMacro(index - 1)"
            :key="route.id"
            class="macro-route-row"
          >
            <select
              class="macro-select"
              :value="route.targetId"
              @change="onTargetChange(route, ($event.target as HTMLSelectElement).value)"
            >
              <option
                v-for="target in getAvailableTargets(index - 1)"
                :key="target.id"
                :value="target.id"
              >
                {{ target.name }}
              </option>
            </select>
            <select
              class="macro-select"
              :value="route.targetPort"
              @change="onParamChange(route, Number(($event.target as HTMLSelectElement).value))"
            >
              <option
                v-for="param in getAvailableParams(index - 1, route.targetId)"
                :key="param.value"
                :value="param.value"
              >
                {{ param.label }}
              </option>
            </select>
            <audio-knob-component
              :model-value="route.amount"
              label="Amt"
              :min="0"
              :max="1"
              :decimals="2"
              scale="mini"
              color="#d966ff"
              @update:model-value="(val: number) => onAmountChange(route, val)"
            />
            <button type="button" class="macro-route-row__delete" @click="removeRoute(route.id)">
              ✕
            </button>
          </div>
        </div>
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
import {
  ModulationRouteManager,
  type TargetNode,
} from 'src/audio/modulation-route-manager';
import { VoiceNodeType, type ModulationTargetOption } from 'src/audio/types/synth-layout';
import type { PortId } from 'app/public/wasm/audio_processor';

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

const routeManagers = computed(() =>
  Array.from({ length: macroCount }, (_, idx) => {
    return new ModulationRouteManager(`macro-${idx}`, VoiceNodeType.LFO);
  }),
);

const getAvailableTargets = (macroIndex: number): TargetNode[] =>
  routeManagers.value[macroIndex]?.getAvailableTargets() ?? [];

const getAvailableParams = (macroIndex: number, targetId: string): ModulationTargetOption[] =>
  routeManagers.value[macroIndex]?.getAvailableParams(targetId) ?? [];

const routesForMacro = (macroIndex: number) => macroStore.routesForMacro(macroIndex);

function addRoute(macroIndex: number) {
  const firstTarget = getAvailableTargets(macroIndex)[0];
  if (!firstTarget) return;
  const params = getAvailableParams(macroIndex, firstTarget.id);
  const firstParam = params[0];
  if (!firstParam) return;
  macroStore.addRoute({
    macroIndex,
    targetId: firstTarget.id,
    targetPort: firstParam.value as PortId,
    amount: 0.5,
  });
}

function onTargetChange(route: { id: string }, targetId: string) {
  const macroIndex = macroStore.routes.find((r) => r.id === route.id)?.macroIndex ?? 0;
  const params = getAvailableParams(macroIndex, targetId);
  const firstParam = params[0];
  if (!firstParam) return;
  macroStore.updateRoute({
    ...(macroStore.routes.find((r) => r.id === route.id)!),
    targetId,
    targetPort: firstParam.value as PortId,
  });
}

function onParamChange(route: { id: string }, targetPort: number) {
  const existing = macroStore.routes.find((r) => r.id === route.id);
  if (!existing) return;
  macroStore.updateRoute({ ...existing, targetPort: targetPort as PortId });
}

function onAmountChange(route: { id: string }, amount: number) {
  const existing = macroStore.routes.find((r) => r.id === route.id);
  if (!existing) return;
  macroStore.updateRoute({ ...existing, amount });
}

function removeRoute(id: string) {
  macroStore.removeRoute(id);
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
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.08);
  color: #eaf2ff;
  cursor: pointer;
}

.macro-route-row {
  display: grid;
  grid-template-columns: 1.1fr 1.2fr auto auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
}

.macro-select {
  width: 100%;
  background: #0d1118;
  color: #eaf2ff;
  border: 1px solid #273140;
  border-radius: 6px;
  padding: 6px 8px;
}

.macro-route-row__delete {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: #f7b0b0;
  cursor: pointer;
}
</style>
