import type { RuntimeResource } from "./resource.js";
export interface RuntimeResourcesQuery {
  offset?: number;
  /** Required after the first page; restart from zero on a changed observation. */
  revision?: string;
}
export interface RuntimeResourcesSnapshot {
  revision: string;
  items: RuntimeResource[];
  total: number;
  nextOffset: number | null;
}
