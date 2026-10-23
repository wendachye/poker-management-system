import { mutationSchema, type Command } from "@/domain/commands";
import { locationCommandSchema } from "@/domain/locations";
import type { Branch, Role, Snapshot, Staff, Store } from "@/domain/model";
import { applyCommand, DomainError } from "@/domain/operations";
import { emptyStore } from "@/domain/selectors";
import { defaultSettings } from "@/domain/settings";
import { staffMutationSchema, type StaffCommand } from "@/domain/staff";
import {
  createPrototypeJourney,
  observeJourneyCommand,
  type PrototypeJourney,
  type PrototypeJourneyId,
} from "./journeys";
import {
  createPrototypeAccounts,
  createPrototypeSample,
  prototypePersonas,
  prototypeScenarios,
  type PrototypeAccount,
  type PrototypePersonaId,
  type PrototypeScenario,
} from "./sample-data";

export { prototypePersonas, prototypeScenarios };
export type { PrototypeScenario };
export type PrototypeInfo = {
  scenario: PrototypeScenario;
  personaId: string;
  generation: number;
  journey: PrototypeJourney | null;
};
type Venue = {
  branch: Omit<Branch, "role">;
  store: Store;
  accounts: PrototypeAccount[];
  revision: number;
};
type Runtime = {
  info: PrototypeInfo;
  branchId: string;
  venues: Map<string, Venue>;
  operations: Map<string, { actorId: string; fingerprint: string }>;
};

// PROTOTYPE ONLY: no storage, fetch, server modules, credentials or database connection.
let runtime: Runtime | undefined;
let sequence = 0;
const listeners = new Set<() => void>();

