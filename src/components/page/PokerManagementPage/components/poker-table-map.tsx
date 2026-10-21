"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { gsap } from "gsap";
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
              const playerName = player ? displayName(player.name) : undefined;
              const label =
                playerName ??
                t(table.status === "CLOSED" ? "Closed" : "Available");
              const accessibleLabel =
                tableName + " · " + t("Seat") + " " + seat + " · " + label;
              return (
                <li
                  key={seat}
                  className={styles.seat}
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
                  data-seat={seat}
                  data-occupied={!!player}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className={styles.seatButton}
                        aria-label={accessibleLabel}
                        disabled={disabled || (!player && !canCheckIn)}
                        onClick={() => onSeatSelect(seat, player)}
                      >
                        <span
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
                      <p className="max-w-60 break-words">{accessibleLabel}</p>
                    </TooltipContent>
                  </Tooltip>
                </li>
              );
            })}
          </ol>
        </TooltipProvider>
      </div>
    </div>
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
