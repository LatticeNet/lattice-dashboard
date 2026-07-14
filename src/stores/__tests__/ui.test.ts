import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";
import { useUiStore } from "../ui.ts";

class MemoryStorage {
  #data = new Map<string, string>();

  clear() {
    this.#data.clear();
  }

  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key) ?? null : null;
  }

  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#data.delete(key);
  }

  setItem(key: string, value: string) {
    this.#data.set(key, String(value));
  }

  get length(): number {
    return this.#data.size;
  }
}

function installStorage(values: Record<string, string> = {}) {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  (globalThis as { localStorage?: MemoryStorage }).localStorage = storage;
  return storage;
}

test("ui store clamps the persisted desktop sidebar width on load", () => {
  installStorage({ "lattice.ui.sidebarDesktopWidth": "999" });
  setActivePinia(createPinia());

  const ui = useUiStore();

  assert.equal(ui.sidebarDesktopWidth, 360);
});

test("ui store persists desktop sidebar width updates and resets", () => {
  const storage = installStorage();
  setActivePinia(createPinia());

  const ui = useUiStore();
  assert.equal(ui.sidebarDesktopWidth, 240);
  ui.setSidebarDesktopWidth(280);
  assert.equal(ui.sidebarDesktopWidth, 280);
  assert.equal(storage.getItem("lattice.ui.sidebarDesktopWidth"), "280");

  ui.setSidebarDesktopWidth(999);
  assert.equal(ui.sidebarDesktopWidth, 360);
  assert.equal(storage.getItem("lattice.ui.sidebarDesktopWidth"), "360");

  ui.resetSidebarDesktopWidth();
  assert.equal(ui.sidebarDesktopWidth, 240);
  assert.equal(storage.getItem("lattice.ui.sidebarDesktopWidth"), "240");
});
