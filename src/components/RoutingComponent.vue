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
            :disable="!availableTargetNodes.length"
          />

          <div
            v-for="(route, index) in activeRoutes"
            :key="`${route.targetId}-${route.target}-${index}`"
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
                  @update:model-value="(val) => handleTargetChange(index, val)"
                />
              </div>

              <!-- Parameter Selection -->
              <div class="col-3">
                <q-select
                  :model-value="
                    getAvailableParams(route.targetId).find(
                      (p) => p.value === route.target,
                    )
                  "
                  :options="getAvailableParams(route.targetId)"
                  :display-value="route.targetLabel"
                  option-label="label"
                  label="Parameter"
                  dense
                  dark
                  filled
                  @update:model-value="(val) => handleParamChange(index, val)"
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
                    (val) => handleAmountChangeThrottled(index, Number(val))
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
                  @update:model-value="(val) => handleModTypeChange(index, val)"
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
                    (val) => handleTransformationChange(index, val)
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
                  @click="() => removeRoute(index)"
                  dense
                />
              </div>
            </div>
          </div>
        </q-card-section>
      </q-card>
    </q-expansion-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import {
  ModulationRouteManager,
  type TargetNode,
} from '../audio/modulation-route-manager';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
  PORT_LABELS,
  VoiceNodeType,
  type ModulationTargetOption,
  type NodeConnectionUpdate,
} from 'src/audio/types/synth-layout';
import {
  ModulationTransformation,
  WasmModulationType,
  type PortId,
} from 'app/public/wasm/audio_processor';
import AudioKnobComponent from './AudioKnobComponent.vue';

interface Props {
  sourceId: number;
  sourceType: VoiceNodeType;
  debug?: boolean;
}

const props = defineProps<Props>();
const store = useAudioSystemStore();
const routeManager = new ModulationRouteManager(
  store,
  props.sourceId,
  props.sourceType,
);

const isExpanded = ref<boolean>(true);

interface ModulationTypeOption {
  value: WasmModulationType;
  label: string;
}

interface ModulationTransformationOption {
  value: ModulationTransformation;
  label: string;
}

interface RouteConfig {
  targetId: number;
  targetNode: TargetNode;
  target: PortId;
  targetLabel: string;
  amount: number;
  modulationType: ModulationTypeOption;
  modulationTransformation: ModulationTransformation;
}

const activeRoutes = ref<RouteConfig[]>([]);

const availableTargetNodes = computed(() => {
  return routeManager.getAvailableTargets();
});

const getAvailableTargets = (): TargetNode[] => {
  return routeManager.getAvailableTargets();
};

const getAvailableParams = (targetId: number): ModulationTargetOption[] => {
  return routeManager.getAvailableParams(targetId);
};

const modulationTypes = ref<ModulationTypeOption[]>([
  { value: WasmModulationType.VCA, label: 'VCA' },
  { value: WasmModulationType.Bipolar, label: 'Bipolar' },
  { value: WasmModulationType.Additive, label: 'Add' },
]);

const modulationTransformations = ref<ModulationTransformationOption[]>([
  { value: ModulationTransformation.None, label: 'None' },
  { value: ModulationTransformation.Invert, label: 'Invert' },
  { value: ModulationTransformation.Square, label: 'Square' },
  { value: ModulationTransformation.Cube, label: 'Cube' },
]);

const addNewRoute = async (): Promise<void> => {
  const availableTargets = routeManager.getAvailableTargets();
  if (!availableTargets.length) {
    console.warn("No available targets that won't create feedback loops");
    return;
  }

  const defaultTarget = availableTargets[0]!;
  const params = routeManager.getAvailableParams(defaultTarget.id);
  if (!params.length) return;

  const defaultParam = params[0]!;
  const defaultModType = routeManager.getDefaultModulationType(
    defaultParam.value,
  );

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    targetNode: defaultTarget,
    target: defaultParam.value,
    targetLabel: defaultParam.label,
    amount: 1.0,
    modulationType: {
      value: defaultModType,
      label: getModulationTypeLabel(defaultModType),
    },
    // Set default modulation transformation to "None"
    modulationTransformation: ModulationTransformation.None,
  };

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target,
      amount: newRoute.amount,
      modulationType: defaultModType,
      modulationTransformation: newRoute.modulationTransformation,
    });
    activeRoutes.value.push(newRoute);
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
};

const handleModTypeChange = async (
  index: number,
  newType: ModulationTypeOption,
): Promise<void> => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });

    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: newType.value,
      modulationTransformation: route.modulationTransformation,
    });

    route.modulationType = newType;
  } catch (error) {
    console.error('Failed to update modulation type:', error);
  }
};

interface ModulationTransformationOption {
  value: ModulationTransformation;
  label: string;
}

const handleTransformationChange = async (
  index: number,
  newTransformationOption: ModulationTransformationOption,
): Promise<void> => {
  const newTransformation = newTransformationOption.value;
  console.log('newTransformation:', newTransformation);
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: newTransformation,
    });
    route.modulationTransformation = newTransformation;
  } catch (error) {
    console.error('Failed to update modulation transformation:', error);
  }
};

