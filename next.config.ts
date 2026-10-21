import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
