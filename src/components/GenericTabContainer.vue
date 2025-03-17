<template>
  <div class="tabs-container">
    <!-- Show real tabs only if there is more than one node -->
    <div v-if="nodes.length > 1">
      <q-tabs v-model="currentTab" dense class="tabs-with-spacing q-mb-none">
        <q-tab
          v-for="node in nodes"
          :key="node.id"
          :name="node.id.toString()"
          :label="`${nodeLabel} ${node.id}`"
          class="tab"
        />
      </q-tabs>
    </div>

    <!-- If there is only one node, show an empty placeholder that takes up the same height as the tab bar would -->
    <div v-else class="tab-placeholder"></div>

    <!-- Panels to display the corresponding DSP component -->
    <div class="tabs-container">
      <q-tab-panels
        v-model="currentTab"
        animated
        transition-prev="fade"
        transition-next="fade"
        class="no-margin no-padding no-background"
      >
        <q-tab-panel
          v-for="node in nodes"
          :key="node.id"
          :name="node.id.toString()"
          class="no-margin no-padding"
          style="overflow: hidden"
        >
          <!--
            The child component is passed the global minimize state,
            and events from its header (bubbled up from the DSP component)
            are handled by the container.
          -->
          <component
            :is="componentName"
            :node="destinationNode"
            :nodeId="node.id"
            :isMinimized="isMinimized"
            @plusClicked="handlePlus"
            @minimizeClicked="handleMinimize"
            @closeClicked="handleClose"
          />
        </q-tab-panel>
      </q-tab-panels>
    </div>
  </div>
</template>

<script setup lang="ts">
import { type VoiceNodeType } from 'src/audio/types/synth-layout';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { ref, watch, defineProps, type Component } from 'vue';

const store = useAudioSystemStore();

interface Node {
  id: number;
}

const props = defineProps<{
  nodes: Node[];
  destinationNode: AudioNode | null;
  componentName: Component;
  nodeLabel: string;
}>();

// Set initial tab to the first node (if available)
const currentTab = ref(props.nodes.length ? props.nodes[0]!.id.toString() : '');

// Adjust current tab if nodes update
watch(
  () => props.nodes,
  (newNodes) => {
    if (
      newNodes.length &&
      !newNodes.find((n) => n.id.toString() === currentTab.value)
    ) {
      currentTab.value = newNodes[0]!.id.toString();
    }
  },
);

// Global minimize state shared by all child components
const isMinimized = ref(false);

/**
 * Handle the plus click signal from any component.
 */
function handlePlus(nodeType: VoiceNodeType) {
  console.log('Container received plus click:', nodeType);
  // Place any container-level logic for the plus button here.
}

/**
 * Toggle the global minimize state when any child emits a minimize event.
 */
function handleMinimize() {
  isMinimized.value = !isMinimized.value;
  console.log('Container toggled minimize state to', isMinimized.value);
  // Optionally, you could broadcast this state to other parts of your app.
}

/**
 * Handle the close signal from a child component.
 */
function handleClose(node_id: number) {
  console.log('Container received close click:', node_id);
  store.currentInstrument?.deleteNode(node_id);
  // Handle closing the component. For example, you might remove the node from the list.
}
</script>

<style scoped>
.tabs-container {
  margin: 0;
  padding: 0;
  margin-bottom: 1rem;
}

/* Spacing between tabs */
.tab + .tab {
  margin-left: 1rem;
}

/* Remove default margin/padding */
.no-margin {
  margin: 0 !important;
}
.no-padding {
  padding: 0 !important;
}
.no-background {
  background: none;
}

/* Extra bottom spacing for the tab row */
.tabs-with-spacing {
  margin-bottom: 0.5rem;
}

/* Placeholder height for a single tab scenario */
.tab-placeholder {
  min-height: 44px;
}
</style>
