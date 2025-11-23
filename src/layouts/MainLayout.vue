<template>
  <q-layout view="lHh Lpr lFf" class="app-layout">
    <q-header elevated class="app-header">
      <q-toolbar class="app-toolbar">
        <q-toolbar-title>Synthesizer</q-toolbar-title>

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
          <q-route-tab to="/help" name="help" label="Help" exact />
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
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 100%;
}

.app-header {
  --app-header-height: 44px;
  z-index: 1000;
  height: var(--app-header-height);
  min-height: var(--app-header-height);
}

.app-toolbar {
  gap: 10px;
  min-height: var(--app-header-height);
  padding: 4px 10px;
  align-items: center;
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

.app-layout {
  min-height: 100vh;
  overflow: hidden;
}

.app-layout :deep(.q-page-container) {
  height: 100vh;
  padding-top: var(--app-header-height, 44px);
  overflow: hidden;
  box-sizing: border-box;
}

.app-layout :deep(.q-page) {
  min-height: calc(100vh - var(--app-header-height, 44px));
  max-height: calc(100vh - var(--app-header-height, 44px));
  overflow: auto;
}
</style>
