<template>
  <span class="app-version">v{{ appVersion }} ({{ gitHash }})</span>
</template>

<script setup lang="ts">
/**
 * Build-identity line: injected at build time by quasar.config.ts via Vite
 * defines (__APP_VERSION__ / __APP_GIT_HASH__). Answers "what exact build is
 * running", and is the build: field for the future bug-report tool.
 */
const appVersion = __APP_VERSION__;
const gitHash = __APP_GIT_HASH__;
</script>

<style scoped>
.app-version {
  font-size: 12px;
  color: var(--text-secondary, #c8d9f2);
  opacity: 0.7;
  user-select: text;
}
</style>