function initialRuntime(
  scenario: PrototypeScenario,
  generation: number,
): Runtime {
  const venues = new Map<string, Venue>();
  for (const [id, name] of [
    ["demo-city", "City Centre"],
    ["demo-riverside", "Riverside"],
  ]) {
    const sample = createPrototypeSample(id, name, scenario);
    venues.set(id, {
      branch: { id, name, timezone: "Asia/Kuala_Lumpur" },
      ...sample,
      revision: ++sequence,
    });
  }
  return {
    info: { scenario, personaId: "admin", generation, journey: null },
    branchId: "demo-city",
    venues,
    operations: new Map(),
  };
}
function state() {
  runtime ??= initialRuntime("busy", 0);
  return runtime;
}
function currentVenue() {
  return state().venues.get(state().branchId)!;
}
function currentUser(venue = currentVenue()): Staff {
  const account = venue.accounts.find(
    (entry) => entry.personaId === state().info.personaId && entry.active,
  );
  if (!account)
    throw new DomainError(
      "This sample staff account is disabled. Select another demo role.",
      403,
    );
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    branchId: venue.branch.id,
  };
}
function branches(): Branch[] {
  return [...state().venues.values()].map((venue) => ({
    ...venue.branch,
    role:
      venue.accounts.find((entry) => entry.personaId === state().info.personaId)
        ?.role ?? "ADMIN",
  }));
}
function snapshot(): Snapshot {
  const venue = currentVenue();
  const user = currentUser();
  return {
    revision: venue.revision,
    branch: { ...venue.branch, role: user.role },
    user,
    store: venue.store,
  };
}
function emit() {
  state().info = { ...state().info };
  for (const listener of listeners) listener();
}
export function getPrototypeInfo(): PrototypeInfo {
  return state().info;
}
export function getPrototypeRoleOptions(): {
  id: PrototypePersonaId;
  role: Role;
  active: boolean;
}[] {
  const accounts = currentVenue().accounts;
  return prototypePersonas.map((persona) => {
    const account = accounts.find((entry) => entry.personaId === persona.id);
    return {
      id: persona.id,
      role: account?.role ?? persona.role,
      active: account?.active ?? false,
    };
  });
}
export function subscribePrototype(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setPrototypePersona(id: string) {
  if (!prototypePersonas.some((persona) => persona.id === id))
    throw new Error("Select a sample staff role.");
  if (
    !currentVenue().accounts.some(
      (account) => account.personaId === id && account.active,
    )
  )
    throw new Error(
      "This sample staff member is disabled. Reset the demo or choose another role.",
    );
  state().info = { ...state().info, personaId: id };
  emit();
}
export function resetPrototype(scenario = state().info.scenario) {
  if (!prototypeScenarios.some((entry) => entry.id === scenario))
    throw new Error("Select a sample scenario.");
  runtime = initialRuntime(scenario, state().info.generation + 1);
  emit();
}
export function startPrototypeJourney(id: PrototypeJourneyId) {
  runtime = initialRuntime("walkthrough", state().info.generation + 1);
  const venue = currentVenue();
  state().info = {
    ...state().info,
    personaId: "cashier",
    journey: createPrototypeJourney(
      id,
      venue.branch.id,
      venue.store,
      venue.accounts.find((account) => account.personaId === "cashier")!.id,
    ),
  };
  emit();
}
function administrator() {
  const actor = currentUser();
  if (actor.role !== "ADMIN")
    throw new DomainError("Only an admin can manage staff and locations.", 403);
  return actor;
}
function audit(
  action: string,
  entity: string,
  reason: string,
  before?: string,
  after?: string,
) {
  const actor = currentUser();
  currentVenue().store.auditLogs.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    actor: actor.username,
    actorId: actor.id,
    action,
    entity,
    reason,
    before,
    after,
  });
}
function manageStaff(command: StaffCommand) {
  const actor = administrator();
  const venue = currentVenue();
  if (command.kind === "STAFF_CREATE") {
    if (venue.accounts.some((account) => account.username === command.username))
      throw new DomainError(
        "That username is unavailable. Choose another username.",
        409,
      );
    const account: PrototypeAccount = {
      id: crypto.randomUUID(),
      username: command.username,
      role: command.role,
      active: true,
      sharedAccount: false,
    };
    venue.accounts.push(account);
    audit(
      "Created staff account",
      account.id,
      command.reason,
      undefined,
      JSON.stringify(account),
    );
    return;
  }
  const account = venue.accounts.find((entry) => entry.id === command.userId);
  if (!account)
    throw new DomainError("Staff account was not found in this branch.", 404);
  if (account.id === actor.id)
    throw new DomainError("Ask another admin to change your own account.", 403);
  if (
    account.active &&
    account.role === "ADMIN" &&
    (command.kind === "STAFF_DISABLE" ||
      (command.kind === "STAFF_ROLE" && command.role !== "ADMIN")) &&
    !venue.accounts.some(
      (entry) =>
        entry.id !== account.id && entry.active && entry.role === "ADMIN",
    )
  )
    throw new DomainError(
      "Keep at least one active admin in this branch.",
      409,
    );
  const before = JSON.stringify(account);
  if (command.kind === "STAFF_ROLE") {
    account.role = command.role;
    audit(
      "Changed staff role",
      account.id,
      command.reason,
      before,
      JSON.stringify(account),
    );
  } else if (command.kind === "STAFF_DISABLE") {
    account.active = false;
    audit(
      "Disabled staff account",
      account.id,
      command.reason,
      before,
      JSON.stringify(account),
    );
  } else {
    account.active = command.enable || account.active;
    audit(
      command.enable ? "Enabled staff account" : "Reset staff password",
      account.id,
      command.reason,
      before,
      JSON.stringify(account),
    );
  }
}
function completeSetupStaff() {
  const accounts = currentVenue().accounts.filter((account) => account.active);
  const operators = accounts.filter(
    (account) => account.role === "CASHIER" || account.role === "MANAGER",
  );
  if (!operators.length)
    throw new DomainError(
      "Add an active cashier or manager before completing setup.",
    );
  if (
    !operators.some((operator) =>
      accounts.some(
        (reviewer) =>
          reviewer.id !== operator.id &&
          (reviewer.role === "MANAGER" || reviewer.role === "ADMIN"),
      ),
    )
  )
    throw new DomainError(
      "Add an independent manager or administrator to review transactions before completing setup.",
    );
}

