import type { Store } from "../../src/domain/model";
import { emptyStore } from "../../src/domain/selectors";
import { defaultSettings } from "../../src/domain/settings";

// Synthetic names deliberately exercise wrapping, truncation and Unicode rendering.
export const TABLE_LAYOUT_NAMES = [
  "Alex Lin",
  "Alexandria Catherine Montgomery-Wellington",
  "ChristopherMaximilianAlexanderMontgomeryWellington",
  "陳嘉豪林美玲黃志明歐陽文慧",
  "Nur Aisyah binti Muhammad Abdullah",
  "Jean-Baptiste de Saint-Exupéry",
  "Li",
  "María José Fernández de la Cruz",
  "王小明",
] as const;

/** Disposable UI-only state. It contains no ledger entries or approval requests. */
export function tableLayoutFixture(): Store {
  const dayId = "qa-layout-day-2026-10-21";
  const tableId = "qa-layout-full";
  const sessionStart = "2026-10-21T02:00:00.000Z";

  return {
    ...emptyStore(),
    settings: {
      ...defaultSettings(),
      setupCompleted: true,
      venueName: "UI Test Venue",
      smallBlind: 500,
      bigBlind: 1000,
      minBuyIn: 20000,
      maxBuyIn: 500000,
      buyInStep: 5000,
    },
    currentDayId: dayId,
    days: [
      {
        id: dayId,
        date: "2026-10-21",
        openedAt: sessionStart,
        openingCash: 0,
        status: "OPEN",
        closes: [],
      },
    ],
    tables: [
      { id: tableId, name: "Long-name layout", dealer: "", status: "OPEN" },
      {
        id: "qa-layout-empty",
        name: "Empty layout",
        dealer: "",
        status: "OPEN",
      },
      {
        id: "qa-layout-closed",
        name: "Closed layout",
        dealer: "",
        status: "CLOSED",
      },
    ],
    profiles: TABLE_LAYOUT_NAMES.map((name, index) => ({
      id: `qa-layout-player-${index + 1}`,
      name,
      phone: `010900000${index + 1}`,
      type: "CASH",
      creditLimit: 0,
      tags: [],
    })),
    sessions: TABLE_LAYOUT_NAMES.map((_, index) => ({
      id: `qa-layout-session-${index + 1}`,
      playerId: `qa-layout-player-${index + 1}`,
      dayId,
      status: "ACTIVE",
      tableId,
      seat: index + 1,
      sessionStart,
    })),
  };
}
