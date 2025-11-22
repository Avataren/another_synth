<template>
  <q-layout view="lHh Lpr lFf">
    <q-header elevated class="app-header">
      <q-toolbar class="app-toolbar">
        <q-toolbar-title>Synthesizer</q-toolbar-title>

        <q-space />
        <q-tabs
          dense
          active-color="white"
          indicator-color="primary"
          align="center"
          class="main-tabs text-white"
          inline-label
        >
          <q-route-tab to="/tracker" name="tracker" label="Tracker" exact />
          <q-route-tab to="/patch" name="patch" label="Patch editor" exact />
        </q-tabs>
        <q-space />

        <div class="cpu"><CpuUsageHeader /></div>
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import CpuUsageHeader from 'src/components/CpuUsageHeader.vue';
</script>
<style scoped>
.cpu {
  width: 250px;
}

.app-header {
  z-index: 1000;
}

.app-toolbar {
  gap: 12px;
  min-height: 56px;
}

.main-tabs {
  flex: 0 1 auto;
}

.main-tabs :deep(.q-tab__label) {
  color: rgba(255, 255, 255, 0.75);
  font-weight: 600;
}

.main-tabs :deep(.q-tab--active .q-tab__label) {
  color: #ffffff;
  font-weight: 700;
}

@media (max-width: 900px) {
  .main-tabs {
    width: 100%;
    justify-content: center;
  }
}

.preset-bar {
  min-height: 64px;
  display: flex;
  align-items: center;
}
</style>
