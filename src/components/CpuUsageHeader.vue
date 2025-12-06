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
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';

const instrumentStore = useInstrumentStore();
const trackerAudioStore = useTrackerAudioStore();
const cpuTimer = ref<NodeJS.Timeout | null>(null);
export default defineComponent({
  name: 'CpuUsageHeader',
  setup() {
    const cpuUsage = ref(0);
    const polling = ref(false);

    const requestWorkletCpu = (
      workletNode: AudioWorkletNode | null | undefined,
    ): Promise<number> => {
      if (!workletNode) return Promise.resolve(0);

      return new Promise((resolve) => {
        const messageId = `cpu-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;
        const { port } = workletNode;

        const timeout = window.setTimeout(() => {
          port.removeEventListener('message', handleMessage as EventListener);
          resolve(0);
        }, 100);

        const handleMessage = (event: MessageEvent) => {
          const data = event.data as {
            type?: string;
            cpu?: number;
            total?: number;
            messageId?: string;
          };

          if (data?.type !== 'cpuUsage') return;
          if (data.messageId && data.messageId !== messageId) return;

          port.removeEventListener('message', handleMessage as EventListener);
          window.clearTimeout(timeout);

          const value = Number.isFinite(data.total)
            ? Number(data.total)
            : Number(data.cpu ?? 0);
          resolve(Number.isFinite(value) ? value : 0);
        };

        port.addEventListener('message', handleMessage as EventListener);
        port.postMessage({ type: 'cpuUsage', messageId });
      });
    };

    const updateCpuUsage = async () => {
      if (polling.value) return;
      polling.value = true;
      try {
        let total = 0;

        // Aggregate tracker worklet pool + standalone tracker instruments
        const songBank = trackerAudioStore.songBank;
        try {
          const usage = await songBank.getCpuUsage();
          if (usage && Number.isFinite(usage.total)) {
            total += usage.total;
          }
        } catch (err) {
          console.warn('[CpuUsageHeader] Failed to query tracker CPU usage', err);
        }

        // Include the patch editor instrument (if active)
        if (!instrumentStore.usingExternalInstrument) {
          const editorCpu = await requestWorkletCpu(
            instrumentStore.currentInstrument?.workletNode ?? null,
          );
          total += editorCpu;
        }

        cpuUsage.value = Math.max(0, Math.round(total));
      } finally {
        polling.value = false;
      }
    };

    onMounted(() => {
      setTimeout(() => {
        if (cpuTimer.value != null) {
          clearInterval(cpuTimer.value);
        }
        cpuTimer.value = setInterval(() => {
          void updateCpuUsage();
        }, 1000 / 10);
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
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0;
}
.label {
  font-size: 0.78rem;
  color: var(--text-secondary);
  text-align: right;
  margin: 0;
  line-height: 1.1;
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
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-primary);
}
</style>
