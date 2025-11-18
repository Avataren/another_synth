<template>
  <q-layout view="lHh Lpr lFf">
    <q-header elevated class="app-header">
      <q-toolbar>
        <q-toolbar-title>Synthesizer</q-toolbar-title>
        <div class="cpu"><CpuUsageHeader /></div>
      </q-toolbar>

      <!-- Global patch / bank toolbar, always visible at the top -->
      <PresetManager />
    </q-header>

    <!-- <q-drawer
      v-model="leftDrawerOpen"
      show-if-above
      bordered
    >
      <q-list>
        <q-item-label
          header
        >
          Essential Links
        </q-item-label>

        <EssentialLink
          v-for="link in linksList"
          :key="link.title"
          v-bind="link"
        />
      </q-list>
    </q-drawer> -->

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import CpuUsageHeader from 'src/components/CpuUsageHeader.vue';
import PresetManager from 'src/components/PresetManager.vue';
</script>
<style scoped>
.cpu {
  width: 250px;
}

.app-header {
  z-index: 1000;
}
</style>
