"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DragDropProvider, DragOverlay } from "@dnd-kit/react";
import {
  Accessibility,
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/dom";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { useText } from "./shared";
import {
  playerMoveBlockedReason,
  seatMoveBlockedReason,
  seatSwapParticipant,
  seatSwapBlockedReason,
  type SeatMoveDestination,
} from "./table-seat-move";

const sensors = [
  PointerSensor.configure({
    activationConstraints(event) {
      return event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 8 })]
        : [new PointerActivationConstraints.Distance({ value: 8 })];
    },
  }),
  KeyboardSensor.configure({
    offset: 22,
    keyboardCodes: {
      start: ["Space"],
      end: ["Space", "Enter"],
      cancel: ["Escape", "Tab"],
      up: ["ArrowUp"],
      down: ["ArrowDown"],
      left: ["ArrowLeft"],
      right: ["ArrowRight"],
    },
  }),
];

type SeatDragContextValue = {
  enabled: boolean;
  playerId: string | null;
  canDrag: (playerId: string) => boolean;
  canDrop: (destination: SeatMoveDestination, occupantId?: string) => boolean;
  blockedReason: (playerId: string) => string | null;
  ignoreSeatClick: () => boolean;
};

type DragOrigin = {
  playerId: string;
  sessionId: string;
  dayId: string;
  tableId: string;
  seat: number;
};

const SeatDragContext = createContext<SeatDragContextValue | null>(null);

export function useTableSeatDrag() {
  return useContext(SeatDragContext);
}

/** Drops only propose a move or swap; explicit confirmation saves the assignment. */
export function TableSeatDragProvider({ children }: { children: ReactNode }) {
  const s = usePokerManagementContext();
  const t = useText();
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [swapName, setSwapName] = useState<string | null>(null);
  const active = useRef(false);
  const origin = useRef<DragOrigin | null>(null);
  const suppressClickUntil = useRef(0);
  const enabled =
    !!s.user &&
    s.user.role !== "DEALER" &&
    !s.locked &&
    !s.busy &&
    !s.retryRequired;

  return (
    <SeatDragContext.Provider
      value={{
        enabled,
        playerId,
        canDrag: (id) => enabled && !playerMoveBlockedReason(s.store, id),
        canDrop: (destination, occupantId) => {
          if (!enabled) return false;
          if (!playerId) return !occupantId;
          if (!occupantId)
            return !seatMoveBlockedReason(s.store, playerId, destination);
          const first = seatSwapParticipant(s.store, playerId);
          const second = seatSwapParticipant(s.store, occupantId);
          return (
            !!first &&
            !!second &&
            !seatSwapBlockedReason(s.store, first, second)
          );
        },
        blockedReason: (id) => playerMoveBlockedReason(s.store, id),
        ignoreSeatClick: () =>
          active.current || Date.now() < suppressClickUntil.current,
      }}
    >
      <DragDropProvider
        sensors={sensors}
        plugins={(defaults) => [
          ...defaults,
          Accessibility.configure({
            screenReaderInstructions: {
              draggable: t(
                "Press Space to pick up a player. Use arrow keys to choose a seat, then Space to review a move or swap. Press Escape to cancel.",
              ),
            },
            announcements: {
              dragstart: ({ operation }: DragStartEvent) =>
                t("Moving player") +
                " · " +
                String(operation.source?.data.name ?? ""),
              dragover: ({ operation }: DragOverEvent) =>
                operation.target
                  ? (operation.target.data.playerId
                      ? t("Swap with") +
                        " · " +
                        String(operation.target.data.name)
                      : t("Destination seat")) +
                    " · " +
                    String(operation.target.data.label)
                  : t("Choose a seat or press Escape to cancel."),
              dragend: ({ operation, canceled }: DragEndEvent) =>
                !canceled && operation.target
                  ? t("Review the move or swap before saving.")
                  : t("Move canceled."),
            },
          }),
        ]}
        onBeforeDragStart={(event) => {
          const id = event.operation.source?.data.playerId;
          if (
            !enabled ||
            !!s.operation ||
            typeof id !== "string" ||
            playerMoveBlockedReason(s.store, id)
          )
            event.preventDefault();
        }}
        onDragStart={({ operation }) => {
          const id = String(operation.source!.data.playerId);
          const session = s.store.sessions.find(
            (session) =>
              session.playerId === id &&
              session.dayId === s.store.currentDayId &&
              session.status === "ACTIVE",
          );
          if (!session) return;
          origin.current = {
            playerId: id,
            sessionId: session.id,
            dayId: session.dayId,
            tableId: session.tableId,
            seat: session.seat,
          };
          active.current = true;
          setPlayerId(id);
        }}
        onDragOver={({ operation }) => {
          const target = operation.target?.data;
          setSwapName(
            target?.playerId && typeof target.name === "string"
              ? target.name
              : null,
          );
        }}
        onDragEnd={({ operation, canceled }) => {
          const started = origin.current;
          origin.current = null;
          active.current = false;
          suppressClickUntil.current = Date.now() + 250;
          setPlayerId(null);
          setSwapName(null);
          const id = operation.source?.data.playerId;
          const destination = operation.target?.data;
          if (
            canceled ||
            !started ||
            !enabled ||
            !!s.operation ||
            typeof id !== "string" ||
            typeof destination?.tableId !== "string" ||
            typeof destination.seat !== "number"
          )
            return;
          if (
            id !== started.playerId ||
            s.store.currentDayId !== started.dayId ||
            !s.store.sessions.some(
              (session) =>
                session.id === started.sessionId &&
                session.playerId === started.playerId &&
                session.status === "ACTIVE" &&
                session.tableId === started.tableId &&
                session.seat === started.seat,
            )
          ) {
            toast.error(t("The player's seat changed. Try moving them again."));
            return;
          }
          const target = {
            tableId: destination.tableId,
            seat: destination.seat,
          };
          const occupant = s.store.sessions.find(
            (session) =>
              session.status === "ACTIVE" &&
              session.tableId === target.tableId &&
              session.seat === target.seat,
          );
          if (destination.playerId !== occupant?.playerId) {
            toast.error(
              t("The seating changed. Try dragging the player again."),
            );
            return;
          }
          if (occupant) {
            const first = seatSwapParticipant(s.store, id);
            const second = seatSwapParticipant(s.store, occupant.playerId);
            if (!first || !second) {
              toast.error(t("Player has no active session."));
              return;
            }
            const reason = seatSwapBlockedReason(s.store, first, second);
            if (reason) {
              toast.error(t(reason));
              return;
            }
            s.setError("");
            s.startOperation({ kind: "swap", first, second });
            return;
          }
          const reason = seatMoveBlockedReason(s.store, id, target);
          if (reason) {
            toast.error(t(reason));
            return;
          }
          s.setError("");
          s.startOperation({ kind: "move", playerId: id, ...target });
        }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {(source) => (
            <div
              aria-hidden="true"
              className="pointer-events-none relative -top-2 left-[22px] flex w-max max-w-40 -translate-x-1/2 -translate-y-full items-center gap-2 rounded-full border border-primary/30 bg-card px-3 py-2 text-sm font-medium text-foreground shadow-xl sm:max-w-60"
            >
              <ArrowRightLeft className="size-4 shrink-0" />
              <span className="truncate">
                {swapName
                  ? t("Swap with") + " " + displayName(swapName)
                  : displayName(String(source.data.name))}
              </span>
            </div>
          )}
        </DragOverlay>
      </DragDropProvider>
    </SeatDragContext.Provider>
  );
}
