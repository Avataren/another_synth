<template>
  <div class="routing-section">
    <q-expansion-item
      v-model="isExpanded"
      icon="share"
      label="Modulation Routing"
      header-class="bg-dark text-white"
      dark
      expand-icon-class="text-white"
      default-opened
    >
      <q-card dark class="bg-dark">
        <q-card-section>
          <q-btn
            color="primary"
            icon="add"
            label="Add Routing"
            @click="addNewRoute"
            class="q-mb-md"
            :disable="availableTargetNodes.length === 0"
          />

          <!-- Use transition-group with stable keys -->
          <transition-group name="fade" tag="div">
            <div
              v-for="route in safeActiveRoutes"
              :key="route.id"
              class="route-item q-mb-sm"
            >
              <div class="row q-col-gutter-sm items-center">
                <!-- Target Node Selection -->
                <div class="col-3">
                  <q-select
                    v-model="route.targetNode"
                    :options="getAvailableTargets()"
                    label="Target"
                    dense
                    dark
                    filled
                    option-label="name"
                    @update:model-value="
                      (val) => handleTargetChange(route.id, val)
                    "
                  />
                </div>

                <!-- Parameter Selection -->
                <div class="col-3">
                  <q-select
                    :model-value="
                      getSafeParam(route.targetId, route.target)?.value
                    "
                    :options="getSafeParams(route.targetId)"
                    :display-value="route.targetLabel"
                    option-label="label"
                    label="Parameter"
                    dense
                    dark
                    filled
                    @update:model-value="
                      (val) => handleParamChange(route.id, val)
                    "
                  />
                </div>

                <!-- Amount Knob -->
                <div class="col-1">
                  <audio-knob-component
                    v-model="route.amount"
                    label=""
                    :min="0"
                    :max="100"
                    :step="0.1"
                    :decimals="2"
                    scale="half"
                    @update:model-value="
                      (val) =>
                        handleAmountChangeThrottled(route.id, Number(val))
                    "
                  />
                </div>

                <!-- Modulation Type Selection -->
                <div class="col-2">
                  <q-select
                    v-model="route.modulationType"
                    :options="modulationTypes"
                    label="Type"
                    dense
                    dark
                    filled
                    option-label="label"
                    @update:model-value="
                      (val) => handleModTypeChange(route.id, val)
                    "
                  />
                </div>

                <!-- Modulation Transformation Selection -->
                <div class="col-2">
                  <q-select
                    v-model="route.modulationTransformation"
                    :options="modulationTransformations"
                    label="Transformation"
                    dense
                    dark
                    filled
                    option-label="label"
                    @update:model-value="
                      (val) => handleTransformationChange(route.id, val)
                    "
                  />
                </div>

                <!-- Delete Button -->
                <div class="col-1">
                  <q-btn
                    flat
                    round
                    color="negative"
                    icon="delete"
                    @click="() => removeRoute(route.id)"
                    dense
                  />
                </div>
              </div>
            </div>
          </transition-group>
        </q-card-section>
      </q-card>
    </q-expansion-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import {
  ModulationRouteManager,
  type TargetNode,
} from '../audio/modulation-route-manager';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
  PORT_LABELS,
  VoiceNodeType,
  type ModulationTargetOption,
} from 'src/audio/types/synth-layout';
import {
  ModulationTransformation,
  WasmModulationType,
  type PortId,
} from 'app/public/wasm/audio_processor';
import AudioKnobComponent from './AudioKnobComponent.vue';

//–––––– Props and Store ––––––
interface Props {
  sourceId: number;
  sourceType: VoiceNodeType;
  debug?: boolean;
}
const props = defineProps<Props>();
const store = useAudioSystemStore();

//–––––– Route Manager ––––––
const routeManager = ref<ModulationRouteManager | null>(null);
watch(
  () => props.sourceId,
  (newSourceId) => {
    routeManager.value = new ModulationRouteManager(
      store,
      newSourceId,
      props.sourceType,
    );
  },
  { immediate: true },
);
const isExpanded = ref<boolean>(true);

