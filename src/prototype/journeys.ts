import type { Command } from "@/domain/commands";
import type { EntryType, Staff, Store } from "@/domain/model";
import { entryType, totalsForDay } from "@/domain/selectors";
import type { PrototypePersonaId } from "./sample-data";

export type PrototypeJourneyId = "cash" | "credit" | "exceptions";
export const prototypeJourneys = [
  {
    id: "cash",
    label: "Cash player",
    detail: "Alex Tan · RM500 buy-in · RM700 cash-out",
  },
  {
    id: "credit",
    label: "Credit player",
    detail: "Sara Lee · RM500 credit · RM200 repayment · RM700 chips",
  },
  {
    id: "exceptions",
    label: "Corrections and closing",
    detail: "Reject a duplicate, correct rake and explain a cash shortage.",
  },
] as const;

export type PrototypeJourney = {
  id: PrototypeJourneyId;
  branchId: string;
  dayId: string;
  cashierId: string;
  tableId: string;
  playerId?: string;
  sessionId?: string;
  requests: Record<string, string>;
};
type JourneyAction =
  | { kind: "check-in" }
  | { kind: "request"; type: EntryType; amount: number }
  | { kind: "review"; requestId: string; reject?: boolean }
  | { kind: "reversal"; transactionId: string }
  | { kind: "close"; countedCash: number };
export type JourneyStep = {
  id: string;
  title: string;
  detail: string;
  persona: PrototypePersonaId;
  complete: boolean;
  action: JourneyAction;
};

export function createPrototypeJourney(
  id: PrototypeJourneyId,
  branchId: string,
  store: Store,
  cashierId: string,
): PrototypeJourney {
  return {
    id,
    branchId,
    dayId: store.currentDayId!,
    cashierId,
    tableId: store.tables.find((table) => table.status === "OPEN")!.id,
    playerId:
      id === "exceptions"
        ? undefined
        : store.profiles.find(
            (player) =>
              player.phone ===
              (id === "cash" ? "+12025550100" : "+12025550103"),
          )!.id,
    requests: {},
  };
}

