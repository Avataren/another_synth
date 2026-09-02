declare module '@vitejs/plugin-vue' {
  import type { PluginOption } from 'vite';
  export type Api = unknown;
  export type Options = unknown;
  export type ResolvedOptions = unknown;
  export type VueQuery = unknown;
  export const parseVueRequest: (...args: unknown[]) => unknown;
  const vuePlugin: (...args: unknown[]) => PluginOption;
  export default vuePlugin;
}