//–––––– Route Configuration ––––––
interface RouteConfig {
  id: string;
  targetId: number;
  targetNode: TargetNode;
  target: number;
  targetLabel: string;
  amount: number;
  modulationType: { value: WasmModulationType; label: string };
  modulationTransformation: ModulationTransformation;
}
const activeRoutes = ref<RouteConfig[]>([]);
const isLocalUpdate = ref<boolean>(false);

// Computed routes (only those whose target still exists)
const safeActiveRoutes = computed<RouteConfig[]>(() =>
  activeRoutes.value.filter(
    (route) => store.findNodeById(route.targetId) !== null,
  ),
);

//–––––– Helper Functions ––––––
const availableTargetNodes = computed<TargetNode[]>(() =>
  routeManager.value ? routeManager.value.getAvailableTargets() : [],
);
const getAvailableTargets = (): TargetNode[] =>
  routeManager.value ? routeManager.value.getAvailableTargets() : [];
const getSafeParams = (targetId: number): ModulationTargetOption[] => {
  try {
    return routeManager.value && targetId
      ? routeManager.value.getAvailableParams(targetId)
      : [];
  } catch (error) {
    console.warn(`Failed to get params for targetId ${targetId}:`, error);
    return [];
  }
};
const getSafeParam = (
  targetId: number,
  target: number,
): ModulationTargetOption | undefined => {
  try {
    return getSafeParams(targetId).find((p) => p.value === target);
  } catch (error) {
    console.warn(
      `Failed to get param for targetId ${targetId}, target ${target}:`,
      error,
    );
    return undefined;
  }
};

const modulationTypes = ref<{ value: WasmModulationType; label: string }[]>([
  { value: WasmModulationType.VCA, label: 'VCA' },
  { value: WasmModulationType.Bipolar, label: 'Bipolar' },
  { value: WasmModulationType.Additive, label: 'Add' },
]);
const modulationTransformations = ref<
  { value: ModulationTransformation; label: string }[]
>([
  { value: ModulationTransformation.None, label: 'None' },
  { value: ModulationTransformation.Invert, label: 'Invert' },
  { value: ModulationTransformation.Square, label: 'Square' },
  { value: ModulationTransformation.Cube, label: 'Cube' },
]);

// Generic debounce helper
function debounce<T extends unknown[]>(
  func: (...args: T) => void,
  wait: number,
): (...args: T) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (...args: T): void => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => {
      func(...args);
    }, wait);
  };
}
const debouncedInitializeRoutes = debounce(() => {
  if (store.synthLayout?.voices?.length) {
    initializeRoutes();
  } else {
    console.warn('Synth layout not ready yet, waiting...');
    setTimeout(initializeRoutes, 200);
  }
}, 200);

// Watch for external changes
watch(
  [
    () => props.sourceId,
    () => store.synthLayout?.metadata?.stateVersion,
    () => store.synthLayout?.voices?.[0]?.connections?.length,
  ],
  async () => {
    if (isLocalUpdate.value) return;
    await nextTick();
    debouncedInitializeRoutes();
  },
);

// Generate a unique id for routes
function generateUniqueId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
const findRouteIndexById = (id: string): number =>
  activeRoutes.value.findIndex((r) => r.id === id);

//–––––– Handlers ––––––
async function addNewRoute(): Promise<void> {
  if (!routeManager.value) return;
  const availableTargets = routeManager.value.getAvailableTargets();
  if (availableTargets.length === 0) return;
  const defaultTarget = availableTargets[0]!;
  const params = routeManager.value.getAvailableParams(defaultTarget!.id);
  if (params.length === 0) return;
  const defaultParam = params[0]!;
  const defaultModType = routeManager.value.getDefaultModulationType(
    defaultParam.value,
  );
  const newRoute: RouteConfig = {
    id: generateUniqueId(),
    targetId: defaultTarget!.id,
    targetNode: defaultTarget,
    target: defaultParam.value,
    targetLabel: defaultParam.label,
    amount: 1.0,
    modulationType: {
      value: defaultModType,
      label: getModulationTypeLabel(defaultModType),
    },
    modulationTransformation: ModulationTransformation.None,
  };
  try {
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target as PortId,
      amount: newRoute.amount,
      modulationType: defaultModType,
      modulationTransformation: newRoute.modulationTransformation,
    });
    isLocalUpdate.value = true;
    activeRoutes.value.push(newRoute);
    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300);
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
}

