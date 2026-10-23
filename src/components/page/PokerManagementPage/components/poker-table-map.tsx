"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { gsap } from "gsap";
import { useDraggable, useDroppable } from "@dnd-kit/react";
import { pointerIntersection } from "@dnd-kit/collision";
import type { Player, TableRecord } from "@/domain/model";
import { displayName } from "@/lib/display-name";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useText } from "./shared";
import {
  getPokerSeatPositions,
  type PokerSeatPosition,
} from "./poker-table-geometry";
import styles from "./poker-table-map.module.css";
import { useTableSeatDrag } from "./table-seat-drag";

const seatNumbers = Array.from({ length: 9 }, (_, index) => index + 1);
// CSS chooses the appropriate server-rendered fallback before the rail is measured.
const mobilePositions = getPokerSeatPositions(177, 268);
const desktopPositions = getPokerSeatPositions(288, 192);

export type PokerTableMapProps = {
  table: Pick<TableRecord, "id" | "name" | "status">;
  players: Player[];
  onSeatSelect: (seat: number, player?: Player) => void;
  disabled: boolean;
  canCheckIn: boolean;
};

/** A seating control for real venue records; its buttons use the existing workflows. */
export function PokerTableMap({
  table,
  players,
  onSeatSelect,
  disabled,
  canCheckIn,
}: PokerTableMapProps) {
  const t = useText();
  const tableName = displayName(table.name);
  const root = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const [positions, setPositions] = useState<PokerSeatPosition[] | null>(null);
  const previousOccupancy = useRef<string | null>(null);
  const occupants = new Map(
    players
      .filter(
        (player) => player.status === "ACTIVE" && player.tableId === table.id,
      )
      .map((player) => [player.seat, player]),
  );
  const occupancy = seatNumbers
    .map((seat) => occupants.get(seat)?.id ?? "")
    .join("|");

  useEffect(() => {
    if (!rail.current) return;
    let width = 0;
    let height = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const size = entry.contentRect;
      if (size.width <= 0 || size.height <= 0) return;
      if (size.width === width && size.height === height) return;
      width = size.width;
      height = size.height;
      setPositions(getPokerSeatPositions(width, height));
    });
    observer.observe(rail.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!root.current) return;
    const media = gsap.matchMedia();
    media.add(
      "(prefers-reduced-motion: no-preference)",
      () => {
        gsap.from("[data-table-arena]", {
          y: 4,
          duration: 0.26,
          ease: "power2.out",
        });
        gsap.from("[data-seat-circle]", {
          scale: 0.96,
          duration: 0.2,
          stagger: 0.012,
          ease: "power2.out",
        });
      },
      root.current,
    );
    return () => media.revert();
  }, []);

  useEffect(() => {
    const previous = previousOccupancy.current;
    previousOccupancy.current = occupancy;
    if (previous === null || previous === occupancy || !root.current) return;
    const before = previous.split("|");
    const after = occupancy.split("|");
    const changed = seatNumbers.flatMap((seat, index) => {
      if (before[index] === after[index]) return [];
      const circle = root.current?.querySelector(
        `[data-seat="${seat}"] [data-seat-circle]`,
      );
      return circle ? [circle] : [];
    });
    if (!changed.length) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from(changed, {
        scale: 0.94,
        duration: 0.22,
        ease: "power2.out",
        overwrite: "auto",
      });
    });
    return () => media.revert();
  }, [occupancy]);

  return (
    <div ref={root} className={styles.map}>
      <div className={styles.arena} data-table-arena>
        <div
          className={styles.felt}
          data-table-felt
          data-closed={table.status === "CLOSED"}
          aria-hidden="true"
        />
        <TooltipProvider delayDuration={250}>
          <ol
            ref={rail}
            className={styles.seats}
            aria-label={tableName + " · " + t("Seat map")}
          >
            {seatNumbers.map((seat) => {
              const mobile = mobilePositions[seat - 1];
              const desktop = desktopPositions[seat - 1];
              const position = positions?.[seat - 1];
              const player = occupants.get(seat);
              return (
                <PokerSeat
                  key={seat}
                  table={table}
                  seat={seat}
                  player={player}
                  disabled={disabled || (!player && !canCheckIn)}
                  onSelect={() => onSeatSelect(seat, player)}
                  style={
                    {
                      "--mobile-seat-x": `${mobile.xPercent}%`,
                      "--mobile-seat-y": `${mobile.yPercent}%`,
                      "--desktop-seat-x": `${desktop.xPercent}%`,
                      "--desktop-seat-y": `${desktop.yPercent}%`,
                      ...(position && {
                        "--seat-x": `${position.xPercent}%`,
                        "--seat-y": `${position.yPercent}%`,
                      }),
                    } as CSSProperties
                  }
                />
              );
            })}
          </ol>
        </TooltipProvider>
      </div>
    </div>
  );
}

