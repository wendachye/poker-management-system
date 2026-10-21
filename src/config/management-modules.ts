export const settingsModules = {
  venue: {
    title: "Venue and rules",
    description:
      "Manage location details, game rules, buy-ins, rake, and tips.",
  },
  tables: {
    title: "Tables and stakes",
    description: "Configure tables, dealers, stakes, and buy-in overrides.",
  },
  locations: {
    title: "Locations",
    description: "Manage separate venues and switch between their records.",
  },
  setup: {
    title: "Setup checklist",
    description: "Review venue rules, staff access, and tables before opening.",
  },
  staff: {
    title: "Staff accounts",
    description: "Manage staff roles and account access for this location.",
  },
} as const;

export const adminModules = {
  audit: {
    title: "Audit history",
    description: "Find staff activity and inspect recorded changes.",
  },
  policy: {
    title: "Approval policy",
    description: "Review approval thresholds and independent reviewer rules.",
  },
  recovery: {
    title: "Day recovery",
    description: "Reopen a closed business day with an audited reason.",
  },
} as const;

export type SettingsSection = keyof typeof settingsModules;
export type AdminSection = keyof typeof adminModules;

export function isSettingsSection(value: string): value is SettingsSection {
  return Object.hasOwn(settingsModules, value);
}

export function isAdminSection(value: string): value is AdminSection {
  return Object.hasOwn(adminModules, value);
}