async function handleModTypeChange(
  id: string,
  newType: { value: WasmModulationType; label: string },
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1) return;
  const route = activeRoutes.value[index]!;
  try {
    await routeManager.value!.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });
    await routeManager.value!.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: newType.value,
      modulationTransformation: route.modulationTransformation,
    });
    activeRoutes.value[index]!.modulationType = newType;
  } catch (error) {
    console.error('Failed to update modulation type:', error);
  }
}

async function handleTransformationChange(
  id: string,
  newTransformation: { value: ModulationTransformation; label: string },
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1) return;
  const route = activeRoutes.value[index]!;
  try {
    await routeManager.value!.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: newTransformation.value,
      isRemoving: true,
    });
    await routeManager.value!.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: newTransformation.value,
    });
    activeRoutes.value[index]!.modulationTransformation =
      newTransformation.value;
  } catch (error) {
    console.error('Failed to update modulation transformation:', error);
  }
}

async function handleTargetChange(
  id: string,
  newTarget: TargetNode,
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) return;
  const route = activeRoutes.value[index]!;
  const params = routeManager.value.getAvailableParams(newTarget.id);
  if (params.length === 0) return;
  const defaultParam = params[0]!;
  try {
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      isRemoving: true,
      modulationTransformation: route.modulationTransformation,
    });
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: newTarget.id,
      target: defaultParam.value as PortId,
      amount: route.amount,
      modulationType: routeManager.value.getDefaultModulationType(
        defaultParam.value,
      ),
      modulationTransformation: route.modulationTransformation,
    });
    // Update while preserving the same id
    activeRoutes.value[index] = {
      ...route,
      targetId: newTarget.id,
      targetNode: newTarget,
      target: defaultParam.value,
      targetLabel: defaultParam.label,
    };
  } catch (error) {
    console.error('Failed to update target:', error);
  }
}

async function handleParamChange(
  id: string,
  newParam: ModulationTargetOption,
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) return;
  const route = activeRoutes.value[index]!;
  try {
    const oldTarget = route.target;
    const currentModType = route.modulationType;
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: oldTarget as PortId,
      amount: route.amount,
      modulationType: currentModType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam.value as PortId,
      amount: route.amount,
      modulationType: currentModType.value,
      modulationTransformation: route.modulationTransformation,
    });
    activeRoutes.value[index]!.target = newParam.value;
    activeRoutes.value[index]!.targetLabel = newParam.label;
  } catch (error) {
    console.error('Failed to update parameter:', error);
  }
}

async function removeRoute(id: string): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) return;
  const route = activeRoutes.value[index]!;
  try {
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      isRemoving: true,
      modulationTransformation: route.modulationTransformation,
    });
    isLocalUpdate.value = true;
    activeRoutes.value.splice(index, 1);
    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300);
  } catch (error) {
    console.error('Failed to remove route:', error);
  }
}

// Throttling for amount changes (keyed by route id)
interface ThrottleState {
  intervalId: ReturnType<typeof setInterval> | null;
  pending: number | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}
const throttleStates = new Map<string, ThrottleState>();

function handleAmountChangeThrottled(id: string, newAmount: number): void {
  let state = throttleStates.get(id);
  if (!state) {
    state = { intervalId: null, pending: null, timeoutId: null };
    throttleStates.set(id, state);
  }
  state.pending = newAmount;
  if (!state.intervalId) {
    state.intervalId = setInterval(() => {
      if (state!.pending !== null) {
        executeAmountUpdate(id, state!.pending!);
        state!.pending = null;
      }
    }, 100);
  }
  if (state.timeoutId) clearTimeout(state.timeoutId);
  state.timeoutId = setTimeout(() => {
    if (state!.intervalId) {
      clearInterval(state!.intervalId);
      state!.intervalId = null;
    }
    state!.timeoutId = null;
  }, 150);
}

async function executeAmountUpdate(id: string, amount: number): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) return;
  const route = activeRoutes.value[index]!;
  try {
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
    });
    activeRoutes.value[index]!.amount = amount;
  } catch (error) {
    console.error('Failed to update amount:', error);
  }
}

