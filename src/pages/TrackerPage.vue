<template>
  <q-page class="tracker-page">
    <div class="tracker-placeholder">
      <div class="tracker-title">Tracker</div>
      <div class="tracker-subtitle">
        Sequence patterns and songs will live here. Stay tuned.
      </div>
    </div>
  </q-page>
</template>

<style scoped>
.tracker-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--q-page-container-height, 100vh);
  background: linear-gradient(135deg, #0f131c, #0b0f18);
  padding: 1.5rem;
  box-sizing: border-box;
}

.tracker-placeholder {
  text-align: center;
  color: #d4e0f5;
  border: 1px solid #273140;
  border-radius: 12px;
  padding: 2rem 1.5rem;
  width: min(960px, 100%);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  background: rgba(9, 12, 18, 0.7);
}

.tracker-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
}

.tracker-subtitle {
  color: #9fb2cc;
  font-size: 14px;
}
</style>
