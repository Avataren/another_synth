// Vitest setup file
// This runs before all tests

import { beforeAll, vi } from 'vitest';

// Mock browser APIs that aren't available in test environment
beforeAll(() => {
  // Mock AudioContext if needed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.AudioContext = vi.fn() as any;

  // Mock atob/btoa for base64 operations
  if (typeof global.atob === 'undefined') {
    global.atob = (str: string) => Buffer.from(str, 'base64').toString('binary');
  }
  if (typeof global.btoa === 'undefined') {
    global.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
  }
});

// Surface unexpected errors during test boot so the worker doesn't exit silently
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception in Vitest worker', err);
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection in Vitest worker', reason);
});
