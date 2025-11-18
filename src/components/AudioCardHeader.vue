<template>
  <q-card-section
    class="row items-center justify-between bg-primary text-white"
  >
    <!-- Left side: Title -->
    <div class="text-h6 header-title">
      <template v-if="editable">
        <q-input
          dense
          filled
          class="name-input"
          v-model="editableTitle"
          @update:model-value="onTitleInput"
        />
      </template>
      <template v-else>{{ title }}</template>
    </div>

    <!-- Right side: Buttons -->
    <div class="row items-center">
      <!-- Plus button -->
      <q-btn flat dense icon="add" class="q-ml-sm" @click="onPlusClicked" />

      <!-- Toggle Minimize / Maximize button (chevron) -->
      <q-btn
        flat
        dense
        :icon="minimized ? 'keyboard_arrow_down' : 'keyboard_arrow_up'"
        class="q-ml-sm"
        @click="onMinimizeClicked"
      />

      <!-- Close (X) button -->
      <q-btn flat dense icon="close" class="q-ml-sm" @click="onCloseClicked" />
    </div>
  </q-card-section>
</template>

<script setup lang="ts">
// Import what we need from Vue
import { ref, watch } from 'vue';

// Define props
interface Props {
  title?: string;
  editable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  title: 'Default Title',
  editable: false,
});

// Define emits
const emits = defineEmits([
  'plusClicked',
  'minimizeClicked',
  'closeClicked',
  'update:title',
]);

const editableTitle = ref(props.title);

watch(
  () => props.title,
  (newTitle) => {
    editableTitle.value = newTitle;
  },
);

function onTitleInput(value: string) {
  emits('update:title', value);
}

// Local ref to track if minimized or not
const minimized = ref(false);

// Handlers
function onPlusClicked() {
  emits('plusClicked');
}

function onMinimizeClicked() {
  minimized.value = !minimized.value;
  // If you need to notify parent, emit the new minimized state:
  emits('minimizeClicked', minimized.value);
}

function onCloseClicked() {
  emits('closeClicked');
}
</script>
