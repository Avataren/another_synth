<template>
  <div class="routing-section">
    <q-expansion-item
      group="routing"
      icon="share"
      label="Modulation Routing"
      header-class="bg-dark text-white"
      dark
      expand-icon-class="text-white"
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
              <div class="col-4">
                <q-select
                  v-model="route.targetId"
                  :options="availableTargetNodes"
                  label="Target"
                  dense
                  dark
                  filled
                  option-value="id"
                  option-label="name"
                  @update:model-value="(val) => handleTargetChange(index, val)"
                />
              </div>

              <!-- Parameter Selection -->
              <div class="col-4">
                <q-select
                  v-model="route.target"
                  :options="getAvailableParams(route.targetId)"
                  label="Parameter"
                  dense
                  dark
                  filled
                  @update:model-value="(val) => handleParamChange(index, val)"
                />
              </div>

              <!-- Amount Slider -->
              <div class="col-3">
                <q-slider
                  v-model="route.amount"
                  :min="-1"
                  :max="1"
                  :step="0.01"
                  label
                  label-always
                  dark
                  @change="(val) => handleAmountChange(index, val)"
                />
              </div>

              <!-- Delete Button -->
              <div class="col-1">
                <q-btn
                  flat
                  round
                  color="negative"
                  icon="delete"
                  @click="removeRoute(index)"
                  dense
                />
              </div>
            </div>
          </div>

          <!-- Debug Section -->
          <div v-if="debug" class="debug-info q-mt-md text-grey-5">
            <pre>{{ JSON.stringify(debugState, null, 2) }}</pre>
          </div>
        </q-card-section>
      </q-card>
    </q-expansion-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import type { ModulationTargetOption } from 'src/audio/types/synth-layout';
import {
  isModulationTargetObject,
  ModulationTarget,
  VoiceNodeType,
} from 'src/audio/types/synth-layout';

interface Props {
  sourceId: number;
  debug?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  debug: false,
});

interface TargetNode {
  id: number;
  name: string;
  type: VoiceNodeType;
}

interface RouteConfig {
  targetId: number;
  target: ModulationTarget;
  amount: number;
  lastUpdateTime?: number;
}

const store = useAudioSystemStore();
const activeRoutes = ref<RouteConfig[]>([]);
const isUpdatingFromExternal = ref(false);
const debugState = ref<DebugState>({
  lastAction: '',
  timestamp: '',
  storeConnections: null,
  localRoutes: null,
});

// Get all available target nodes (using voice 0 as reference)
const availableTargetNodes = computed((): TargetNode[] => {
  const nodes: TargetNode[] = [];
  const voice = store.synthLayout?.voices[0];
  if (!voice) return nodes;

  for (const type of Object.values(VoiceNodeType)) {
    const typeNodes = voice.nodes[type];
    typeNodes.forEach((node, index) => {
      if (node.id !== props.sourceId) {
        nodes.push({
          id: node.id,
          name: `${type} ${index + 1}`,
          type: type,
        });
      }
    });
  }

  return nodes;
});

const getAvailableParams = (targetId: number): ModulationTargetOption[] => {
  const targetNode = availableTargetNodes.value.find((n) => n.id === targetId);
  if (!targetNode) return [];

  switch (targetNode.type) {
    case VoiceNodeType.Oscillator:
      return [
        { value: ModulationTarget.Frequency, label: 'Frequency' },
        { value: ModulationTarget.PhaseMod, label: 'Phase' },
        { value: ModulationTarget.ModIndex, label: 'Mod Index' },
        { value: ModulationTarget.Gain, label: 'Gain' },
      ];
    case VoiceNodeType.Filter:
      return [
        { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
        { value: ModulationTarget.FilterResonance, label: 'Resonance' },
      ];
    default:
      return [];
  }
};

interface DebugState {
  lastAction: string;
  timestamp: string;
  storeConnections: Array<{
    fromId: number;
    toId: number;
    target: ModulationTarget | ModulationTargetOption;
    amount: number;
    isRemoving?: boolean;
  }> | null;
  localRoutes: RouteConfig[] | null;
}

const updateDebugState = (action: string) => {
  if (!props.debug) return;

  debugState.value = {
    lastAction: action,
    timestamp: new Date().toISOString(),
    storeConnections: store.getNodeConnections(props.sourceId),
    localRoutes: activeRoutes.value,
  };
};

const handleTargetChange = (index: number, newTargetId: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  // Remove old connection first
  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: 0,
    isRemoving: true,
  });

  // Update route with new target and valid parameter
  const params = getAvailableParams(newTargetId);
  route.targetId = newTargetId;
  route.target = params[0]?.value ?? route.target;
  route.lastUpdateTime = Date.now();

  // Create new connection
  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: route.amount,
  });

  updateDebugState('Target changed');
};

const handleParamChange = async (index: number, newParam: ModulationTarget) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    // Create a new connection rather than modifying existing
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam,
      amount: route.amount,
      // Don't include modifyExisting flag here - we want a new connection
    });

    route.target = newParam;
    route.lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Failed to update parameter:', error);
  }
};

const handleAmountChange = async (index: number, newAmount: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    const normalizedTarget = isModulationTargetObject(route.target)
      ? route.target.value
      : route.target;

    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: normalizedTarget,
      amount: newAmount,
    });

    route.amount = newAmount;
    route.lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Failed to update modulation:', error);
  }
};

const addNewRoute = async () => {
  const defaultTarget = availableTargetNodes.value[0];
  if (!defaultTarget) return;

  const defaultParams = getAvailableParams(defaultTarget.id);
  if (!defaultParams.length) return;

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    target: defaultParams[0]!.value,
    amount: 0,
    lastUpdateTime: Date.now(),
  };

  try {
    await store.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target,
      amount: newRoute.amount,
    });

    activeRoutes.value.push(newRoute);
    updateDebugState('Route added');
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
};

const removeRoute = (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  // Remove from local state
  activeRoutes.value.splice(index, 1);

  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: route.amount,
    isRemoving: true,
  });
  updateDebugState('Route removed');
};

const getTargetValue = (
  target: ModulationTarget | ModulationTargetOption,
): ModulationTarget => {
  if (typeof target === 'number') {
    return target;
  }
  return (target as ModulationTargetOption).value;
};

onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);
  isUpdatingFromExternal.value = true;
  activeRoutes.value = connections.map((conn) => ({
    targetId: conn.toId,
    target: getTargetValue(conn.target),
    amount: conn.amount,
    lastUpdateTime: Date.now(),
  }));
  isUpdatingFromExternal.value = false;
  updateDebugState('Mounted');
});

// Watch for external changes
watch(
  () => store.getNodeConnections(props.sourceId),
  (newConnections) => {
    // Only update if this is an external change (from WASM)
    if (isUpdatingFromExternal.value) {
      try {
        const mappedRoutes = newConnections.map((conn) => ({
          targetId: conn.toId,
          target: getTargetValue(conn.target),
          amount: conn.amount,
          lastUpdateTime: Date.now(),
        }));

        activeRoutes.value = mappedRoutes;
        updateDebugState('External update');
      } finally {
        isUpdatingFromExternal.value = false;
      }
    }
  },
  { deep: true },
);
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

.debug-info {
  font-family: monospace;
  font-size: 0.8em;
  white-space: pre-wrap;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
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
