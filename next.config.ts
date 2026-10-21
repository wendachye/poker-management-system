import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

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
