import type { KeyboardCommand } from '../types';

/**
 * Selection commands for selecting and manipulating multiple cells
 */
export const selectionCommands: KeyboardCommand[] = [
  {
    key: 'ArrowUp',
    modifiers: { shift: true },
    description: 'Extend selection up',
    category: 'selection',
    handler: (ctx) => {
      if (!ctx.selectionAnchor.value) ctx.startSelectionAtCursor();
      ctx.moveRow(-1);
      ctx.selectionEnd.value = { row: ctx.activeRow.value, trackIndex: ctx.activeTrack.value };
    }
  },
  {
    key: 'ArrowDown',
    modifiers: { shift: true },
    description: 'Extend selection down',
    category: 'selection',
    handler: (ctx) => {
      if (!ctx.selectionAnchor.value) ctx.startSelectionAtCursor();
      ctx.moveRow(1);
      ctx.selectionEnd.value = { row: ctx.activeRow.value, trackIndex: ctx.activeTrack.value };
    }
  },
  {
    key: 'ArrowLeft',
    modifiers: { shift: true },
    description: 'Extend selection left',
    category: 'selection',
    handler: (ctx) => {
      if (!ctx.selectionAnchor.value) ctx.startSelectionAtCursor();
      ctx.moveColumn(-1);
      ctx.selectionEnd.value = { row: ctx.activeRow.value, trackIndex: ctx.activeTrack.value };
    }
  },
  {
    key: 'ArrowRight',
    modifiers: { shift: true },
    description: 'Extend selection right',
    category: 'selection',
    handler: (ctx) => {
      if (!ctx.selectionAnchor.value) ctx.startSelectionAtCursor();
      ctx.moveColumn(1);
      ctx.selectionEnd.value = { row: ctx.activeRow.value, trackIndex: ctx.activeTrack.value };
    }
  },
  {
    key: 'Escape',
    description: 'Clear selection',
    category: 'selection',
    handler: (ctx) => {
      ctx.clearSelection();
    }
  },
  {
    key: 'c',
    modifiers: { ctrl: true },
    description: 'Copy selection to clipboard',
    category: 'selection',
    handler: (ctx) => {
      ctx.copySelectionToClipboard();
    }
  },
  {
    key: 'C',
    modifiers: { ctrl: true },
    description: 'Copy selection to clipboard',
    category: 'selection',
    handler: (ctx) => {
      ctx.copySelectionToClipboard();
    }
  },
  {
    key: 'v',
    modifiers: { ctrl: true },
    description: 'Paste from clipboard',
    category: 'selection',
    handler: (ctx) => {
      ctx.pasteFromClipboard();
    }
  },
  {
    key: 'V',
    modifiers: { ctrl: true },
    description: 'Paste from clipboard',
    category: 'selection',
    handler: (ctx) => {
      ctx.pasteFromClipboard();
    }
  }
];
