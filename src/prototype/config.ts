/** The stakeholder preview is opt-in and never enabled by a URL or cookie. */
export const prototypeEnabled =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_POKER_PROTOTYPE === "1";
