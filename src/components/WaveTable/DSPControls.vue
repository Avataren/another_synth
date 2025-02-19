<template>
  <div class="row items-center">
    <q-toggle
      :model-value="removeDc"
      label="Remove DC"
      class="q-mr-md"
      @update:model-value="$emit('update:remove-dc', $event)"
    />
    <q-toggle
      :model-value="normalize"
      label="Normalize"
      class="q-mr-md"
      @update:model-value="$emit('update:normalize', $event)"
    />
  </div>
</template>

<script>
export default {
  name: 'DSPControls',
  props: {
    removeDc: {
      type: Boolean,
      required: true,
    },
    normalize: {
      type: Boolean,
      required: true,
    },
  },
  emits: ['update:remove-dc', 'update:normalize'],
};
</script>
