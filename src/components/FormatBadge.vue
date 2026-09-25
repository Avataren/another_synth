<template>
  <span
    class="format-badge"
    :class="{ 'format-badge--mark-only': markOnly }"
    data-testid="format-badge"
    :data-format="brand"
    role="img"
    :aria-label="fullName"
    :title="fullName"
    :style="vars"
  >
    <!-- Our own static art (src/assets/format-brands), never user input. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <span class="format-badge__mark" aria-hidden="true" v-html="info.mark"></span>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <span v-if="!markOnly" class="format-badge__label" aria-hidden="true" v-html="info.badge"></span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBrand, formatBrandVars, type FormatBrandId } from 'src/branding/format-brands';

interface FormatBadgeProps {
  brand: FormatBrandId;
  /** Said after the brand's name, e.g. a MOD's 'ProTracker · M.K.'. */
  variant?: string | null;
  /** Only the mark, for a tight row. */
  markOnly?: boolean;
}

const props = withDefaults(defineProps<FormatBadgeProps>(), { variant: null, markOnly: false });

const info = computed(() => formatBrand(props.brand));
const fullName = computed(() => (props.variant ? `${info.value.name} · ${props.variant}` : info.value.name));
// Scoped here, not read from the root: a demo row or a queued jukebox entry
// shows its own format, which need not be the active song's.
const vars = computed(() => formatBrandVars(props.brand));
</script>

<style scoped>
.format-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 2px 7px 2px 2px;
  border-radius: 4px;
  background: var(--format-accent);
  color: var(--format-accent-ink);
  flex: 0 0 auto;
  vertical-align: middle;
  box-sizing: border-box;
}

.format-badge--mark-only {
  padding: 0;
  background: none;
}

.format-badge__mark,
.format-badge__label {
  display: block;
  line-height: 0;
}

.format-badge__mark :deep(svg) {
  width: 16px;
  height: 16px;
  border-radius: 3px;
}

.format-badge--mark-only .format-badge__mark :deep(svg) {
  width: 20px;
  height: 20px;
}

.format-badge__label :deep(svg) {
  height: 12px;
  width: auto;
}
</style>
