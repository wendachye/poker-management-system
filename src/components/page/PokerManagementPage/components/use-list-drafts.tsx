"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  decodeListState,
  encodeListState,
  isListDraftKey,
  listDraftOwner,
  listDraftRoute,
  listDraftRoutes,
  listStateKey,
  readListLocation,
  routeForListDraft,
  sanitizeListDrafts,
  writeListLocation,
  type ListAccess,
  type ListDraftValues,
} from "@/lib/list-state";

const HISTORY_OWNER = "pokerListOwner";
const initialSnapshot = {
  owner: "",
  route: null as string | null,
  ready: false,
  revision: 0,
  values: new Map<string, ListDraftValues>() as ReadonlyMap<
    string,
    ListDraftValues
  >,
};
type ListSnapshot = typeof initialSnapshot;

/** Current read criteria only. Authentication and all financial intent remain
 * owned by their existing providers and are never restored from this store.
 */
class ListDraftController {
  private access: ListAccess | null = null;
  private values = new Map<string, ListDraftValues>();
  private snapshot: ListSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();
  private pending: "push" | "replace" | null = null;
  private locationGeneration = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initialSnapshot;

  private publish(owner: string, route: string | null, ready: boolean) {
    this.snapshot = {
      owner,
      route,
      ready,
      revision: this.snapshot.revision + 1,
      values: new Map(this.values),
    };
    this.listeners.forEach((listener) => listener());
  }
  private load(route: string) {
    try {
      const key = listStateKey(this.access, route);
      return decodeListState(
        key ? window.sessionStorage.getItem(key) : null,
        route,
      );
    } catch {
      return {};
    }
  }
  private save(route: string, values: ListDraftValues) {
    try {
      const key = listStateKey(this.access, route);
      if (key)
        window.sessionStorage.setItem(key, encodeListState(values, route));
    } catch {
      /* The URL and in-memory state remain usable when storage is denied. */
    }
  }
  private writeLocation(mode: "push" | "replace") {
    const { owner, route } = this.snapshot;
    if (
      !this.access ||
      !route ||
      listDraftRoute(window.location.pathname) !== route
    )
      return;
    const href = writeListLocation(
      window.location.href,
      route,
      this.access.branchId,
      this.values.get(route) ?? {},
    );
    if (
      href === window.location.href &&
      window.history.state?.[HISTORY_OWNER] === owner
    )
      return;
    try {
      const state = { ...window.history.state, [HISTORY_OWNER]: owner };
      if (mode === "push") window.history.pushState(state, "", href);
      else window.history.replaceState(state, "", href);
    } catch {
      /* Saving read preferences must not block an operational screen. */
    }
  }
  private queueLocation(key: string, value?: string) {
    const search = /\.(?:search|playerSearch|closeSearch)$/.test(key);
    const resetPage =
      /\.(?:page|playerPage|closePage)$/.test(key) && (!value || value === "0");
    if (this.pending) {
      if (!search && !resetPage) this.pending = "push";
      return;
    }
    this.pending = search ? "replace" : "push";
    const owner = this.snapshot.owner,
      route = this.snapshot.route,
      generation = this.locationGeneration;
    queueMicrotask(() => {
      if (generation !== this.locationGeneration) return;
      const mode = this.pending;
      this.pending = null;
      if (
        mode &&
        owner === this.snapshot.owner &&
        route === this.snapshot.route
      )
        this.writeLocation(mode);
    });
  }

  activate(access: ListAccess | null, pathname: string, fromHistory = false) {
    const owner = listDraftOwner(access),
      route = listDraftRoute(pathname);
    const changedOwner = owner !== this.snapshot.owner;
    this.locationGeneration++;
    this.pending = null;
    this.access = access ? { ...access } : null;
    if (changedOwner) {
      this.values.clear();
      if (owner)
        for (const knownRoute of listDraftRoutes)
          this.values.set(knownRoute, this.load(knownRoute));
    }
    if (!owner) {
      this.values.clear();
      this.publish("", route, false);
      return;
    }
    if (route && access) {
      const location = readListLocation(
        window.location.search,
        route,
        access.branchId,
      );
      const historyOwner: unknown = window.history.state?.[HISTORY_OWNER];
      const foreignOwner =
        typeof historyOwner === "string" && historyOwner !== owner;
      const previous = this.values.get(route) ?? this.load(route);
      const next =
        !location.foreignVenue && !foreignOwner
          ? location.present
            ? location.values
            : fromHistory
              ? {}
              : previous
          : previous;
      this.values.set(route, next);
      this.save(route, next);
    }
    this.publish(owner, route, true);
    if (route) this.writeLocation("replace");
  }

  restoreHistory() {
    this.activate(this.access, window.location.pathname, true);
  }
  patch(patch: Record<string, string | undefined>, expectedOwner: string) {
    if (
      !expectedOwner ||
      expectedOwner !== this.snapshot.owner ||
      !this.snapshot.ready
    )
      return;
    const routes = new Set<string>();
    const updated = new Map<string, ListDraftValues>();
    for (const [key, value] of Object.entries(patch)) {
      const route = routeForListDraft(key, this.snapshot.route);
      if (!route) continue;
      const next = updated.get(route) ?? { ...this.values.get(route) };
      if (value === undefined) delete next[key];
      else next[key] = value;
      updated.set(route, next);
    }
    for (const [route, raw] of updated) {
      const next = sanitizeListDrafts(raw, route);
      if (JSON.stringify(this.values.get(route) ?? {}) === JSON.stringify(next))
        continue;
      this.values.set(route, next);
      this.save(route, next);
      routes.add(route);
    }
    if (!routes.size) return;
    for (const [key, value] of Object.entries(patch)) {
      if (routeForListDraft(key, this.snapshot.route) === this.snapshot.route)
        this.queueLocation(key, value);
    }
    this.publish(this.snapshot.owner, this.snapshot.route, true);
  }
}

/** Native history preserves list state without a route fetch on each keystroke.
 * useSyncExternalStore keeps input values and back/forward navigation coherent.
 */
export function useListDrafts(access: ListAccess | null, pathname: string) {
  const [controller] = useState(() => new ListDraftController());
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  const actorId = access?.id,
    branchId = access?.branchId,
    role = access?.role;
  const scopedAccess = useMemo(
    () =>
      actorId && branchId && role ? { id: actorId, branchId, role } : null,
    [actorId, branchId, role],
  );
  const owner = listDraftOwner(access),
    route = listDraftRoute(pathname);
  useLayoutEffect(() => {
    controller.activate(scopedAccess, pathname);
  }, [controller, scopedAccess, pathname]);
  useEffect(() => {
    const restore = () => controller.restoreHistory();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [controller]);
  const ready =
    snapshot.ready && snapshot.owner === owner && snapshot.route === route;
  const draftValue = useCallback(
    (key: string) => {
      if (!ready || !isListDraftKey(key)) return undefined;
      const targetRoute = routeForListDraft(key, route);
      return targetRoute ? snapshot.values.get(targetRoute)?.[key] : undefined;
    },
    [ready, route, snapshot.values],
  );
  return {
    ready,
    draft: (key: string, fallback = "") => draftValue(key) ?? fallback,
    draftValue,
    setDraft: (key: string, value: string) =>
      controller.patch({ [key]: value }, owner),
    clearDraft: (key: string) => controller.patch({ [key]: undefined }, owner),
    patchDrafts: (values: ListDraftValues) => controller.patch(values, owner),
  };
}
