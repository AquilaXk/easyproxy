/// <reference types="vite/client" />

// Injected at build time by vite.config.ts `define` as the UI version fallback.
declare global {
  const __APP_VERSION__: string;
}

declare module "react" {
  interface InputHTMLAttributes<T> {
    switch?: "" | boolean;
  }
}

export {};
