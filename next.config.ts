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
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
        ],
      },
    ];
  },
  turbopack: {
    root: process.cwd(),
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
