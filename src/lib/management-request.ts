import { prototypeEnabled } from "@/prototype/config";

/** Only the separately launched prototype replaces API calls with browser state. */
export async function managementRequest(path: string, init?: RequestInit) {
  if (prototypeEnabled) {
    const { prototypeRequest } = await import("@/prototype/runtime");
    return prototypeRequest(path, init);
  }
  return fetch(path, init);
}
