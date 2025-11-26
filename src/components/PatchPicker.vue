<template>
  <div class="patch-picker" ref="pickerRef">
    <button
      type="button"
      class="patch-picker-trigger"
      :class="{ open: isOpen, 'has-value': !!modelValue }"
      @click.stop="toggleDropdown"
    >
      <span class="patch-picker-label">{{ displayLabel }}</span>
      <q-icon name="expand_more" size="16px" class="picker-icon" :class="{ rotated: isOpen }" />
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        class="patch-picker-dropdown"
        :style="dropdownStyle"
        @click.stop
      >
        <div class="picker-search">
          <q-icon name="search" size="14px" class="search-icon" />
          <input
            ref="searchInputRef"
            v-model="searchFilter"
            type="text"
            placeholder="Search patches..."
            class="search-input"
            @keydown.esc="closeDropdown"
          />
          <button
            v-if="searchFilter"
            type="button"
            class="clear-search"
            @click="searchFilter = ''"
          >
            <q-icon name="close" size="12px" />
          </button>
        </div>

        <div class="picker-tree">
          <template v-if="filteredTreeNodes.length === 0">
            <div class="no-results">No patches found</div>
          </template>
          <template v-else>
            <div
              v-for="bank in filteredTreeNodes"
              :key="bank.id"
              class="bank-node"
            >
              <button
                type="button"
                class="bank-header"
                @click="toggleBank(bank.id)"
              >
                <q-icon
                  :name="expandedBanks.has(bank.id) ? 'expand_more' : 'chevron_right'"
                  size="14px"
                  class="expand-icon"
                />
                <q-icon name="folder" size="14px" class="bank-icon" />
                <span class="bank-name">{{ bank.label }}</span>
                <span class="patch-count">{{ bank.patchCount }}</span>
              </button>

              <div v-if="expandedBanks.has(bank.id)" class="bank-children">
                <template v-for="node in bank.children" :key="node.id">
                  <template v-if="node.type === 'category'">
                    <CategoryTreeNode
                      :node="node"
                      :depth="0"
                      :model-value="modelValue"
                      :expanded-categories="expandedCategories"
                      @toggle="toggleCategory"
                      @select="selectPatch"
                    />
                  </template>
                  <!-- Patch node (uncategorized) -->
                  <button
                    v-else
                    type="button"
                    class="patch-item"
                    :class="{ selected: node.id === modelValue }"
                    @click="selectPatch(node)"
                  >
                    <q-icon name="music_note" size="12px" class="patch-icon" />
                    <span class="patch-name">{{ node.label }}</span>
                  </button>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { usePatchStore } from 'src/stores/patch-store';
import { categorySegments, DEFAULT_PATCH_CATEGORY } from 'src/utils/patch-category';
import type { Bank, Patch } from 'src/audio/types/preset-types';
import CategoryTreeNode from 'src/components/CategoryTreeNode.vue';

/**
 * Flat patch option (from TrackerPage's availablePatches)
 */
export interface PatchOption {
  id: string;
  name: string;
  bankId: string;
  bankName: string;
  category?: string;
}

interface Props {
  modelValue: string | null;
  placeholder?: string;
  banks?: Bank[];
  /** Flat list of patch options (alternative to banks) */
  patches?: PatchOption[];
}

interface Emits {
  (e: 'update:modelValue', value: string | null): void;
  (e: 'select', patch: { id: string; name: string; bankId: string; bankName: string }): void;
  (e: 'close'): void;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: 'Select patch',
});

// These may be undefined if not passed
const propsPatches = computed(() => props.patches);
const propsBanks = computed(() => props.banks);

const emit = defineEmits<Emits>();

const patchStore = usePatchStore();

// State
const isOpen = ref(false);
const searchFilter = ref('');
const expandedBanks = ref(new Set<string>());
const expandedCategories = ref(new Set<string>());
const pickerRef = ref<HTMLElement | null>(null);
const searchInputRef = ref<HTMLInputElement | null>(null);
const dropdownPosition = ref({ top: 0, left: 0, width: 280 });

