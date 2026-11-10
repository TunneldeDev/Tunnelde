/** Internal host callback. Mutations require a committed provider mount. */
export type CheckProviderAccess = (mutation?: boolean) => void;
