"use client";

import type { Player } from "@/domain/model";
import {
  PokerTableMap,
  type PokerSeatSelection,
  type PokerTableMapProps,
} from "./poker-table-map";

type SeatAssignmentProps = PokerSeatSelection & {
  table: PokerTableMapProps["table"];
  players: Player[];
  disabled?: boolean;
};

/** Required form control sharing the floor view's table and seat geometry. */
export function SeatAssignment({
  table,
  players,
  disabled = false,
  ...selection
}: SeatAssignmentProps) {
  return (
    <PokerTableMap
      table={table}
      players={players}
      selection={selection}
      disabled={disabled}
      canCheckIn={false}
      onSeatSelect={() => {}}
    />
  );
}
