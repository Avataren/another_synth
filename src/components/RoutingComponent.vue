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
              <div class="col-5">
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
              <div class="col-5">
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
              <div class="col-1">
                <!-- <amount-slider
                  v-model="route.amount"
                  :min="0"
                  :max="100"
                  :step="0.5"
                  @update:model-value="
                    (val) => handleAmountChange(index, Number(val))
                  "
                /> -->
                <audio-knob-component
                  v-model="route.amount!"
                  label=""
                  :min="0"
                  :max="100"
                  :step="0.1"
                  :decimals="2"
                  scale="half"
                  @update:model-value="
                    (val) => handleAmountChange(index, Number(val))
                  "
                />
              </div>
              <div class="col-4">
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
import {
  WasmModulationType,
  type PortId,
} from 'app/public/wasm/audio_processor';
// import AmountSlider from './AmountSlider.vue';
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

// Add state for expansion control
const isExpanded = ref(true);

interface RouteConfig {
  targetId: number;
  targetNode: TargetNode;
  target: PortId;
  targetLabel: string;
  amount: number;
  modulationType: ModulationTypeOption;
}

interface ModulationTypeOption {
  value: WasmModulationType;
  label: string;
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

  // Get the appropriate default modulation type for this target
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
  };

  try {
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target,
      amount: newRoute.amount,
      modulationType: defaultModType,
    });

    activeRoutes.value.push(newRoute);
  } catch (error) {
    console.error('Failed to add new route:', error);
  }
};

const modulationTypes = ref<ModulationTypeOption[]>([
  { value: WasmModulationType.VCA, label: 'VCA' }, // 0
  { value: WasmModulationType.Bipolar, label: 'Bipolar' }, // 1
  { value: WasmModulationType.Additive, label: 'Add' }, // 2
]);

const handleModTypeChange = async (
  index: number,
  newType: ModulationTypeOption,
) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  try {
    console.log('Setting new modulation type:', {
      newType,
      value: newType.value, // Let's check this value
    });

    // Remove old connection
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: route.modulationType.value,
      isRemoving: true,
    });

    // Add new connection with new type
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      modulationType: newType.value,
    });

    route.modulationType = newType;
  } catch (error) {
    console.error('Failed to update modulation type:', error);
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
    console.log('Parameter change - Starting state:', {
      route,
      newParam,
      currentModType: route.modulationType,
    });

    const oldTarget = route.target as PortId;
    const currentModType = route.modulationType;

    const removeConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: oldTarget,
      amount: route.amount,
      modulationType: currentModType.value,
      isRemoving: true,
    };

    console.log('Removing connection with modType:', removeConnection);
    await routeManager.updateConnection(removeConnection);

    // Add new connection, explicitly preserving the modulation type
    const newConnection: NodeConnectionUpdate = {
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam.value as PortId,
      amount: route.amount,
      modulationType: currentModType.value, // Explicitly keep current mod type
    };

    console.log('Adding new connection with preserved modType:', newConnection);
    await routeManager.updateConnection(newConnection);

    // Update local state
    route.target = newParam.value as PortId;
    route.targetLabel = newParam.label;
    // Explicitly keep the same modulation type
    console.log('Final route state:', route);
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
      modulationType: route.modulationType.value, // Keep current modulation type
      isRemoving: true,
    });

    // Add new connection with new amount
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: newAmount,
      modulationType: route.modulationType.value, // Keep current modulation type
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
          modulationType: {
            value: conn.modulationType || WasmModulationType.VCA,
            label: getModulationTypeLabel(
              conn.modulationType || WasmModulationType.VCA,
            ),
          },
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
