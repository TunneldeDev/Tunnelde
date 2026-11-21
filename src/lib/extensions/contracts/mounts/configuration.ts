/** Experimental host-owned mount API. Use api.describe to discover methods. */
export interface MountGroup {
  id: string;
  hostId: string;
  name: string;
  autoReconnect: boolean;
}
export interface MountRule {
  id: string;
  hostId: string;
  groupId: string;
  name: string;
  remotePath: string;
  mountPoint: string;
  readOnly: boolean;
  autoMount: boolean;
}
export interface MountEntry<T> {
  revision: string;
  value: T;
}
export interface MountPage<T> {
  revision: string;
  items: MountEntry<T>[];
  nextCursor: string | null;
}
export interface MountDocument {
  version: 1;
  hostId: string;
  groups: MountGroup[];
  rules: MountRule[];
}
