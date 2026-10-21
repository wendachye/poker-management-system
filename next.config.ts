import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

if (
  process.env.NODE_ENV === "production" &&
  (process.env.NEXT_PUBLIC_POKER_PROTOTYPE === "1") !==
    (process.env.POKER_PROTOTYPE_MODE === "1")
)
  throw new Error(
    "The prototype public and server flags must be enabled together.",
  );

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: process.env.POKER_PROTOTYPE_MODE === "1" ? false : undefined,
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