const handleTargetChange = async (
  index: number,
  newTarget: TargetNode,
): Promise<void> => {
  const route = activeRoutes.value[index];
  if (!route) return;

  const params = routeManager.getAvailableParams(newTarget.id);
  if (!params.length) return;
  const defaultParam = params[0]!;

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      isRemoving: true,
      modulationTransformation: route.modulationTransformation,
    });

    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: newTarget.id,
      target: defaultParam.value,
      amount: route.amount,
      modulationType: routeManager.getDefaultModulationType(defaultParam.value),
      modulationTransformation: route.modulationTransformation,
    });

    route.targetId = newTarget.id;
    route.targetNode = newTarget;
    route.target = defaultParam.value;
    route.targetLabel = defaultParam.label;
  } catch (error) {
    console.error('Failed to update target:', error);
  }
};

const handleParamChange = async (
  index: number,
  newParam: ModulationTargetOption,
): Promise<void> => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    const oldTarget = route.target;
    const currentModType = route.modulationType;

    const removeConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: oldTarget,
      amount: route.amount,
      modulationType: currentModType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    };

    await routeManager.updateConnection(removeConnection);

    const newConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam.value as PortId,
      amount: route.amount,
      modulationType: currentModType.value,
      modulationTransformation: route.modulationTransformation,
    };

    await routeManager.updateConnection(newConnection);

    route.target = newParam.value as PortId;
    route.targetLabel = newParam.label;
  } catch (error) {
    console.error('Failed to update parameter:', error);
  }
};

const removeRoute = async (index: number): Promise<void> => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    const removeConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: Number(route.target) as PortId,
      amount: Number(route.amount),
      isRemoving: true,
      modulationTransformation: route.modulationTransformation,
    };

    await routeManager.updateConnection(removeConnection);
    activeRoutes.value.splice(index, 1);
  } catch (error) {
    console.error('Failed to remove route:', error);
  }
};

// --- Throttling via Periodic Update ---
interface ThrottleState {
  intervalId: ReturnType<typeof setInterval> | null;
  pending: number | null;
  timeoutId: ReturnType<typeof setTimeout> | null;
}
const throttleStates = new Map<number, ThrottleState>();

const handleAmountChangeThrottled = (
  index: number,
  newAmount: number,
): void => {
  let state = throttleStates.get(index);
  if (!state) {
    state = {
      intervalId: null,
      pending: null,
      timeoutId: null,
    };
    throttleStates.set(index, state);
  }
  state.pending = newAmount;
  if (!state.intervalId) {
    state.intervalId = setInterval(() => {
      if (state!.pending !== null) {
        executeAmountUpdate(index, state!.pending!);
        state!.pending = null;
      }
    }, 100);
  }
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  state.timeoutId = setTimeout(() => {
    if (state!.intervalId) {
      clearInterval(state!.intervalId);
      state!.intervalId = null;
    }
    state!.timeoutId = null;
  }, 150);
};

const executeAmountUpdate = async (
  index: number,
  amount: number,
): Promise<void> => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
      isRemoving: true,
    });
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation,
    });

    route.amount = amount;
  } catch (error) {
    console.error('Failed to update amount:', error);
  }
};

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

const initializeRoutes = (): void => {
  try {
    const connections = store.getNodeConnections(props.sourceId);
    console.log('Raw connections for node:', {
      sourceId: props.sourceId,
      connections: JSON.stringify(connections, null, 2),
    });

    if (!connections?.length) {
      console.log('No initial connections found for node:', props.sourceId);
      activeRoutes.value = [];
      return;
    }

    console.log('Before filtering:', {
      sourceId: props.sourceId,
      outgoingConnections: connections.filter(
        (conn) => conn.fromId === props.sourceId,
      ),
    });

    const routes = connections
      .filter((conn) => conn.fromId === props.sourceId)
      .map((conn) => {
        const targetFromStore = store.findNodeById(conn.toId);
        if (!targetFromStore) {
          console.warn('Target node not found for id: ' + conn.toId);
          return null;
        }
        const targetNode: TargetNode = {
          id: conn.toId,
          name: getNodeName(conn.toId),
          type: getNodeType(conn.toId),
        };

        const route: RouteConfig = {
          targetId: conn.toId,
          targetNode: targetNode,
          target: conn.target,
          targetLabel: PORT_LABELS[conn.target] || 'Unknown Parameter',
          amount: conn.amount,
          modulationType: {
            value: conn.modulationType,
            label: getModulationTypeLabel(conn.modulationType),
          },
          modulationTransformation: conn.modulationTransformation,
        };

        return route;
      })
      .filter((route): route is RouteConfig => route !== null);

    activeRoutes.value = routes;
    console.log('Final routes:', {
      sourceId: props.sourceId,
      routes: JSON.stringify(routes, null, 2),
    });
  } catch (error) {
    console.error('Error initializing routes:', error);
    activeRoutes.value = [];
  }
};

const getNodeName = (nodeId: number): string => {
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
};

const getNodeType = (nodeId: number): VoiceNodeType => {
  const node = store.findNodeById(nodeId);
  return node?.type || VoiceNodeType.Oscillator;
};
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
