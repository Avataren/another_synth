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
                    :key="`param-select-${route.id}-${route.targetId}`"
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
                <q-select
                  :model-value="route.modulationTransformation.value"
                  @update:model-value="
                    (newValueEnum) =>
                      handleTransformationChange(route.id, newValueEnum)
                  "
                  :options="modulationTransformations"
                  label="Transformation"
                  dense
                  dark
                  filled
                  option-value="value"
                  option-label="label"
                  emit-value
                  map-options
                />
                <!-- <div class="col-2">
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
                </div> -->

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
// Note: modulationTransformation is now stored as an object.
interface RouteConfig {
  id: string;
  targetId: number;
  targetNode: TargetNode;
  target: number;
  targetLabel: string;
  amount: number;
  modulationType: { value: WasmModulationType; label: string };
  modulationTransformation: { value: ModulationTransformation; label: string };
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
    console.log('debouncedInitializeRoutes');
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
  const params = routeManager.value.getAvailableParams(defaultTarget.id);
  if (params.length === 0) return;
  const defaultParam = params[0]!;
  const defaultModType = routeManager.value.getDefaultModulationType(
    defaultParam.value,
  );
  const newRoute: RouteConfig = {
    id: generateUniqueId(),
    targetId: defaultTarget.id,
    targetNode: defaultTarget,
    target: defaultParam.value,
    targetLabel: defaultParam.label,
    amount: 1.0,
    modulationType: {
      value: defaultModType,
      label: getModulationTypeLabel(defaultModType),
    },
    modulationTransformation: {
      value: ModulationTransformation.None,
      label: 'None',
    },
  };
  try {
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: newRoute.targetId,
      target: newRoute.target as PortId,
      amount: newRoute.amount,
      modulationType: defaultModType,
      modulationTransformation: newRoute.modulationTransformation.value,
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
  if (index === -1 || !routeManager.value) return; // Added check for routeManager
  const route = activeRoutes.value[index]!;

  // --- Read the transformation value ONCE ---
  const currentTransformValue = route.modulationTransformation.value;
  console.log(
    `handleModTypeChange - Using transform value: ${currentTransformValue} (type: ${typeof currentTransformValue}) for route ${id}`,
  );

  // Ensure it's a number before proceeding (optional but safe)
  if (typeof currentTransformValue !== 'number') {
    console.error(
      `Invalid modulationTransformation value type for route ${id}:`,
      currentTransformValue,
    );

    return;
  }

  try {
    isLocalUpdate.value = true; // Set flag to potentially ignore watcher updates

    // --- First Update (Remove) ---
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value, // Use OLD type for removal consistency
      modulationTransformation: currentTransformValue, // Use the value read at the start
      isRemoving: true,
    });

    // --- Second Update (Add) ---
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: newType.value, // Use NEW type
      modulationTransformation: currentTransformValue, // Use the SAME value read at the start
    });

    // --- Update Local State AFTER both store updates ---
    activeRoutes.value[index] = {
      ...route, // Spread the existing route to keep other properties
      modulationType: newType, // Update only the modulation type object
    };

    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300); // Reset flag after a delay
  } catch (error) {
    console.error('Failed to update modulation type:', error);
    isLocalUpdate.value = false; // Ensure flag is reset on error too
  }
}

async function handleTransformationChange(
  id: string,
  newValueEnum: ModulationTransformation, // Now receives the enum value directly
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1) return;

  // Find the full option object {value, label} corresponding to the selected enum value
  const newTransformationObject = modulationTransformations.value.find(
    (opt) => opt.value === newValueEnum,
  );

  if (!newTransformationObject) {
    console.error(
      'Could not find transformation object for value:',
      newValueEnum,
    );
    return; // Should not happen if options are correct
  }

  const route = activeRoutes.value[index]!;
  try {
    isLocalUpdate.value = true;

    // --- Send update to store/WASM ---
    // You still need to send the enum value here
    await routeManager.value!.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: route.amount,
      modulationType: route.modulationType.value,
      modulationTransformation: newValueEnum,
    });
    // --- Update Local State ---
    // Update the local state with the full object found earlier
    activeRoutes.value[index]!.modulationTransformation =
      newTransformationObject;

    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300);
  } catch (error) {
    console.error('Failed to update modulation transformation:', error);
    // Optionally revert local state change if store update fails
    // activeRoutes.value[index]!.modulationTransformation = route.modulationTransformation; // Revert
  }
}

