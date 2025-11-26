<template>
  <div class="category-node" :style="{ paddingLeft: `${depth * 8}px` }">
    <button
      type="button"
      class="category-header"
      @click="$emit('toggle', node.id)"
    >
      <q-icon
        :name="expandedCategories.has(node.id) ? 'expand_more' : 'chevron_right'"
        size="12px"
        class="expand-icon"
      />
      <span class="category-name">{{ node.label }}</span>
      <span class="patch-count">{{ node.patchCount }}</span>
    </button>

    <div v-if="expandedCategories.has(node.id)" class="category-children">
      <template v-for="child in node.children" :key="child.id">
        <!-- Nested category -->
        <CategoryTreeNode
          v-if="child.type === 'category'"
          :node="child"
          :depth="depth + 1"
          :model-value="modelValue"
          :expanded-categories="expandedCategories"
          @toggle="$emit('toggle', $event)"
          @select="$emit('select', $event)"
        />
        <!-- Patch item -->
        <button
          v-else
          type="button"
          class="patch-item"
          :class="{ selected: child.id === modelValue }"
          :style="{ paddingLeft: `${(depth + 1) * 8 + 8}px` }"
          @click="$emit('select', child)"
        >
          <q-icon name="music_note" size="12px" class="patch-icon" />
          <span class="patch-name">{{ child.label }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
interface TreeNode {
  id: string;
  label: string;
  type: 'bank' | 'category' | 'patch';
  bankId?: string;
  bankName?: string;
  patchCount?: number;
  children?: TreeNode[];
}

interface Props {
  node: TreeNode;
  depth: number;
  modelValue: string | null;
  expandedCategories: Set<string>;
}

defineProps<Props>();

defineEmits<{
  (e: 'toggle', id: string): void;
  (e: 'select', node: TreeNode): void;
}>();
</script>

<style scoped>
.category-node {
  margin-bottom: 2px;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 6px;
  background: transparent;
  border: none;
  color: var(--text-secondary, #b8c9e0);
  font-size: 11px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}

.category-header:hover {
  background: var(--button-hover, rgba(255, 255, 255, 0.04));
}

.expand-icon {
  color: var(--text-muted, #7a8ba3);
  flex-shrink: 0;
}

.category-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patch-count {
  font-size: 10px;
  color: var(--text-muted, #7a8ba3);
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  padding: 1px 6px;
  border-radius: 10px;
}

.category-children {
  padding-left: 8px;
}

.patch-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  background: transparent;
  border: none;
  color: var(--text-secondary, #b8c9e0);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
  transition: all 0.1s ease;
}

.patch-item:hover {
  background: var(--button-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e8f3ff);
}

.patch-item.selected {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.12));
  color: var(--tracker-accent-primary, #4df2c5);
}

.patch-icon {
  color: var(--tracker-accent-primary, #4df2c5);
  opacity: 0.6;
  flex-shrink: 0;
}

.patch-item.selected .patch-icon {
  opacity: 1;
}

.patch-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
