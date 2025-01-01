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
            :disable="!availableTargetOptions.length"
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
                  v-model="route.targetNode"
                  :options="getAvailableTargets(index)"
                  label="Target"
                  dense
                  dark
                  filled
                  option-label="name"
                  @update:model-value="(val) => handleTargetChange(index, val)"
                />
              </div>

              <!-- Parameter Selection -->
              <div class="col-4">
                <q-select
                  v-model="route.target"
                  :options="getAvailableParams(route.targetId, index)"
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
                  @click="() => removeRoute(index)"
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
  targetNode: TargetNode;
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

// Get all target nodes (using voice 0 as reference)
const allTargetNodes = computed((): TargetNode[] => {
  const nodes: TargetNode[] = [];
  const voice = store.synthLayout?.voices[0];

  if (!voice) return nodes;

  for (const type of Object.values(VoiceNodeType)) {
    const typeNodes = voice.nodes[type];
    typeNodes.forEach((node, index) => {
      if (node.id !== props.sourceId) {
        // Format the name based on the node type
        let nodeName = '';
        switch (type) {
          case VoiceNodeType.Oscillator:
            nodeName = `Oscillator ${index + 1}`;
            break;
          case VoiceNodeType.Filter:
            nodeName = `Filter ${index + 1}`;
            break;
          case VoiceNodeType.Envelope:
            nodeName = `Envelope ${index + 1}`;
            break;
          case VoiceNodeType.LFO:
            nodeName = `LFO ${index + 1}`;
            break;
          default:
            nodeName = `${type} ${index + 1}`;
        }
        nodes.push({
          id: node.id,
          name: nodeName,
          type: type,
        });
      }
    });
  }

  return nodes;
});

// Get available target options (filtering out existing routes)
const availableTargetOptions = computed(() => {
  const usedCombinations = new Set(
    activeRoutes.value.map(
      (route) =>
        `${route.targetId}-${isModulationTargetObject(route.target) ? route.target.value : route.target}`,
    ),
  );

  return allTargetNodes.value.filter((node) => {
    const params = getAvailableParamsForType(node.type);
    return params.some(
      (param) => !usedCombinations.has(`${node.id}-${param.value}`),
    );
  });
});

// Helper function to get parameters for a node type
const getAvailableParamsForType = (
  nodeType: VoiceNodeType,
): ModulationTargetOption[] => {
  return nodeType === VoiceNodeType.Oscillator
    ? [
        { value: ModulationTarget.PhaseMod, label: 'Phase' },
        { value: ModulationTarget.Frequency, label: 'Frequency' },
        { value: ModulationTarget.ModIndex, label: 'Mod Index' },
        { value: ModulationTarget.Gain, label: 'Gain' },
      ]
    : nodeType === VoiceNodeType.Filter
      ? [
          { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
          { value: ModulationTarget.FilterResonance, label: 'Resonance' },
        ]
      : [];
};

// Get available targets for a specific route
const getAvailableTargets = (currentIndex: number) => {
  const usedCombinations = new Set(
    activeRoutes.value
      .filter((_, index) => index !== currentIndex)
      .map(
        (route) =>
          `${route.targetId}-${isModulationTargetObject(route.target) ? route.target.value : route.target}`,
      ),
  );

  return allTargetNodes.value.filter((node) => {
    const params = getAvailableParamsForType(node.type);
    return params.some(
      (param) => !usedCombinations.has(`${node.id}-${param.value}`),
    );
  });
};

// Get available parameters for a specific target and route
const getAvailableParams = (
  targetId: number | { id: number },
  currentIndex: number,
): ModulationTargetOption[] => {
  const id = typeof targetId === 'object' ? targetId.id : Number(targetId);
  const targetNode = allTargetNodes.value.find((n) => n.id === id);

  if (!targetNode) return [];

  const usedCombinations = new Set(
    activeRoutes.value
      .filter((_, index) => index !== currentIndex)
      .map(
        (route) =>
          `${route.targetId}-${isModulationTargetObject(route.target) ? route.target.value : route.target}`,
      ),
  );

  const allParams = getAvailableParamsForType(targetNode.type);
  return allParams.filter(
    (param) => !usedCombinations.has(`${id}-${param.value}`),
  );
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

const handleTargetChange = async (index: number, newTarget: TargetNode) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  const targetId = newTarget.id;
  const params = getAvailableParams(targetId, index);
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
      toId: route.targetId,
      target: newParam.value,
      amount: route.amount,
      isRemoving: false,
    });

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
  const defaultTarget = availableTargetOptions.value[0];
  if (!defaultTarget) return;

  const defaultParams = getAvailableParams(
    defaultTarget.id,
    activeRoutes.value.length,
  );
  if (!defaultParams.length) return;

  const defaultParam = defaultParams[0];
  if (!defaultParam) return;

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    targetNode: defaultTarget,
    target: defaultParam,
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

onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);
  isUpdatingFromExternal.value = true;

  activeRoutes.value = connections.map((conn) => {
    const targetNode = allTargetNodes.value.find((n) => n.id === conn.toId);
    if (!targetNode) throw new Error(`Target node not found: ${conn.toId}`);

    const params = getAvailableParamsForType(targetNode.type);
    const targetParam = params.find(
      (p) =>
        p.value ===
        (isModulationTargetObject(conn.target)
          ? conn.target.value
          : conn.target),
    );

    if (!targetParam)
      throw new Error(`Invalid target parameter for node ${conn.toId}`);

    return {
      targetId: conn.toId,
      targetNode,
      target: targetParam,
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
          const targetNode = allTargetNodes.value.find(
            (n) => n.id === conn.toId,
          );
          if (!targetNode)
            throw new Error(`Target node not found: ${conn.toId}`);

          const params = getAvailableParamsForType(targetNode.type);
          const targetParam = params.find(
            (p) =>
              p.value ===
              (isModulationTargetObject(conn.target)
                ? conn.target.value
                : conn.target),
          );

          if (!targetParam)
            throw new Error(`Invalid target parameter for node ${conn.toId}`);

          return {
            targetId: conn.toId,
            targetNode,
            target: targetParam,
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
