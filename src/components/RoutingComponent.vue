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
                  option-value="value"
                  option-label="label"
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
                  @click="
                    () => {
                      console.log('Delete button clicked', index);
                      removeRoute(index);
                    }
                  "
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
import type {
  ModulationTargetOption,
  NodeConnection,
} from 'src/audio/types/synth-layout';
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
  target: ModulationTargetOption;
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
  console.log('Computing availableTargetNodes:', {
    voice,
    sourceId: props.sourceId,
  });

  if (!voice) return nodes;

  for (const type of Object.values(VoiceNodeType)) {
    const typeNodes = voice.nodes[type];
    typeNodes.forEach((node, index) => {
      if (node.id !== props.sourceId) {
        const targetNode = {
          id: node.id,
          name: `${type} ${index + 1}`,
          type: type,
        };
        console.log('Adding target node:', targetNode);
        nodes.push(targetNode);
      }
    });
  }

  return nodes;
});

watch(
  () => [store.synthLayout, ...activeRoutes.value.map((r) => r.targetId)],
  () => {
    console.log('Recomputing nodes due to layout or targetId change');
    const nodes = availableTargetNodes.value;
    activeRoutes.value.forEach((route, idx) => {
      if (!nodes.find((n) => n.id === route.targetId)) {
        console.warn(`Invalid targetId ${route.targetId} for route ${idx}`);
      }
    });
  },
  { deep: true },
);

// Debug route mutations
watch(
  activeRoutes,
  (newRoutes) => {
    console.log('Routes updated:', newRoutes);
  },
  { deep: true },
);

const getAvailableParams = (
  targetId: number | { id: number },
): ModulationTargetOption[] => {
  const id = typeof targetId === 'object' ? targetId.id : Number(targetId);
  console.log('Getting params for target:', {
    id,
    nodes: availableTargetNodes.value,
  });
  const targetNode = availableTargetNodes.value.find((n) => n.id === id);

  if (!targetNode) {
    console.log('Target node not found for id:', id);
    return [];
  }

  const params =
    targetNode.type === VoiceNodeType.Oscillator
      ? [
          { value: ModulationTarget.PhaseMod, label: 'Phase' },
          { value: ModulationTarget.Frequency, label: 'Frequency' },
          { value: ModulationTarget.ModIndex, label: 'Mod Index' },
          { value: ModulationTarget.Gain, label: 'Gain' },
        ]
      : targetNode.type === VoiceNodeType.Filter
        ? [
            { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
            { value: ModulationTarget.FilterResonance, label: 'Resonance' },
          ]
        : [];

  console.log('Returning params:', params);
  return params;
};

interface DebugState {
  lastAction: string;
  timestamp: string;
  storeConnections: NodeConnection[] | null;
  localRoutes: RouteConfig[] | null;
}

const updateDebugState = (action: string) => {
  if (!props.debug) return;

  debugState.value = {
    lastAction: action,
    timestamp: new Date().toISOString(),
    storeConnections: [...store.getNodeConnections(props.sourceId)],
    localRoutes: activeRoutes.value,
  };
};

const handleTargetChange = async (
  index: number,
  newTargetId: number | { id: number },
) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  const targetId =
    typeof newTargetId === 'object' ? newTargetId.id : Number(newTargetId);
  const params = getAvailableParams(targetId);
  const defaultParam = params[0];

  if (!defaultParam) {
    console.error('No params available for target:', targetId);
    return;
  }

  try {
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target.value,
      amount: route.amount,
      isRemoving: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await store.updateConnection({
      fromId: props.sourceId,
      toId: targetId,
      target: defaultParam.value,
      amount: route.amount,
      isRemoving: false,
    });

    route.targetId = targetId;
    route.target = defaultParam;
    route.lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Failed to update target:', error);
  }
};

const handleParamChange = async (
  index: number,
  newParam: ModulationTargetOption,
) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  console.log('Param change:', {
    oldTarget: route.target,
    newParam: newParam,
    index,
  });

  try {
    // Remove old connection
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target.value,
      amount: route.amount,
      isRemoving: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Add new connection
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam.value,
      amount: route.amount,
      isRemoving: false,
    });

    // Update local state last
    route.target = { ...newParam };
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

  // Initialize with proper option object
  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    target: { value: ModulationTarget.PhaseMod, label: 'Phase' }, // Explicit default
    amount: 1.0,
    lastUpdateTime: Date.now(),
  };

  try {
    await store.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target.value,
      amount: newRoute.amount,
    });

    activeRoutes.value.push(newRoute);
    updateDebugState('Route added');
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
};

const removeRoute = async (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target.value,
      amount: route.amount,
      isRemoving: true,
    });

    activeRoutes.value.splice(index, 1);
    updateDebugState('Route removed');
  } catch (error) {
    console.error('Failed to remove route:', error);
  }
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

  activeRoutes.value = connections.map((conn) => {
    const params = getAvailableParams(conn.toId);
    const targetParam = params.find(
      (p) => p.value === getTargetValue(conn.target),
    );
    return {
      targetId: conn.toId,
      target: targetParam || params[0]!,
      amount: conn.amount,
      lastUpdateTime: Date.now(),
    };
  });

  isUpdatingFromExternal.value = false;
  updateDebugState('Mounted');
});

// Watch for external changes
watch(
  () => store.getNodeConnections(props.sourceId),
  (newConnections) => {
    if (isUpdatingFromExternal.value) {
      try {
        const mappedRoutes = newConnections.map((conn) => {
          const params = getAvailableParams(conn.toId);
          const targetParam = params.find(
            (p) => p.value === getTargetValue(conn.target),
          );
          return {
            targetId: conn.toId,
            target: targetParam || params[0]!,
            amount: conn.amount,
            lastUpdateTime: Date.now(),
          };
        });

        activeRoutes.value = mappedRoutes;
        updateDebugState('External update');
      } finally {
        isUpdatingFromExternal.value = false;
      }
    }
  },
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
