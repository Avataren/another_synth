<template>
  <div
    v-if="open"
    ref="menuRef"
    class="plist-menu"
    role="menu"
    :aria-label="`PList row ${rowLabel}`"
    :style="{ left: `${left}px`, top: `${top}px` }"
    data-testid="ahx-plist-canvas-menu"
    :data-row="row"
    @contextmenu.prevent
  >
    <button
      v-for="item in items"
      :key="item.action"
      type="button"
      role="menuitem"
      class="plist-menu__item"
      :disabled="item.reason !== undefined"
      :title="item.reason ?? item.title"
      :data-testid="`ahx-plist-canvas-menu-${item.action}`"
      @click="$emit('pick', item.action)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * The row menu of the PList canvas (plan `.ai/plan-plist-canvas.md` §4.5): native
 * buttons in a plain `role="menu"`, no Quasar. It only asks: picking an item
 * emits its action and the host turns it into the same op a key would be. An
 * item that cannot be done is disabled with the reason as its tooltip (the
 * 255-row cap, the file's size limit), which the host supplies.
 *
 * Escape and a click outside close it. Escape is taken in the capture phase so the
 * page's own Escape (leave Edit, then leave the page) does not also run.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { PLIST_MENU_ACTIONS, type PListMenuAction } from 'src/audio/tracker/plist-edit-input';

interface Props {
  open: boolean;
  /** Where the pointer was (viewport pixels): the menu opens there. */
  x: number;
  y: number;
  /** The row the menu acts on. */
  row: number;
  /** Why an action cannot be done right now; an action not listed can. */
  reasons?: Partial<Record<PListMenuAction, string>>;
}

const props = withDefaults(defineProps<Props>(), { reasons: () => ({}) });
const emit = defineEmits<{ (event: 'pick', action: PListMenuAction): void; (event: 'close', how: 'escape' | 'outside'): void }>();

const rowLabel = computed(() => props.row.toString(16).toUpperCase().padStart(2, '0'));

const LABELS: Record<PListMenuAction, { label: string; title: string }> = {
  'insert-above': { label: 'Insert row above', title: 'Adds an empty row before this one; this row and the ones after it move down.' },
  'insert-below': { label: 'Insert row below', title: 'Adds an empty row after this one; the rows after it move down.' },
  duplicate: { label: 'Duplicate row', title: 'Adds a copy of this row right after it; the rows after it move down.' },
  delete: { label: 'Delete row', title: 'Removes this row; the rows after it move up. Jump commands (5xx) are not renumbered.' },
  clear: { label: 'Clear row', title: 'Empties this row (note, tone and both commands); no other row moves.' },
  fixed: { label: 'Toggle Fixed', title: 'Turns Fixed on or off for this row: a fixed note is a pitch, otherwise it is semitones above the key played.' },
};

const items = computed(() =>
  PLIST_MENU_ACTIONS.map((action) => ({ action, ...LABELS[action], reason: props.reasons[action] })),
);

// The menu is small; keep it inside the window when the pointer is near an edge.
const MENU_WIDTH_PX = 180;
const MENU_HEIGHT_PX = 6 * 32 + 12;
const left = computed(() => Math.max(0, Math.min(props.x, (typeof window === 'undefined' ? props.x : window.innerWidth) - MENU_WIDTH_PX)));
const top = computed(() => Math.max(0, Math.min(props.y, (typeof window === 'undefined' ? props.y : window.innerHeight) - MENU_HEIGHT_PX)));

const menuRef = ref<HTMLElement | null>(null);

function onKeydownCapture(raw: Event): void {
  const event = raw as KeyboardEvent;
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  emit('close', 'escape');
}
function onPointerDownOutside(event: Event): void {
  const menu = menuRef.value;
  if (menu && event.target instanceof Node && menu.contains(event.target)) return;
  emit('close', 'outside');
}

let listening = false;
function listen(on: boolean): void {
  if (on === listening) return;
  listening = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  window[method]('keydown', onKeydownCapture, true);
  window[method]('pointerdown', onPointerDownOutside, true);
}

watch(
  () => props.open,
  (open) => {
    listen(open);
    // Keyboard reachable: focus the first item that can be picked.
    if (open) void nextTick(() => menuRef.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true }));
  },
  { immediate: true },
);
onBeforeUnmount(() => listen(false));
</script>

<style scoped>
.plist-menu {
  position: fixed;
  z-index: 3000;
  width: 180px;
  display: grid;
  padding: 6px;
  border: 1px solid var(--border-strong, #2c3c52);
  border-radius: 10px;
  background: var(--panel-background, #111a27);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}

.plist-menu__item {
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary, #e8f3ff);
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  cursor: pointer;
}

.plist-menu__item:hover:not(:disabled),
.plist-menu__item:focus-visible {
  background: var(--tracker-accent-primary, #f0b25e);
  color: var(--app-background, #0b111a);
  outline: none;
}

.plist-menu__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
