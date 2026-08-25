import { Store, storeById } from "./models";

export function describeStore(s: Store): string {
  return s.name;
}

export const first = storeById(1);
