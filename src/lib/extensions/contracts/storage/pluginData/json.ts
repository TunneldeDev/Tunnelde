/** Interoperable JSON: finite numbers, safe integral numbers, valid Unicode;
 * maximum depth 64 from the values object, maximum encoded map size 256 KiB. */
export type PluginStorageJson =
  | null
  | boolean
  | number
  | string
  | readonly PluginStorageJson[]
  | { readonly [key: string]: PluginStorageJson };