// async function handleTransformationChange(
//   id: string,
//   newTransformation: { value: ModulationTransformation; label: string },
// ): Promise<void> {
//   const index = findRouteIndexById(id);
//   if (index === -1) return;
//   const route = activeRoutes.value[index]!;
//   try {
//     isLocalUpdate.value = true;
//     // Remove the existing connection with the new transformation value
//     await routeManager.value!.updateConnection({
//       fromId: props.sourceId,
//       toId: route.targetId,
//       target: route.target as PortId,
//       amount: route.amount,
//       modulationType: route.modulationType.value,
//       modulationTransformation: newTransformation.value,
//       isRemoving: true,
//     });
//     // Add the new connection with the updated transformation
//     await routeManager.value!.updateConnection({
//       fromId: props.sourceId,
//       toId: route.targetId,
//       target: route.target as PortId,
//       amount: route.amount,
//       modulationType: route.modulationType.value,
//       modulationTransformation: newTransformation.value,
//     });
//     // Update the local state with the full object
//     activeRoutes.value[index]!.modulationTransformation = newTransformation;
//     setTimeout(() => {
//       isLocalUpdate.value = false;
//     }, 300);
//   } catch (error) {
//     console.error('Failed to update modulation transformation:', error);
//   }
// }

async function handleTargetChange(
  id: string,
  newTarget: TargetNode, // The full TargetNode object selected from the first dropdown
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) {
    console.error('Route or Route Manager not found for target change.');
    return;
  }

  const route = activeRoutes.value[index]!; // Get current route state
  console.log(
    `--- handleTargetChange START (Resetting Param) --- Route ID: ${id}, New Target: ${newTarget.name} (ID: ${newTarget.id})`,
  );

  // --- 1. Capture necessary values BEFORE async operations ---
  const currentAmount = route.amount;
  const currentModTransform = route.modulationTransformation; // Keep object for local update
  const currentModTransformValue = currentModTransform.value; // Numeric value for sending
  const originalModType = route.modulationType; // Keep object for local update & sending
  const originalModTypeValue = originalModType.value; // Numeric value for sending
  const oldTargetId = route.targetId;
  const oldTargetPort = route.target as PortId; // Assert type for removal function

  // --- 2. Get available parameters for the NEW target ---
  let newTargetParams: ModulationTargetOption[] = [];
  try {
    newTargetParams = routeManager.value.getAvailableParams(newTarget.id);
    if (newTargetParams.length === 0) {
      console.warn(
        `No parameters available for new target ${newTarget.id}. Cannot change target.`,
      );
      // Optional: Decide if you want to prevent the change or proceed without a valid param
      return; // Prevent change if no params exist for the new target
    }
  } catch (error) {
    console.error(
      `Error getting params for new target ${newTarget.id}:`,
      error,
    );
    return; // Stop if params can't be fetched
  }

  // --- 3. Determine the DEFAULT parameter for the new target ---
  const defaultParamOption = newTargetParams[0]!; // Directly take the first one
  const defaultParamValue = Number(defaultParamOption.value); // Ensure it's a number

  // Validate the default parameter's value
  if (isNaN(defaultParamValue)) {
    console.error(
      'FATAL: Default parameter value is not a valid number!',
      defaultParamOption,
    );
    return;
  }
  console.log(
    `Using default parameter for new target: ${defaultParamOption.label} (${defaultParamValue})`,
  );

  // --- 4. Perform Backend Updates (Remove old, Add new) ---
  try {
    isLocalUpdate.value = true; // Prevent potential watcher interference

    // Remove old connection (using captured old IDs/values)
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: oldTargetId,
      target: oldTargetPort, // Asserted as PortId above
      amount: currentAmount, // Use captured value
      modulationTransformation: currentModTransformValue, // Use captured value
      isRemoving: true,
      modulationType: originalModTypeValue, // Use captured value
    });

    // Add new connection (using new target ID and its default param ID)
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: newTarget.id, // Use NEW target ID
      target: defaultParamValue as PortId, // Use DEFAULT param value (asserted as PortId)
      amount: currentAmount, // Use captured value
      modulationType: originalModTypeValue, // Use captured value (preserved)
      modulationTransformation: currentModTransformValue, // Use captured value (preserved)
    });

    // --- 5. Update Local Vue State ---
    // This update is crucial for the UI to react correctly.
    // We update the targetId, targetNode, target (PortId), and targetLabel.
    // The Parameter Select's options will re-render based on the new targetId.
    // The Parameter Select's displayed value will update based on the new target (PortId).
    activeRoutes.value[index] = {
      ...route, // Keep existing id, etc.
      targetId: newTarget.id, // Update Target ID
      targetNode: newTarget, // Update Target Node object
      target: defaultParamValue, // Update selected Parameter ID (to default)
      targetLabel: defaultParamOption.label, // Update selected Parameter Label (to default)
      // Preserve other properties
      amount: currentAmount,
      modulationType: originalModType,
      modulationTransformation: currentModTransform,
    };

    console.log(
      'Local state updated for route:',
      id,
      activeRoutes.value[index],
    );

    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300);
  } catch (error) {
    console.error(`Failed to update target connection for route ${id}:`, error);
    isLocalUpdate.value = false; // Ensure flag is reset on error
  } finally {
    console.log(`--- handleTargetChange END --- Route ID: ${id}`);
  }
}

