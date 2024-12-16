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
                  v-model="route.targetId"
                  :options="availableTargetNodes"
                  label="Target"
                  dense
                  dark
                  filled
                  option-value="id"
                  option-label="name"
                  @update:model-value="updateRoute(index)"
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
                  @update:model-value="updateRoute(index)"
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
                  @update:model-value="updateRoute(index)"
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
const getAvailableParams = (targetId: number) => {
  const targetNode = availableTargetNodes.value.find((n) => n.id === targetId);
  if (!targetNode) return [];

  switch (targetNode.type) {
    case VoiceNodeType.Oscillator:
      return [
        { value: ModulationTarget.Frequency, label: 'Frequency' },
        { value: ModulationTarget.PhaseMod, label: 'Phase' },
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

const addNewRoute = () => {
  const defaultTarget = availableTargetNodes.value[0];
  if (!defaultTarget) return;

  const defaultParams = getAvailableParams(defaultTarget.id);
  if (defaultParams.length === 0) return;

  const firstParam = defaultParams[0];
  if (!firstParam) return;

  activeRoutes.value.push({
    targetId: defaultTarget.id,
    target: firstParam.value,
    amount: 0,
  });
};

const removeRoute = (index: number) => {
  const route = activeRoutes.value[index];
  if (!route) return;

  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: 0, // Setting amount to 0 removes the connection
  });

  activeRoutes.value.splice(index, 1);
};

const updateRoute = (index: number) => {
  const route = activeRoutes.value[index];
  if (!route || !store.currentInstrument) return;

  store.updateConnection({
    fromId: props.sourceId,
    toId: route.targetId,
    target: route.target,
    amount: route.amount,
  });
};

// Initialize existing connections on mount
onMounted(() => {
  const connections = store.getNodeConnections(props.sourceId);
  activeRoutes.value = connections.map((conn) => ({
    targetId: conn.toId,
    target: conn.target,
    amount: conn.amount,
  }));
});

// Watch for external connection changes
watch(
  () => store.getNodeConnections(props.sourceId),
  (newConnections) => {
    const currentRoutes = activeRoutes.value.map((route) => ({
      fromId: props.sourceId,
      toId: route.targetId,
      target: route.target,
      amount: route.amount,
    }));

    if (JSON.stringify(currentRoutes) !== JSON.stringify(newConnections)) {
      activeRoutes.value = newConnections.map((conn) => ({
        targetId: conn.toId,
        target: conn.target,
        amount: conn.amount,
      }));
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
