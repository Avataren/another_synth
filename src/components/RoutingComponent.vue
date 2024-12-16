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
          />

          <div
            v-for="(route, index) in activeRoutes"
            :key="index"
            class="route-item q-mb-sm"
          >
            <div class="row q-col-gutter-sm items-center">
              <!-- Target Node Selection -->
              <div class="col-4">
                <q-select
                  :model-value="route.targetId"
                  @update:model-value="
                    (val) => updateRoute(index, { targetId: val })
                  "
                  :options="availableTargetNodes"
                  label="Target"
                  dense
                  dark
                  filled
                  option-value="id"
                  option-label="name"
                />
              </div>

              <!-- Parameter Selection -->
              <div class="col-4">
                <q-select
                  :model-value="route.target"
                  @update:model-value="
                    (val) => updateRoute(index, { target: val })
                  "
                  :options="getAvailableParams(route.targetId)"
                  label="Parameter"
                  dense
                  dark
                  filled
                />
              </div>

              <!-- Amount Slider -->
              <div class="col-3">
                <q-slider
                  :model-value="route.amount"
                  @update:model-value="
                    (val) => updateRoute(index, { amount: val ?? 0 })
                  "
                  :min="-1"
                  :max="1"
                  :step="0.01"
                  label
                  label-always
                  dark
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
        </q-card-section>
      </q-card>
    </q-expansion-item>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import type { ModulationTargetOption } from 'src/audio/types/synth-layout';
import { ModulationTarget, VoiceNodeType } from 'src/audio/types/synth-layout';

interface Props {
  sourceId: number;
}

interface TargetNode {
  id: number;
  name: string;
  type: VoiceNodeType;
}

interface RouteConfig {
  targetId: number;
  target: ModulationTarget;
  amount: number;
}

type RouteUpdate = {
  targetId?: number | TargetNode;
  target?: ModulationTarget | ModulationTargetOption;
  amount?: number;
};

const props = defineProps<Props>();
const store = useAudioSystemStore();
const activeRoutes = ref<RouteConfig[]>([]);

// Get all available target nodes (using voice 0 as reference)
const availableTargetNodes = computed((): TargetNode[] => {
  const nodes: TargetNode[] = [];
  const voice = store.synthLayout?.voices[0];
  if (!voice) return nodes;

  // Get all nodes in the voice
  for (const type of Object.values(VoiceNodeType)) {
    const typeNodes = voice.nodes[type];
    typeNodes.forEach((node, index) => {
      // Don't include self as target
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

// Get available parameters based on target node type
const getAvailableParams = (targetId: number): ModulationTargetOption[] => {
  const targetNode = availableTargetNodes.value.find((n) => n.id === targetId);
  if (!targetNode) {
    console.log('No target node found for id:', targetId);
    return [];
  }

  let params: ModulationTargetOption[];
  switch (targetNode.type) {
    case VoiceNodeType.Oscillator:
      params = [
        { value: ModulationTarget.Frequency, label: 'Frequency' },
        { value: ModulationTarget.PhaseMod, label: 'Phase' },
        { value: ModulationTarget.ModIndex, label: 'Mod Index' },
        { value: ModulationTarget.Gain, label: 'Gain' },
      ];
      break;
    case VoiceNodeType.Filter:
      params = [
        { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
        { value: ModulationTarget.FilterResonance, label: 'Resonance' },
      ];
      break;
    default:
      params = [];
  }

  return params;
};

const applyConnection = (route: RouteConfig) => {
  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: route.amount,
  });
};

const updateRoute = (index: number, update: RouteUpdate) => {
  const oldRoute = activeRoutes.value[index];
  if (!oldRoute) return;

  // Make a fully-defined copy of oldRoute
  const updatedRoute: RouteConfig = {
    targetId: oldRoute.targetId,
    target: oldRoute.target,
    amount: oldRoute.amount,
  };

  // Flags to indicate what changed
  let targetChanged = false;
  let parameterChanged = false;

  // Check if we are changing the target node
  if (update.targetId !== undefined) {
    const newTargetId =
      typeof update.targetId === 'object'
        ? update.targetId.id
        : update.targetId;

    if (newTargetId !== oldRoute.targetId) {
      updatedRoute.targetId = newTargetId;
      targetChanged = true;

      // If the target node changes, ensure parameter is still valid
      const params = getAvailableParams(newTargetId);
      if (
        params.length > 0 &&
        !params.some((p) => p.value === updatedRoute.target)
      ) {
        updatedRoute.target = params[0]!.value;
        parameterChanged = true; // Because we changed to a default parameter
      }
    }
  }

  // Check if we are changing the parameter/target itself
  if (update.target !== undefined) {
    const newTargetValue =
      typeof update.target === 'number' ? update.target : update.target.value;

    if (newTargetValue !== oldRoute.target) {
      updatedRoute.target = newTargetValue;
      parameterChanged = true;
    }
  }

  // Update the amount if provided
  if (update.amount !== undefined) {
    updatedRoute.amount = update.amount;
  }

  // If we changed target node or parameter, remove the old connection
  // before adding the new one
  const connectionChanged = targetChanged || parameterChanged;
  if (connectionChanged) {
    // Remove old connection
    store.updateConnection({
      fromId: props.sourceId,
      toId: oldRoute.targetId,
      target: oldRoute.target,
      amount: 0,
      isRemoving: true,
    });
  }

  // Now assign the updated route back
  activeRoutes.value[index] = updatedRoute;

  // Finally, add or update the connection to reflect the changes
  store.updateConnection({
    fromId: props.sourceId,
    toId: updatedRoute.targetId,
    target: updatedRoute.target,
    amount: updatedRoute.amount,
  });
};

const addNewRoute = () => {
  const defaultTarget = availableTargetNodes.value[0];
  if (!defaultTarget) return;

  const defaultParams = getAvailableParams(defaultTarget.id);
  if (defaultParams.length === 0) return;

  const firstParam = defaultParams[0];
  if (!firstParam) return;

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    target: firstParam.value,
    amount: 0.0001, // Start with tiny amount instead of 0
  };

  // Add to active routes
  activeRoutes.value.push(newRoute);

  // Create the connection
  applyConnection(newRoute);
};

const removeRoute = (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  // Remove from local state first
  activeRoutes.value.splice(index, 1);

  // Then remove from store with explicit removal flag
  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: 0,
    isRemoving: true,
  });
};

// Initialize existing connections on mount
onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);
  activeRoutes.value = connections.map((conn) => ({
    targetId: conn.toId,
    target:
      typeof conn.target === 'number'
        ? conn.target
        : (conn.target as ModulationTargetOption).value,
    amount: conn.amount,
  }));
});

// Watch for external connection changes
watch(
  () => store.getNodeConnections(props.sourceId),
  (newConnections) => {
    const getTargetValue = (
      target: ModulationTarget | ModulationTargetOption,
    ): ModulationTarget => {
      return typeof target === 'number' ? target : target.value;
    };

    // Update routes without triggering new connections
    activeRoutes.value = newConnections.map((conn) => ({
      targetId: conn.toId,
      target: getTargetValue(conn.target),
      amount: conn.amount,
    }));
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