/** The guide observes exact records created during this run; it never posts an entry. */
export function journeyProgress(
  run: PrototypeJourney,
  store: Store,
  branchId: string,
) {
  const steps: JourneyStep[] = [];
  const day = store.days.find((entry) => entry.id === run.dayId);
  const session = store.sessions.find((entry) => entry.id === run.sessionId);
  const request = (key: string) =>
    store.approvals.find((entry) => entry.id === run.requests[key]);
  const transaction = (key: string) =>
    store.transactions.find(
      (entry) =>
        entry.approvalId === run.requests[key] && entry.dayId === run.dayId,
    );
  const approved = (key: string) =>
    request(key)?.status === "APPROVED" && !!transaction(key);
  const boundRequests = new Set(Object.values(run.requests));
  const inScope = (entry: { playerId?: string; sessionId?: string }) =>
    !!run.playerId &&
    (entry.playerId === run.playerId ||
      (!!run.sessionId && entry.sessionId === run.sessionId));
  const extraRequest = store.approvals.some(
    (entry) =>
      entry.dayId === run.dayId &&
      entry.status !== "REJECTED" &&
      !boundRequests.has(entry.id) &&
      (run.id === "exceptions"
        ? entry.type === "Rake" ||
          (entry.type === "Reversal" &&
            store.transactions.some(
              (original) =>
                original.id === entry.reversesId &&
                entryType(store, original) === "Rake",
            ))
        : inScope(entry)),
  );
  const extraEntry = store.transactions.some(
    (entry) =>
      entry.dayId === run.dayId &&
      !boundRequests.has(entry.approvalId) &&
      (run.id === "exceptions"
        ? entryType(store, entry) === "Rake"
        : inScope(entry)),
  );
  const unexpectedSession =
    run.id !== "exceptions" &&
    (store.sessions.some(
      (entry) =>
        entry.dayId === run.dayId &&
        entry.playerId === run.playerId &&
        entry.id !== run.sessionId,
    ) ||
      (session?.status === "OUT" && !approved("cash-out")));
  function entry(
    key: string,
    title: string,
    detail: string,
    type: EntryType,
    amount: number,
  ) {
    steps.push({
      id: key,
      title,
      detail,
      persona: "cashier",
      complete: !!request(key),
      action: { kind: "request", type, amount },
    });
  }
  function review(
    key: string,
    title: string,
    detail: string,
    persona: PrototypePersonaId,
    reject = false,
  ) {
    steps.push({
      id: key + "-review",
      title,
      detail,
      persona,
      complete: reject ? request(key)?.status === "REJECTED" : approved(key),
      action: { kind: "review", requestId: run.requests[key] ?? "", reject },
    });
  }
  if (run.id !== "exceptions") {
    steps.push({
      id: "check-in",
      title: run.id === "cash" ? "Check in Alex Tan" : "Check in Sara Lee",
      detail:
        "Choose a free seat. Check-in reserves the seat; it does not issue chips.",
      persona: "cashier",
      complete: !!session,
      action: { kind: "check-in" },
    });
    entry(
      "buy-in",
      run.id === "cash"
        ? "Request RM500 cash buy-in"
        : "Request RM500 credit buy-in",
      "Enter RM500 and request approval. Balances change only after approval.",
      "Buy-in",
      50000,
    );
    review(
      "buy-in",
      "Approve the buy-in",
      "Review the selected request as an independent manager.",
      "manager",
    );
    if (run.id === "credit") {
      entry(
        "repayment",
        "Request RM200 credit repayment",
        "Enter RM200. Approval receives cash and reduces Sara's debt from RM500 to RM300.",
        "Credit Repayment",
        20000,
      );
      review(
        "repayment",
        "Approve the repayment",
        "Review the selected repayment as an independent manager.",
        "manager",
      );
    }
    entry(
      "cash-out",
      "Request RM700 cash-out",
      run.id === "cash"
        ? "Enter RM700 in chips returned. The cash payout is RM700."
        : "Enter RM700 in chips returned. Settle RM300 debt and pay RM400 cash.",
      "Cash-out",
      70000,
    );
    review(
      "cash-out",
      "Approve the cash-out",
      "Review the selected request as admin. Approval checks the player out and releases their seat.",
      "admin",
    );
  } else {
    entry(
      "original",
      "Request Rake RM50",
      "Use the selected table, House / no player, and enter RM50.",
      "Rake",
      5000,
    );
    review(
      "original",
      "Approve the original rake",
      "The original RM50 rake posts only after independent approval.",
      "manager",
    );
    entry(
      "duplicate",
      "Request a duplicate Rake RM50",
      "Enter another RM50 for the same table. This duplicate will be rejected.",
      "Rake",
      5000,
    );
    review(
      "duplicate",
      "Reject the duplicate",
      "Choose Reject and give the reason: Duplicate rake entry. Cash stays unchanged.",
      "manager",
      true,
    );
    steps.push({
      id: "reversal",
      title: "Request reversal of the original rake",
      detail:
        "On the selected original RM50 row, choose Request reversal and explain the incorrect amount.",
      persona: "cashier",
      complete: !!request("reversal"),
      action: {
        kind: "reversal",
        transactionId: transaction("original")?.id ?? "",
      },
    });
    review(
      "reversal",
      "Approve the reversal",
      "An independent admin approves the reversal. The original stays visible and its RM50 is offset.",
      "admin",
    );
    entry(
      "replacement",
      "Request replacement Rake RM30",
      "Enter RM30 for the same table. The reversal and replacement make net rake RM30.",
      "Rake",
      3000,
    );
    review(
      "replacement",
      "Approve the replacement",
      "Review the selected replacement as an independent manager.",
      "manager",
    );
  }
  const expectedCash = totalsForDay(store, run.dayId).expectedCash;
  const shortage = run.id === "exceptions";
  const close = day?.closes.at(-1);
  steps.push({
    id: "close",
    title: shortage ? "Close with RM10 shortage" : "Close with no variance",
    detail: shortage
      ? "Count RM10 less than expected and explain the shortage. Resolve all active visits and pending requests first."
      : "Count the expected cash shown below. Resolve all active visits and pending requests before closing.",
    persona: "admin",
    complete:
      day?.status === "CLOSED" && close?.variance === (shortage ? -1000 : 0),
    action: {
      kind: "close",
      countedCash: expectedCash - (shortage ? 1000 : 0),
    },
  });
  let problem = "";
  if (branchId !== run.branchId)
    problem = "Return to the original venue or restart this journey.";
  else if (store.currentDayId !== run.dayId || !day)
    problem = "The business day changed. Restart this journey.";
  else if (extraRequest || extraEntry || unexpectedSession)
    problem = "Unexpected entries changed this example. Restart this journey.";
  else if (
    Object.entries(run.requests).some(
      ([key]) => key !== "duplicate" && request(key)?.status === "REJECTED",
    )
  )
    problem =
      "A required request was rejected. Restart this journey to try again.";
  else if (
    run.id !== "exceptions" &&
    Object.keys(run.requests).some((key) => {
      const posted = transaction(key);
      return (
        posted &&
        store.transactions.some((entry) => entry.reversesId === posted.id)
      );
    })
  )
    problem =
      "A journey entry was reversed. Restart this journey to follow the original example.";
  else if (
    run.id === "exceptions" &&
    request("duplicate")?.status === "APPROVED"
  )
    problem =
      "The duplicate was approved. Restart this journey to demonstrate rejection.";
  else if (
    run.id === "exceptions" &&
    transaction("original") &&
    store.transactions.some(
      (entry) =>
        entry.reversesId === transaction("original")!.id &&
        entry.approvalId !== run.requests.reversal,
    )
  )
    problem =
      "A journey entry was reversed. Restart this journey to follow the original example.";
  else if (
    run.id === "exceptions" &&
    transaction("replacement") &&
    store.transactions.some(
      (entry) => entry.reversesId === transaction("replacement")!.id,
    )
  )
    problem =
      "A journey entry was reversed. Restart this journey to follow the original example.";
  else if (
    day.status === "CLOSED" &&
    steps.slice(0, -1).every((step) => step.complete) &&
    !steps.at(-1)!.complete
  )
    problem =
      "The closing variance differs from this example. Restart this journey.";
  else if (day.status === "CLOSED" && steps.some((step) => !step.complete))
    problem =
      "The day closed before this journey finished. Restart this journey.";
  const index = steps.findIndex((step) => !step.complete);
  return {
    steps,
    index,
    current: index < 0 ? null : steps[index],
    complete: index < 0 && !problem,
    problem,
    expectedCash,
  };
}

