import { useState, type Dispatch, type SetStateAction } from "react";
export type SettingsControlState = <T>(key: string, initial: T) => [T, Dispatch<SetStateAction<T>>];
/** Default only for the owning document; not a cross-window store. */
export const useLocalControlState: SettingsControlState = (_key, initial) => useState(initial);
