/** Internal pointer gestures carry app MIME data only. Older WKWebViews expose
 * drag interfaces whose constructors are unavailable, so keep a document-local
 * transfer when native construction fails. OS file drops still use Tauri. */
export function createInternalTransfer(): DataTransfer {
  try {
    return new DataTransfer();
  } catch {
    const data = new Map<string, string>();
    return {
      effectAllowed: "none",
      dropEffect: "none",
      get types() {
        return [...data.keys()];
      },
      setData(type: string, value: string) {
        data.set(type.toLowerCase(), value);
      },
      getData(type: string) {
        return data.get(type.toLowerCase()) ?? "";
      },
      clearData(type?: string) {
        if (type === undefined) data.clear();
        else data.delete(type.toLowerCase());
      },
      setDragImage() {},
    } as unknown as DataTransfer;
  }
}

export function createInternalDragEvent(type: string, init: DragEventInit): DragEvent {
  try {
    return new DragEvent(type, init);
  } catch {
    // React dispatches drag handlers by event type and reads dataTransfer from
    // the native event; no native DragEvent prototype is required.
    const event = new MouseEvent(type, init);
    Object.defineProperty(event, "dataTransfer", { value: init.dataTransfer ?? null });
    return event as DragEvent;
  }
}
