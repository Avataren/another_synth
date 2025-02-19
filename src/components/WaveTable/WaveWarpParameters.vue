<!-- WaveWarpParameters.vue -->
<template>
  <div class="wave-warp-parameters q-pa-md">
    <div class="row q-col-gutter-md">
      <!-- X Warp -->
      <div class="col-12">
        <div class="text-subtitle2">X Warp</div>
        <q-slider
          v-model="localXAmount"
          :min="-4"
          :max="50"
          :step="0.1"
          label
          label-always
          color="purple"
          @update:model-value="updateParams"
        >
          <template v-slot:thumb-label>
            {{ localXAmount.toFixed(2) }}
          </template>
        </q-slider>
      </div>

      <!-- Y Warp -->
      <div class="col-12">
        <div class="text-subtitle2">Y Warp</div>
        <q-slider
          v-model="localYAmount"
          :min="-4"
          :max="50"
          :step="0.1"
          label
          label-always
          color="teal"
          @update:model-value="updateParams"
        >
          <template v-slot:thumb-label>
            {{ localYAmount.toFixed(2) }}
          </template>
        </q-slider>
      </div>

      <!-- Asymmetric Mode Toggle -->
      <div class="col-12">
        <q-toggle
          v-model="localAsymmetric"
          label="Asymmetric"
          @update:model-value="updateParams"
        />
      </div>
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
        return (
          'xAmount' in value && 'yAmount' in value && 'asymmetric' in value
        );
      },
    },
  },

  data() {
    return {
      localXAmount: this.params.xAmount,
      localYAmount: this.params.yAmount,
      localAsymmetric: this.params.asymmetric,
    };
  },

  watch: {
    params: {
      handler(newParams) {
        this.localXAmount = newParams.xAmount;
        this.localYAmount = newParams.yAmount;
        this.localAsymmetric = newParams.asymmetric;
      },
      deep: true,
    },
  },

  methods: {
    updateParams() {
      this.$emit('update:params', {
        xAmount: this.localXAmount,
        yAmount: this.localYAmount,
        asymmetric: this.localAsymmetric,
      });
    },
  },
};
</script>
