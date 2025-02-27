<template>
  <div class="q-my-md">
    <q-select
      :model-value="modelValue"
      label="Preset"
      :options="options"
      option-value="value"
      option-label="label"
      emit-value
      @update:model-value="$emit('update:preset', $event)"
      clearable
    />
  </div>
</template>

<script>
export default {
  name: 'PresetSelector',
  props: {
    modelValue: {
      type: String,
      required: true,
    },
    options: {
      type: Array,
      required: true,
    },
  },
  emits: ['update:preset'],
};
</script>
