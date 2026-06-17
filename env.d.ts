/// <reference types="vite/client" />

interface Window {
  __LATTICE_THEME__?: { mode: "light" | "dark" | "system"; dark: boolean };
}

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
