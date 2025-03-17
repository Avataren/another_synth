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

    <!-- If there is only one node, show an empty placeholder 
           that takes up the same height as the tab bar would -->
    <div v-else class="tab-placeholder"></div>

    <!-- Panels to display the corresponding DSP component -->
    <div class="tabs-container">
      <!-- your tab header logic -->
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
          <component
            :is="componentName"
            :node="destinationNode"
            :nodeId="node.id"
          />
        </q-tab-panel>
      </q-tab-panels>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, defineProps, type Component } from 'vue';

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
</script>

<style scoped>
.tabs-container {
  margin: 0;
  padding: 0;
}

/* If you want a bit of spacing between tabs themselves: */
.tab + .tab {
  margin-left: 1rem;
}

/* Eliminate Quasar’s default margin/padding for tight alignment */
.no-margin {
  margin: 0 !important;
}
.no-padding {
  padding: 0 !important;
}
.no-background {
  background: none;
}

/* A bit of extra bottom spacing for the tab row (optional) */
.tabs-with-spacing {
  margin-bottom: 0.5rem;
}

/* 
    This placeholder occupies the same vertical space 
    as a dense QTabs bar. Adjust to match your actual QTabs height. 
  */
.tab-placeholder {
  min-height: 34px;
}
</style>
