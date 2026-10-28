import { prototypeEnabled } from "@/prototype/config";
import { requestManagementJson } from "./management-response";

/** Only the separately launched prototype replaces API calls with browser state. */
export async function managementRequest(path: string, init?: RequestInit) {
  if (prototypeEnabled) {
    const { prototypeRequest } = await import("@/prototype/runtime");
    return prototypeRequest(path, init);
  }
  return fetch(path, init);
}

export function managementJson<T>(path: string, init?: RequestInit) {
  return requestManagementJson<T>(
    (signal) => managementRequest(path, { ...init, signal }),
    init?.signal,
  );
}
