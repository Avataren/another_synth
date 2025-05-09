<template>
  <div class="tabs-outer-wrapper">
    <!-- Tabs Wrapper with dynamic max-width -->
    <div class="tabs-wrapper" :style="{ maxWidth: contentWidth + 'px' }">
      <!-- Show real tabs only if there is more than one node -->
      <div v-if="props.nodes.length > 1">
        <q-tabs
          v-model="currentTab"
          dense
          scrollable
          class="tabs-with-spacing q-mb-none"
        >
          <q-tab
            v-for="node in props.nodes"
            :key="node.id"
            :name="node.id.toString()"
            :label="`${nodeLabel} ${node.id}`"
            class="tab"
          />
        </q-tabs>
      </div>
      <!-- If there is only one node, show an empty placeholder that takes up the same height as the tab bar would -->
      <div v-else class="tab-placeholder"></div>
    </div>

    <!-- Panels Wrapper with ref to measure its width -->
    <div class="panels-wrapper" ref="panelWrapper">
      <q-tab-panels
        v-model="currentTab"
        animated
        transition-prev="fade"
        transition-next="fade"
        class="no-margin no-padding no-background"
      >
        <q-tab-panel
          v-for="node in props.nodes"
          :key="`${nodeLabel}-${node.id}-${props.nodes.length}`"
          :name="node.id.toString()"
          class="no-margin no-padding"
          style="overflow: hidden"
        >
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
import { ref, onMounted, watch, nextTick, defineProps } from 'vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { type VoiceNodeType } from 'src/audio/types/synth-layout';

interface Node {
  id: number;
  type?: VoiceNodeType;
}

interface Props {
  nodes: Node[];
  destinationNode: AudioNode | null;
  componentName: unknown;
  nodeLabel: string;
}

const props = defineProps<Props>();
const store = useAudioSystemStore();

const currentTab = ref(props.nodes.length ? props.nodes[0]!.id.toString() : '');
const isMinimized = ref(false);

// Reactive variable to store the width of the panel content
const contentWidth = ref(0);
const panelWrapper = ref<HTMLElement | null>(null);

// After mounting, measure the width of the panel wrapper
onMounted(() => {
  nextTick(() => {
    if (panelWrapper.value) {
      contentWidth.value = panelWrapper.value.offsetWidth;
    }
  });
});

// Adjust current tab when nodes update
watch(
  () => props.nodes.length,
  (newLength, oldLength) => {
    if (newLength === 0) {
      // Handle the case where all nodes are deleted
      console.log('## all nodes deleted');
      currentTab.value = '';
    } else if (oldLength && newLength > oldLength) {
      console.log('## New node added - select it');
      // New node added - select it
      currentTab.value = props.nodes[newLength - 1]!.id.toString();
    } else if (newLength > 0) {
      // Check if current tab exists in the new nodes array
      const tabExists = props.nodes.some(
        (node) => node.id.toString() === currentTab.value,
      );
      if (!tabExists) {
        console.log(
          '## Current tab no longer exists, select the first available node',
        );
        // Current tab no longer exists, select the first available node
        currentTab.value = props.nodes[0]!.id.toString();
      }
      // If current tab still exists, keep it selected
    } else {
      console.log('## All nodes deleted, no tab to select');
    }
  },
  { immediate: true, deep: true },
);

/**
 * Handle the plus click signal from any component.
 */
function handlePlus(nodeType: VoiceNodeType): void {
  store.currentInstrument?.createNode(nodeType);
}

/**
 * Toggle the global minimize state when any child emits a minimize event.
 */
function handleMinimize(): void {
  isMinimized.value = !isMinimized.value;
}

/**
 * Handle the close signal from a child component.
 */
function handleClose(nodeId: number): void {
  console.log('Container received close click:', nodeId);

  // Find the index of the node being deleted
  const nodeIndex = props.nodes.findIndex((node) => node.id === nodeId);

  // Get the ID of a different node to select if this is the currently selected tab
  let nextTabId = '';
  if (currentTab.value === nodeId.toString() && props.nodes.length > 1) {
    // Prefer the next node if available, otherwise the previous one
    const nextNodeIndex = (nodeIndex + 1) % props.nodes.length;
    const nextNode =
      props.nodes[
        nextNodeIndex !== nodeIndex
          ? nextNodeIndex
          : nodeIndex > 0
            ? nodeIndex - 1
            : 0
      ];
    nextTabId = nextNode!.id.toString();
  }

  // Delete the node
  store.currentInstrument?.deleteNode(nodeId);
  store.deleteNodeCleanup(nodeId);

  // Switch to another tab if needed
  if (nextTabId && nextTabId !== currentTab.value) {
    nextTick(() => {
      currentTab.value = nextTabId;
    });
  }
}
</script>

<style scoped>
.tabs-outer-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center; /* centers children horizontally */
}

.tabs-wrapper {
  overflow-x: auto;
  white-space: nowrap;
}

.tab + .tab {
  margin-left: 1rem;
}

.no-margin {
  margin: 0 !important;
}

.no-padding {
  padding: 0 !important;
}

.no-background {
  background: none;
}

.tabs-with-spacing {
  margin-bottom: 0.5rem;
}

.tab-placeholder {
  min-height: 44px;
}

/* Ensure the panels-wrapper does not stretch unnecessarily */
.panels-wrapper {
  display: inline-block;
}
</style>