// Clean up throttle timers on unmount
onMounted(() => {
  return () => {
    throttleStates.forEach((state) => {
      if (state.intervalId) clearInterval(state.intervalId);
      if (state.timeoutId) clearTimeout(state.timeoutId);
    });
    throttleStates.clear();
  };
});

onMounted(async () => {
  await nextTick();
  if (!store.synthLayout?.voices?.length) {
    console.warn('Synth layout not ready, waiting...');
    setTimeout(initializeRoutes, 100);
    return;
  }
  initializeRoutes();
});

function getModulationTypeLabel(type: WasmModulationType): string {
  switch (type) {
    case WasmModulationType.VCA:
      return 'VCA';
    case WasmModulationType.Additive:
      return 'Add';
    case WasmModulationType.Bipolar:
      return 'Bipolar';
    default:
      return 'VCA';
  }
}

function initializeRoutes(): void {
  try {
    const connections = store.getNodeConnections(props.sourceId);
    console.log('Raw connections for node:', {
      sourceId: props.sourceId,
      connections: connections?.length ?? 0,
    });
    if (!connections || connections.length === 0) return;
    const filteredConnections = connections
      .filter(
        (conn) =>
          conn.fromId === props.sourceId &&
          store.findNodeById(conn.toId) !== null,
      )
      .reverse();
    if (filteredConnections.length === 0) return;
    const newRoutes: RouteConfig[] = filteredConnections
      .filter((conn) => conn.fromId === props.sourceId)
      .map((conn) => {
        try {
          const targetFromStore = store.findNodeById(conn.toId);
          if (!targetFromStore) return null;
          const targetNode: TargetNode = {
            id: conn.toId,
            name: getNodeName(conn.toId),
            type: getNodeType(conn.toId),
          };
          const existing = activeRoutes.value.find(
            (r) => r.targetId === conn.toId && r.target === (conn.target || 0),
          );
          return {
            id: existing ? existing.id : generateUniqueId(),
            targetId: conn.toId,
            targetNode,
            target: conn.target || 0,
            targetLabel: PORT_LABELS[conn.target] || 'Unknown Parameter',
            amount: typeof conn.amount === 'number' ? conn.amount : 1.0,
            modulationType: {
              value: conn.modulationType ?? WasmModulationType.Additive,
              label: getModulationTypeLabel(
                conn.modulationType ?? WasmModulationType.Additive,
              ),
            },
            modulationTransformation:
              conn.modulationTransformation || ModulationTransformation.None,
          } as RouteConfig;
        } catch (error) {
          console.error('Error mapping connection to route:', error);
          return null;
        }
      })
      .filter((route): route is RouteConfig => route !== null);
    if (JSON.stringify(newRoutes) !== JSON.stringify(activeRoutes.value)) {
      activeRoutes.value = newRoutes;
    }
    console.log('Final routes:', {
      sourceId: props.sourceId,
      routeCount: newRoutes.length,
    });
  } catch (error) {
    console.error('Error initializing routes:', error);
  }
}

function getNodeName(nodeId: number): string {
  const node = store.findNodeById(nodeId);
  if (!node) return `Node ${nodeId}`;
  switch (node.type) {
    case VoiceNodeType.WavetableOscillator:
      return `Wavetable Oscillator ${nodeId}`;
    case VoiceNodeType.Oscillator:
      return `Oscillator ${nodeId}`;
    case VoiceNodeType.Filter:
      return `Filter ${nodeId}`;
    case VoiceNodeType.Envelope:
      return `Envelope ${nodeId}`;
    case VoiceNodeType.LFO:
      return `LFO ${nodeId}`;
    case VoiceNodeType.Mixer:
      return 'Mixer';
    default:
      return `Unknown Node ${nodeId}`;
  }
}

function getNodeType(nodeId: number): VoiceNodeType {
  const node = store.findNodeById(nodeId);
  return node?.type ?? VoiceNodeType.Oscillator;
}
</script>

<style scoped>
.routing-section {
  margin: 1rem 0;
}
.route-item {
  padding: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
:deep(.q-field__label) {
  color: rgba(255, 255, 255, 0.7);
}
:deep(.q-slider__track) {
  background: rgba(255, 255, 255, 0.28);
}
:deep(.q-slider__thumb) {
  background: white;
}
</style>
