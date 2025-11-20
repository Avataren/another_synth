<template>
  <div class="cpu-usage">
    <div class="label">cpu-usage</div>
    <div class="progress-container">
      <q-linear-progress
        :value="cpuUsage / 100"
        animation-speed="100"
        color="teal"
        track-color="grey-3"
        size="10px"
        class="progress"
      />
      <span class="usage-text">{{ cpuUsage }}%</span>
    </div>
  </div>
</template>

<script lang="ts">
import { useInstrumentStore } from 'src/stores/instrument-store';
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';

const store = useInstrumentStore();

const cpuTimer = ref<NodeJS.Timeout | null>(null);
export default defineComponent({
  name: 'CpuUsageHeader',
  setup() {
    // Temporary CPU usage value set to 30%
    const cpuUsage = ref(0);
    const updateCpuUsage = () => {
      //console.log('post');
      store.currentInstrument?.workletNode?.port.postMessage({
        type: 'cpuUsage',
      });
    };
    const handleMessage = (e: MessageEvent) => {
      if (e.data.type === 'cpuUsage') {
        // console.log('reply', e.data.cpu);
        cpuUsage.value = e.data.cpu << 0;
      }
    };
    onMounted(() => {
      setTimeout(() => {
        if (cpuTimer.value != null) {
          clearInterval(cpuTimer.value);
        }
        cpuTimer.value = setInterval(updateCpuUsage, 1000 / 10);
        store.currentInstrument?.workletNode?.port.addEventListener(
          'message',
          handleMessage,
        );
      }, 500);
    });
    onUnmounted(() => {
      if (cpuTimer.value != null) {
        clearInterval(cpuTimer.value);
      }
    });
    return { cpuUsage };
  },
});
</script>

<style scoped>
.cpu-usage {
  width: 100%;
  padding: 5px 0; /* minimal padding for header fit */
}
.label {
  font-size: 0.8rem;
  color: #e0e0e2;
  text-align: center;
  margin-bottom: 3px;
}
.progress-container {
  position: relative;
  width: 100%;
}
.usage-text {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.75rem;
  font-weight: bold;
  color: #333;
}
</style>