async function handleParamChange(
  id: string,
  newParam: ModulationTargetOption, // This comes directly from the select options, should be { label, value }
): Promise<void> {
  const index = findRouteIndexById(id);
  if (index === -1 || !routeManager.value) {
    console.error('Route or Route Manager not found for param change.');
    return;
  }

  const route = activeRoutes.value[index]!; // Get current route state
  console.log(
    `--- handleParamChange START --- Route ID: ${id}, New Param: ${newParam.label} (${newParam.value})`,
  );

  // --- Capture necessary values BEFORE async operations ---
  const currentTargetId = route.targetId;
  const currentAmount = route.amount;
  const currentModType = route.modulationType; // Keep object
  const currentModTypeValue = currentModType.value; // Get numeric value
  const currentModTransform = route.modulationTransformation; // *** CAPTURE THIS ***
  const currentModTransformValue = currentModTransform.value; // *** GET ITS VALUE ***
  const oldTargetPort = route.target as PortId; // The specific parameter port being changed

  // --- Pre-check captured types ---
  // *** ADD CHECK FOR MOD TRANSFORM VALUE ***
  if (
    typeof currentModTypeValue !== 'number' ||
    typeof currentModTransformValue !== 'number'
  ) {
    // Log the specific error source
    console.error(
      `handleParamChange: Invalid value type for route ${id}. ModType: ${typeof currentModTypeValue}, ModTransform: ${typeof currentModTransformValue}`,
    );
    return;
  }

  // Ensure the new parameter value is a number
  const newParamValue = Number(newParam.value);
  if (isNaN(newParamValue)) {
    console.error(
      `handleParamChange: New parameter value "${newParam.value}" is not a valid number.`,
    );
    return;
  }

  try {
    isLocalUpdate.value = true;

    // --- First Update (Remove old connection based on old parameter) ---
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: currentTargetId,
      target: oldTargetPort, // Use OLD parameter port from capture
      amount: currentAmount,
      modulationType: currentModTypeValue, // Use captured type value
      modulationTransformation: currentModTransformValue, // *** USE CAPTURED TRANSFORM VALUE ***
      isRemoving: true,
    });

    // --- Second Update (Add new connection with new parameter) ---
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: currentTargetId,
      target: newParamValue as PortId, // Use NEW parameter value (numeric)
      amount: currentAmount,
      modulationType: currentModTypeValue, // Keep the existing modulation type value
      modulationTransformation: currentModTransformValue, // *** USE CAPTURED TRANSFORM VALUE ***
    });

    // --- Update Local State AFTER both store updates ---
    // Update only the changed parameter properties directly for reactivity
    activeRoutes.value[index]!.target = newParamValue; // Update numeric PortId
    activeRoutes.value[index]!.targetLabel = newParam.label; // Update label
    // Note: Amount, ModType object, and ModTransform object remain unchanged here.

    console.log(
      'Local state updated for route:',
      id,
      activeRoutes.value[index],
    );

    setTimeout(() => {
      isLocalUpdate.value = false;
    }, 300);
  } catch (error) {
    console.error(`Failed to update parameter for route ${id}:`, error);
    isLocalUpdate.value = false; // Ensure flag is reset on error
  } finally {
    console.log(`--- handleParamChange END --- Route ID: ${id}`);
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
      modulationTransformation: route.modulationTransformation.value,
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
      modulationTransformation: route.modulationTransformation.value,
      isRemoving: true,
    });
    await routeManager.value.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target as PortId,
      amount: amount,
      modulationType: route.modulationType.value,
      modulationTransformation: route.modulationTransformation.value,
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
          console.log(
            'conn.modulationTransformation',
            conn.modulationTransformation,
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
            modulationTransformation: {
              value: conn.modulationTransformation,
              label:
                modulationTransformations.value.find(
                  (opt) => opt.value === conn.modulationTransformation,
                )?.label || 'None',
            },
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
    case VoiceNodeType.Noise:
      return `Noise ${nodeId}`;
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