// Get banks from props or from patchStore
const availableBanks = computed<Bank[]>(() => {
  if (propsBanks.value) {
    return propsBanks.value;
  }
  // Use the current bank from patch store
  return patchStore.currentBank ? [patchStore.currentBank] : [];
});

// Check if using flat patches mode
const useFlatPatches = computed(() => !!propsPatches.value && propsPatches.value.length > 0);

// Build tree structure
interface TreeNode {
  id: string;
  label: string;
  type: 'bank' | 'category' | 'patch';
  bankId?: string;
  bankName?: string;
  patchCount?: number;
  children?: TreeNode[];
}

const treeNodes = computed<TreeNode[]>(() => {
  // Use flat patches if provided
  if (useFlatPatches.value && propsPatches.value) {
    return buildTreeFromFlatPatches(propsPatches.value);
  }

  // Otherwise build from banks
  const banks = availableBanks.value;
  return banks.map((bank) => buildTreeFromBank(bank));
});

/**
 * Category tree accumulator for building nested categories
 */
interface CategoryAccumulator {
  name: string;
  path: string;
  children: Map<string, CategoryAccumulator>;
  patches: PatchOption[];
}

/**
 * Build tree from a flat list of patch options
 */
function buildTreeFromFlatPatches(patches: PatchOption[]): TreeNode[] {
  // Group patches by bank first
  const bankMap = new Map<string, { bankName: string; patches: PatchOption[] }>();

  for (const patch of patches) {
    const key = patch.bankId;
    if (!bankMap.has(key)) {
      bankMap.set(key, { bankName: patch.bankName, patches: [] });
    }
    bankMap.get(key)!.patches.push(patch);
  }

  // Build tree nodes for each bank
  const result: TreeNode[] = [];

  for (const [bankId, { bankName, patches: bankPatches }] of bankMap) {
    // Build nested category tree
    const rootCategory: CategoryAccumulator = {
      name: '',
      path: '',
      children: new Map(),
      patches: [],
    };

    for (const patch of bankPatches) {
      const segments = patch.category ? categorySegments(patch.category) : [];

      if (segments.length === 0 || segments[0] === DEFAULT_PATCH_CATEGORY) {
        // Uncategorized patches go at root level
        rootCategory.patches.push(patch);
      } else {
        // Navigate/create nested category path
        let currentNode = rootCategory;
        for (const segment of segments) {
          if (!currentNode.children.has(segment)) {
            const newPath = currentNode.path ? `${currentNode.path}/${segment}` : segment;
            currentNode.children.set(segment, {
              name: segment,
              path: newPath,
              children: new Map(),
              patches: [],
            });
          }
          currentNode = currentNode.children.get(segment)!;
        }
        currentNode.patches.push(patch);
      }
    }

    // Convert category tree to TreeNode
    function buildCategoryNodes(node: CategoryAccumulator): TreeNode[] {
      const nodes: TreeNode[] = [];

      // Add subcategory nodes first
      const sortedCategories = Array.from(node.children.values()).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );

      for (const child of sortedCategories) {
        const childNodes = buildCategoryNodes(child);
        const patchCount = countPatchesInCategory(child);

        const categoryNode: TreeNode = {
          id: `category:${bankId}:${child.path}`,
          label: child.name,
          type: 'category',
          bankId,
          bankName,
          patchCount,
          children: childNodes,
        };

        // Add patches directly under this category
        const sortedPatches = child.patches.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        );

        for (const patch of sortedPatches) {
          categoryNode.children!.push({
            id: patch.id,
            label: patch.name,
            type: 'patch',
            bankId,
            bankName,
          });
        }

        nodes.push(categoryNode);
      }

      return nodes;
    }

    function countPatchesInCategory(node: CategoryAccumulator): number {
      let count = node.patches.length;
      for (const child of node.children.values()) {
        count += countPatchesInCategory(child);
      }
      return count;
    }

    const bankNode: TreeNode = {
      id: `bank:${bankId}`,
      label: bankName,
      type: 'bank',
      bankId,
      bankName,
      patchCount: bankPatches.length,
      children: buildCategoryNodes(rootCategory),
    };

    // Add uncategorized patches directly under bank
    const sortedUncategorized = rootCategory.patches.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    for (const patch of sortedUncategorized) {
      bankNode.children!.push({
        id: patch.id,
        label: patch.name,
        type: 'patch',
        bankId,
        bankName,
      });
    }

    result.push(bankNode);
  }

  return result;
}

