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
              <div class="col-4">
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
              <div class="col-4">
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

              <!-- Amount Slider -->
              <div class="col-3">
                <amount-slider
                  v-model="route.amount"
                  :min="0"
                  :max="100"
                  :step="0.5"
                  @update:model-value="
                    (val) => handleAmountChange(index, Number(val))
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
  type VoiceNodeType,
  type ModulationTargetOption,
  type NodeConnectionUpdate,
} from 'src/audio/types/synth-layout';
import { type PortId } from 'app/public/wasm/audio_processor';
import AmountSlider from './AmountSlider.vue';

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

// Add state for expansion control
const isExpanded = ref(true);

interface RouteConfig {
  targetId: number;
  targetNode: TargetNode;
  target: PortId;
  targetLabel: string;
  amount: number;
}

const activeRoutes = ref<RouteConfig[]>([]);

const availableTargetNodes = computed(() => {
  return routeManager.getAvailableTargets();
});

const getAvailableTargets = () => {
  return routeManager.getAvailableTargets();
};

const getAvailableParams = (targetId: number) => {
  return routeManager.getAvailableParams(targetId);
};

const addNewRoute = async () => {
  const availableTargets = routeManager.getAvailableTargets();
  if (!availableTargets.length) {
    console.warn("No available targets that won't create feedback loops");
    return;
  }

  const defaultTarget = availableTargets[0]!;
  const params = routeManager.getAvailableParams(defaultTarget.id);
  if (!params.length) return;

  const defaultParam = params[0];
  if (!defaultParam) return;

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    targetNode: defaultTarget,
    target: defaultParam.value,
    targetLabel: defaultParam.label,
    amount: 1.0,
  };

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target,
      amount: newRoute.amount,
    });

    activeRoutes.value.push(newRoute);
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
};

const handleTargetChange = async (index: number, newTarget: TargetNode) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  const params = routeManager.getAvailableParams(newTarget.id);
  const defaultParam = params[0];
  if (!defaultParam) return;

  try {
    // Remove old connection
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      isRemoving: true,
    });

    // Add new connection
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: newTarget.id,
      target: defaultParam.value,
      amount: route.amount,
    });

    // Update local state
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
) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    // First remove old connection - ensure we have a plain number
    const oldTarget = route.target as PortId; // Current target should already be a PortId

    const removeConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: oldTarget,
      amount: route.amount,
      isRemoving: true,
    };

    console.log('Removing old connection:', removeConnection);
    await routeManager.updateConnection(removeConnection);

    // Add new connection using the value from ModulationTargetOption
    const newTarget = newParam.value as PortId;
    const newConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: newTarget,
      amount: route.amount,
    };

    console.log('Adding new connection:', newConnection);
    await routeManager.updateConnection(newConnection);

    // Update local state
    route.target = newTarget;
    route.targetLabel = newParam.label;

    console.log('Updated route state:', route);
  } catch (error) {
    console.error('Failed to update parameter:', error);
  }
};

const handleAmountChange = async (index: number, newAmount: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    // Remove old connection
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      isRemoving: true,
    });

    // Add new connection with new amount
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: newAmount,
    });

    route.amount = newAmount;
  } catch (error) {
    console.error('Failed to update amount:', error);
  }
};

const removeRoute = async (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    // Create a plain connection object with validated target
    const removeConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: Number(route.target) as PortId, // Convert from proxy to number
      amount: Number(route.amount),
      isRemoving: true,
    };

    await routeManager.updateConnection(removeConnection);
    activeRoutes.value.splice(index, 1);
  } catch (error) {
    console.error('Failed to remove route:', error);
  }
};

onMounted(async () => {
  // Wait a tick for the store to be ready
  await nextTick();

  if (!store.synthLayout?.voices?.length) {
    console.warn('Synth layout not ready, waiting...');
    // Add a small delay to allow layout to initialize
    setTimeout(initializeRoutes, 100);
    return;
  }

  initializeRoutes();
});

const initializeRoutes = () => {
  try {
    const connections = store.getNodeConnections(props.sourceId);
    console.log('Initializing routes:', {
      sourceId: props.sourceId,
      connections: connections,
      availableTargets: routeManager.getAvailableTargets(),
      availableParams: connections.map((conn) =>
        routeManager.getAvailableParams(conn.toId),
      ),
    });

    // Safety check for connections
    if (!connections?.length) {
      console.log('No initial connections found for node:', props.sourceId);
      activeRoutes.value = [];
      return;
    }

    // Map connections to routes with safety checks
    activeRoutes.value = connections
      .map((conn) => {
        // Get available targets
        const availableTargets = routeManager.getAvailableTargets();
        if (!availableTargets?.length) {
          console.warn('No available targets found');
          return null;
        }

        // Find target node
        const targetNode = availableTargets.find((n) => n.id === conn.toId);
        if (!targetNode) {
          console.warn(
            `Target node ${conn.toId} not found in available targets for source ${props.sourceId}`,
          );
          return null;
        }

        // Get parameters and log them
        const params = routeManager.getAvailableParams(conn.toId);
        console.log('Parameters for connection:', {
          targetId: conn.toId,
          availableParams: params,
        });

        const label =
          params.find((p) => p.value === conn.target)?.label ||
          PORT_LABELS[conn.target] ||
          'Unknown Parameter';

        return {
          targetId: conn.toId,
          targetNode,
          target: conn.target,
          targetLabel: label,
          amount: conn.amount,
        };
      })
      .filter((route): route is RouteConfig => route !== null);

    console.log('Initialized routes:', activeRoutes.value);
  } catch (error) {
    console.error('Error initializing routes:', error);
    activeRoutes.value = [];
  }
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
