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
            :key="`${route.targetId}-${route.target.value}-${index}`"
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
                  v-model="route.target"
                  :options="getAvailableParams(route.targetId)"
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
import { ref, computed, onMounted } from 'vue';
import {
  ModulationRouteManager,
  type TargetNode,
} from '../audio/modulation-route-manager';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import type { ModulationTargetOption } from 'src/audio/types/synth-layout';
import { isModulationTargetObject } from 'src/audio/types/synth-layout';

interface Props {
  sourceId: number;
}

const props = defineProps<Props>();
const store = useAudioSystemStore();
const routeManager = new ModulationRouteManager(store, props.sourceId);

interface RouteConfig {
  targetId: number;
  targetNode: TargetNode;
  target: ModulationTargetOption;
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
  const defaultTarget = availableTargetNodes.value[0];
  if (!defaultTarget) return;

  const params = routeManager.getAvailableParams(defaultTarget.id);
  if (!params.length) return;

  const defaultParam = params[0];
  if (!defaultParam) return;

  const newRoute: RouteConfig = {
    targetId: defaultTarget.id,
    targetNode: defaultTarget,
    target: defaultParam,
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
      target: defaultParam,
      amount: route.amount,
    });

    // Update local state
    route.targetId = newTarget.id;
    route.targetNode = newTarget;
    route.target = defaultParam;
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

  console.log('Starting param change:', {
    fromId: props.sourceId,
    toId: route.targetId,
    target: newParam.value,
    amount: route.amount,
  });

  try {
    await store.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: newParam.value, // Pass the enum value directly
      amount: route.amount,
    });
    route.target = newParam;
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
    await routeManager.updateConnection({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
      isRemoving: true,
    });

    activeRoutes.value.splice(index, 1);
  } catch (error) {
    console.error('Failed to remove route:', error);
  }
};

onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);

  activeRoutes.value = connections.map((conn) => {
    const targetNode = routeManager
      .getAvailableTargets()
      .find((n) => n.id === conn.toId);
    if (!targetNode) throw new Error(`Target node not found: ${conn.toId}`);

    const target = isModulationTargetObject(conn.target)
      ? conn.target
      : {
          value: conn.target,
          label:
            routeManager
              .getAvailableParams(conn.toId)
              .find((p) => p.value === conn.target)?.label || 'Unknown',
        };

    return {
      targetId: conn.toId,
      targetNode,
      target,
      amount: conn.amount,
    };
  });
});
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