/**
 * Category tree accumulator for Bank patches
 */
interface BankCategoryAccumulator {
  name: string;
  path: string;
  children: Map<string, BankCategoryAccumulator>;
  patches: Patch[];
}

/**
 * Build tree from a Bank object
 */
function buildTreeFromBank(bank: Bank): TreeNode {
  const bankId = bank.metadata.id;
  const bankName = bank.metadata.name;

  // Build nested category tree
  const rootCategory: BankCategoryAccumulator = {
    name: '',
    path: '',
    children: new Map(),
    patches: [],
  };

  for (const patch of bank.patches) {
    const segments = categorySegments(patch.metadata.category);

    if (segments.length === 0 || segments[0] === DEFAULT_PATCH_CATEGORY) {
      // Uncategorized patches go at root level
      rootCategory.patches.push(patch);
    } else {
      // Navigate/create nested category path
      let currentNode = rootCategory;
      for (const segment of segments) {
        if (!currentNode.children.has(segment)) {
          const newPath = currentNode.path ? `${currentNode.path}/${segment}` : segment;
          currentNode.children.set(segment, {
            name: segment,
            path: newPath,
            children: new Map(),
            patches: [],
          });
        }
        currentNode = currentNode.children.get(segment)!;
      }
      currentNode.patches.push(patch);
    }
  }

  // Convert category tree to TreeNode
  function buildCategoryNodes(node: BankCategoryAccumulator): TreeNode[] {
    const nodes: TreeNode[] = [];

    // Add subcategory nodes first
    const sortedCategories = Array.from(node.children.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    for (const child of sortedCategories) {
      const childNodes = buildCategoryNodes(child);
      const patchCount = countPatchesInCategory(child);

      const categoryNode: TreeNode = {
        id: `category:${bankId}:${child.path}`,
        label: child.name,
        type: 'category',
        bankId,
        bankName,
        patchCount,
        children: childNodes,
      };

      // Add patches directly under this category
      const sortedPatches = child.patches.sort((a, b) =>
        a.metadata.name.localeCompare(b.metadata.name, undefined, { sensitivity: 'base' })
      );

      for (const patch of sortedPatches) {
        categoryNode.children!.push({
          id: patch.metadata.id,
          label: patch.metadata.name,
          type: 'patch',
          bankId,
          bankName,
        });
      }

      nodes.push(categoryNode);
    }

    return nodes;
  }

  function countPatchesInCategory(node: BankCategoryAccumulator): number {
    let count = node.patches.length;
    for (const child of node.children.values()) {
      count += countPatchesInCategory(child);
    }
    return count;
  }

  const bankNode: TreeNode = {
    id: `bank:${bankId}`,
    label: bankName,
    type: 'bank',
    bankId,
    bankName,
    patchCount: bank.patches.length,
    children: buildCategoryNodes(rootCategory),
  };

  // Add uncategorized patches directly under bank
  const sortedUncategorized = rootCategory.patches.sort((a, b) =>
    a.metadata.name.localeCompare(b.metadata.name, undefined, { sensitivity: 'base' })
  );

  for (const patch of sortedUncategorized) {
    bankNode.children!.push({
      id: patch.metadata.id,
      label: patch.metadata.name,
      type: 'patch',
      bankId,
      bankName,
    });
  }

  return bankNode;
}

// Filter tree nodes based on search
const filteredTreeNodes = computed<TreeNode[]>(() => {
  const filter = searchFilter.value.toLowerCase().trim();
  if (!filter) {
    return treeNodes.value;
  }

  const result: TreeNode[] = [];

  for (const bank of treeNodes.value) {
    const filteredChildren: TreeNode[] = [];

    for (const child of bank.children || []) {
      if (child.type === 'category') {
        // Filter patches within category
        const matchingPatches = (child.children || []).filter((patch) =>
          patch.label.toLowerCase().includes(filter)
        );

        if (matchingPatches.length > 0) {
          filteredChildren.push({
            ...child,
            patchCount: matchingPatches.length,
            children: matchingPatches,
          });
        }
      } else if (child.type === 'patch') {
        if (child.label.toLowerCase().includes(filter)) {
          filteredChildren.push(child);
        }
      }
    }

    if (filteredChildren.length > 0) {
      result.push({
        ...bank,
        patchCount: filteredChildren.reduce(
          (sum, c) => sum + (c.type === 'category' ? c.patchCount || 0 : 1),
          0
        ),
        children: filteredChildren,
      });
    }
  }

  return result;
});

// Display label
const displayLabel = computed(() => {
  if (!props.modelValue) {
    return props.placeholder;
  }

  // Try flat patches first
  if (useFlatPatches.value && propsPatches.value) {
    const patch = propsPatches.value.find((p) => p.id === props.modelValue);
    if (patch) {
      return patch.name;
    }
  }

  // Find the patch in all banks
  for (const bank of availableBanks.value) {
    const patch = bank.patches.find((p) => p.metadata.id === props.modelValue);
    if (patch) {
      return patch.metadata.name;
    }
  }

  return props.placeholder;
});

// Dropdown positioning
const dropdownStyle = computed(() => ({
  top: `${dropdownPosition.value.top}px`,
  left: `${dropdownPosition.value.left}px`,
  minWidth: `${dropdownPosition.value.width}px`,
}));

function updateDropdownPosition() {
  if (!pickerRef.value) return;

  const rect = pickerRef.value.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const dropdownHeight = 320; // Approximate max height

  // Position below by default, above if not enough space
  let top = rect.bottom + 4;
  if (top + dropdownHeight > viewportHeight && rect.top > dropdownHeight) {
    top = rect.top - dropdownHeight - 4;
  }

  dropdownPosition.value = {
    top,
    left: rect.left,
    width: Math.max(280, rect.width),
  };
}

function toggleDropdown() {
  if (isOpen.value) {
    closeDropdown();
  } else {
    openDropdown();
  }
}

function openDropdown() {
  updateDropdownPosition();
  isOpen.value = true;
  searchFilter.value = '';

  // Expand banks that contain the selected patch
  if (props.modelValue) {
    for (const bank of treeNodes.value) {
      for (const child of bank.children || []) {
        if (child.type === 'patch' && child.id === props.modelValue) {
          expandedBanks.value.add(bank.id);
          break;
        }
        if (child.type === 'category') {
          for (const patch of child.children || []) {
            if (patch.id === props.modelValue) {
              expandedBanks.value.add(bank.id);
              expandedCategories.value.add(child.id);
              break;
            }
          }
        }
      }
    }
  } else {
    // Expand first bank by default
    const firstBank = treeNodes.value[0];
    if (firstBank) {
      expandedBanks.value.add(firstBank.id);
      // Also expand first category within the bank
      const firstCategory = firstBank.children?.find((c) => c.type === 'category');
      if (firstCategory) {
        expandedCategories.value.add(firstCategory.id);
      }
    }
  }

  nextTick(() => {
    searchInputRef.value?.focus();
  });
}

function closeDropdown() {
  isOpen.value = false;
  emit('close');
}

function toggleBank(bankId: string) {
  if (expandedBanks.value.has(bankId)) {
    expandedBanks.value.delete(bankId);
  } else {
    expandedBanks.value.add(bankId);
  }
}

function toggleCategory(categoryId: string) {
  if (expandedCategories.value.has(categoryId)) {
    expandedCategories.value.delete(categoryId);
  } else {
    expandedCategories.value.add(categoryId);
  }
}

function selectPatch(patch: TreeNode) {
  emit('update:modelValue', patch.id);
  emit('select', {
    id: patch.id,
    name: patch.label,
    bankId: patch.bankId || '',
    bankName: patch.bankName || '',
  });
  closeDropdown();
}

// Auto-expand when searching
watch(searchFilter, (filter) => {
  if (filter) {
    // Expand all matching banks and categories
    for (const bank of filteredTreeNodes.value) {
      expandedBanks.value.add(bank.id);
      for (const child of bank.children || []) {
        if (child.type === 'category') {
          expandedCategories.value.add(child.id);
        }
      }
    }
  }
});

// Close on outside click
function handleClickOutside(event: MouseEvent) {
  if (!isOpen.value) return;

  const target = event.target as Node;
  const picker = pickerRef.value;
  const dropdown = document.querySelector('.patch-picker-dropdown');

  if (picker && !picker.contains(target) && dropdown && !dropdown.contains(target)) {
    closeDropdown();
  }
}

// Close on Escape
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    closeDropdown();
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', updateDropdownPosition);
  window.addEventListener('scroll', updateDropdownPosition, true);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('resize', updateDropdownPosition);
  window.removeEventListener('scroll', updateDropdownPosition, true);
});
</script>

