/** One in-memory preference namespace per rendering document. */
export function isolateStorage() {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(String(key), String(value));
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}
