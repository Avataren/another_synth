/* eslint-disable */

declare const __APP_VERSION__: string;
declare const __APP_GIT_HASH__: string;

declare namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string;
    VUE_ROUTER_MODE: 'hash' | 'history' | 'abstract' | undefined;
    VUE_ROUTER_BASE: string | undefined;
  }
}