/** Bind only the next expected command from the designated cashier to this run. */
export function observeJourneyCommand(
  run: PrototypeJourney,
  before: Store,
  after: Store,
  command: Command,
  actor: Staff,
): PrototypeJourney {
  if (actor.branchId !== run.branchId || actor.id !== run.cashierId) return run;
  const progress = journeyProgress(run, before, actor.branchId);
  const step = progress.current;
  if (!step || progress.problem) return run;
  if (command.kind === "CHECK_IN" && step.action.kind === "check-in") {
    const session = after.sessions.find(
      (entry) =>
        entry.dayId === run.dayId &&
        entry.playerId === run.playerId &&
        entry.status === "ACTIVE" &&
        !before.sessions.some((previous) => previous.id === entry.id),
    );
    return session ? { ...run, sessionId: session.id } : run;
  }
  const created = after.approvals.find(
    (entry) => !before.approvals.some((old) => old.id === entry.id),
  );
  if (
    !created ||
    created.dayId !== run.dayId ||
    created.requestedById !== run.cashierId
  )
    return run;
  const matchesRequest =
    command.kind === "REQUEST" &&
    step.action.kind === "request" &&
    command.type === step.action.type &&
    command.amount === step.action.amount &&
    (run.id === "exceptions"
      ? !created.playerId && created.tableId === run.tableId
      : created.playerId === run.playerId &&
        (created.type === "Credit Repayment" ||
          created.sessionId === run.sessionId));
  const matchesReversal =
    command.kind === "CORRECT" &&
    step.action.kind === "reversal" &&
    command.transactionId === step.action.transactionId;
  return matchesRequest || matchesReversal
    ? { ...run, requests: { ...run.requests, [step.id]: created.id } }
    : run;
}
