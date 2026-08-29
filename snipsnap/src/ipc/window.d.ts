import type { SnipSnapApi } from './contracts';

declare global {
  interface Window {
    snipsnap: SnipSnapApi;
  }
}

export {};
