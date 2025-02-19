<template>
  <div class="row q-gutter-md">
    <div class="col-12">
      <q-slider
        v-model="localAmount"
        :min="-1"
        :max="1"
        :step="0.01"
        label
        label-always
        color="purple"
        @update:model-value="updateAmount"
      >
        <template v-slot:thumb-label>
          {{ localAmount.toFixed(2) }}
        </template>
      </q-slider>
    </div>
    <div class="col">
      <q-select
        v-model="localType"
        label="Warp Type"
        :options="warpTypes"
        style="max-width: 150px"
        @update:model-value="updateType"
      />
    </div>
  </div>
</template>

<script>
export default {
  name: 'WaveWarpParameters',
  props: {
    params: {
      type: Object,
      required: true,
      validator: (value) => {
        return 'amount' in value && 'type' in value;
      },
    },
    warpTypes: {
      type: Array,
      required: true,
    },
  },

  data() {
    return {
      localAmount: this.params.amount,
      localType: this.params.type,
    };
  },

  watch: {
    'params.amount'(newVal) {
      this.localAmount = newVal;
    },
    'params.type'(newVal) {
      this.localType = newVal;
    },
  },

  emits: ['update:params'],

  methods: {
    updateAmount(newAmount) {
      this.$emit('update:params', {
        ...this.params,
        amount: newAmount,
      });
    },

    updateType(newType) {
      this.$emit('update:params', {
        ...this.params,
        type: newType,
      });
    },
  },
};
</script>