<style scoped>
.patch-picker {
  position: relative;
  display: inline-block;
}

.patch-picker-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  min-width: 120px;
  max-width: 180px;
  height: 28px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-secondary, #b8c9e0);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.patch-picker-trigger:hover {
  border-color: var(--panel-border-hover, rgba(255, 255, 255, 0.2));
  background: var(--button-hover, rgba(255, 255, 255, 0.08));
}

.patch-picker-trigger.open {
  border-color: var(--tracker-accent-primary, #4df2c5);
  background: var(--button-hover, rgba(255, 255, 255, 0.08));
}

.patch-picker-trigger.has-value {
  color: var(--text-primary, #e8f3ff);
}

.patch-picker-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.picker-icon {
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.picker-icon.rotated {
  transform: rotate(180deg);
}

/* Dropdown styles */
.patch-picker-dropdown {
  position: fixed;
  z-index: 9999;
  background: var(--panel-background, #0f1621);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.picker-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.02));
}

.search-icon {
  color: var(--text-muted, #7a8ba3);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-primary, #e8f3ff);
  font-size: 12px;
}

.search-input::placeholder {
  color: var(--text-muted, #7a8ba3);
}

.clear-search {
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--text-muted, #7a8ba3);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.clear-search:hover {
  background: var(--button-hover, rgba(255, 255, 255, 0.08));
  color: var(--text-secondary, #b8c9e0);
}

.picker-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.no-results {
  padding: 16px;
  text-align: center;
  color: var(--text-muted, #7a8ba3);
  font-size: 12px;
}

/* Bank node */
.bank-node {
  margin-bottom: 2px;
}

.bank-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: transparent;
  border: none;
  color: var(--text-primary, #e8f3ff);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}

.bank-header:hover {
  background: var(--button-hover, rgba(255, 255, 255, 0.06));
}

.expand-icon {
  color: var(--text-muted, #7a8ba3);
  flex-shrink: 0;
}

.bank-icon {
  color: var(--tracker-accent-secondary, #70c2ff);
  flex-shrink: 0;
}

.bank-name {
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

.bank-children {
  padding-left: 12px;
}

/* Category node */
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

.category-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.category-children {
  padding-left: 16px;
}

/* Patch item */
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