function PokerSeat({
  table,
  seat,
  player,
  disabled,
  onSelect,
  style,
}: {
  table: PokerTableMapProps["table"];
  seat: number;
  player?: Player;
  disabled: boolean;
  onSelect: () => void;
  style: CSSProperties;
}) {
  const t = useText();
  const move = useTableSeatDrag();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const movable = !!player && !!move?.canDrag(player.id);
  const blockedReason =
    player && move?.enabled ? move.blockedReason(player.id) : null;
  const dragging = move?.playerId === player?.id && !!player;
  const available = !!move?.enabled && !player && table.status === "OPEN";
  const label = player
    ? displayName(player.name)
    : t(table.status === "CLOSED" ? "Closed" : "Available");
  const seatLabel = displayName(table.name) + " · " + t("Seat") + " " + seat;
  const accessibleLabel = seatLabel + " · " + label;
  const { ref: dragRef } = useDraggable({
    id: "player:" + (player?.id ?? table.id + ":" + seat),
    type: "poker-player",
    disabled: !movable,
    data: { playerId: player?.id, name: label },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: "seat:" + table.id + ":" + seat,
    accept: "poker-player",
    disabled: !available,
    collisionDetector: pointerIntersection,
    data: { tableId: table.id, seat, label: seatLabel },
  });

  return (
    <li
      className={styles.seat}
      style={style}
      data-seat={seat}
      data-occupied={!!player}
      data-dragging={dragging || undefined}
      data-drop-available={(!!move?.playerId && available) || undefined}
      data-drop-target={isDropTarget || undefined}
    >
      <Tooltip
        open={tooltipOpen && !move?.playerId}
        onOpenChange={(open) => setTooltipOpen(open && !move?.playerId)}
      >
        <TooltipTrigger asChild>
          <Button
            key={movable ? "move" : "view"}
            ref={movable ? dragRef : undefined}
            type="button"
            variant="ghost"
            className={styles.seatButton}
            aria-label={accessibleLabel}
            aria-description={blockedReason ? t(blockedReason) : undefined}
            disabled={disabled}
            data-movable={movable || undefined}
            data-player-seat={player?.id}
            onContextMenu={(event) => {
              if (movable) event.preventDefault();
            }}
            onClick={() => {
              if (!move?.ignoreSeatClick()) onSelect();
            }}
          >
            <span
              ref={dropRef}
              className={styles.seatCircle}
              data-seat-circle
              aria-hidden="true"
            >
              {seat}
            </span>
            {player && (
              <span
                className={styles.seatName}
                data-player-label
                aria-hidden="true"
              >
                <PlayerSeatName name={label} />
              </span>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          <div className="max-w-60 space-y-1 break-words">
            <p>{accessibleLabel}</p>
            {movable && (
              <p className="text-xs">
                {t("Drag to move, or click to view player.")}
              </p>
            )}
            {blockedReason && <p className="text-xs">{t(blockedReason)}</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

function PlayerSeatName({ name }: { name: string }) {
  const text = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const node = text.current;
    if (!node) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      // Measure natural word wrapping first, even if the previous name was long.
      // Only overflowing captions need character wrapping for a reliable ellipsis.
      const previousBreak = node.style.wordBreak;
      node.style.wordBreak = "normal";
      const clipped =
        node.scrollHeight > node.clientHeight + 1 ||
        node.scrollWidth > node.clientWidth + 1;
      node.style.wordBreak = previousBreak;
      setTruncated(clipped);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [name]);

  return (
    <span
      ref={text}
      className={styles.seatNameText}
      data-truncated={truncated || undefined}
    >
      {name}
    </span>
  );
}