/** Implements the app's request contract entirely in browser memory for presentations. */
export async function prototypeRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    const method = init?.method?.toUpperCase() ?? "GET";
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/api/auth") {
      if (method === "POST") {
        const username = String(payload.username ?? "").toLowerCase();
        const persona = prototypePersonas.find(
          (entry) => entry.id === username || `demo.${entry.id}` === username,
        );
        if (!persona)
          throw new DomainError(
            "Choose a sample role using the prototype controls.",
            401,
          );
        setPrototypePersona(persona.id);
      } else if (method === "DELETE") {
        setPrototypePersona("admin");
      }
      return Response.json({ user: currentUser(), branches: branches() });
    }
    if (path === "/api/branch" && method === "POST") {
      const venue = state().venues.get(payload.branchId);
      if (!venue) throw new DomainError("Location not found.", 404);
      const user = currentUser(venue);
      state().branchId = payload.branchId;
      emit();
      return Response.json({ user, branches: branches() });
    }
    if (path === "/api/state" && method === "GET")
      return Response.json(snapshot());
    if (path === "/api/staff" && method === "GET") {
      administrator();
      return Response.json({
        branchId: state().branchId,
        accounts: currentVenue().accounts.map((account) => ({
          id: account.id,
          username: account.username,
          role: account.role,
          active: account.active,
          sharedAccount: account.sharedAccount,
        })),
      });
    }
    if (path === "/api/locations" && method === "GET")
      return Response.json({ branches: branches() });
    if (
      method !== "POST" ||
      !["/api/state", "/api/staff", "/api/locations"].includes(path)
    )
      throw new DomainError(
        "This action is not part of the frontend prototype.",
        404,
      );
    const venue = currentVenue();
    const actor = currentUser();
    if (payload.branchId !== venue.branch.id)
      throw new DomainError(
        "Your active branch changed. Reload this page before continuing.",
        409,
      );
    const operationId = payload.operationId;
    if (
      typeof operationId !== "string" ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        operationId,
      )
    )
      throw new DomainError("Invalid operation identifier.");
    // Password values are deliberately ignored, never saved even in retry metadata.
    const fingerprint = JSON.stringify({
      ...payload.command,
      password: undefined,
    });
    const operationKey = `${venue.branch.id}:${operationId}`;
    const prior = state().operations.get(operationKey);
    if (prior) {
      if (prior.actorId !== actor.id || prior.fingerprint !== fingerprint)
        throw new DomainError("Operation identifier was already used.", 409);
      return Response.json(snapshot());
    }
    if (payload.revision !== venue.revision)
      throw new DomainError(
        "Another staff member updated this branch. Records have been refreshed; review them and try again.",
        409,
      );
    if (path === "/api/state") {
      const parsed = mutationSchema.safeParse(payload);
      if (!parsed.success)
        throw new DomainError("Invalid operation. Check the supplied fields.");
      const command: Command = parsed.data.command;
      if (command.kind === "COMPLETE_SETUP") completeSetupStaff();
      const before = venue.store;
      venue.store = applyCommand(before, command, actor);
      if (state().info.journey) {
        state().info = {
          ...state().info,
          journey: observeJourneyCommand(
            state().info.journey!,
            before,
            venue.store,
            command,
            actor,
          ),
        };
      }
      if (command.kind === "UPDATE_SETTINGS") {
        venue.branch.name = command.settings.venueName;
        venue.branch.timezone = command.settings.timezone;
      }
    } else if (path === "/api/staff") {
      const parsed = staffMutationSchema.safeParse(payload);
      if (!parsed.success)
        throw new DomainError(
          "Check the username, password, role, and reason.",
        );
      manageStaff(parsed.data.command);
    } else {
      administrator();
      const parsed = locationCommandSchema.safeParse(payload.command);
      if (!parsed.success)
        throw new DomainError("Check the location code, name, and time zone.");
      const command = parsed.data;
      if (state().venues.has(command.id))
        throw new DomainError("That location code is already in use.", 409);
      const store = emptyStore();
      store.settings = {
        ...defaultSettings(),
        venueName: command.name,
        timezone: command.timezone,
      };
      state().venues.set(command.id, {
        branch: {
          id: command.id,
          name: command.name,
          timezone: command.timezone,
        },
        store,
        accounts: createPrototypeAccounts(command.id),
        revision: ++sequence,
      });
      audit(
        "Created location",
        command.id,
        command.name,
        undefined,
        JSON.stringify({ name: command.name, timezone: command.timezone }),
      );
    }
    venue.revision = ++sequence;
    state().operations.set(operationKey, { actorId: actor.id, fingerprint });
    const result = Response.json(snapshot());
    emit();
    return result;
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The demo operation could not be completed.",
      },
      { status: error instanceof DomainError ? error.status : 400 },
    );
  }
}
