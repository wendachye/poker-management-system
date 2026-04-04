import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const LOCALES = ["en", "zh"] as const;
const DEFAULT_LOCALE = "en";

const PUBLIC_ROUTES = ["/login"];

function getLocaleFromPath(pathname: string): string | null {
  const segments = pathname.split("/");
  const maybeLocale = segments[1];

  if (LOCALES.includes(maybeLocale as (typeof LOCALES)[number])) {
    return maybeLocale;
  }

  return null;
}

function removeLocaleFromPath(pathname: string, locale: string): string {
  if (pathname === `/${locale}`) return "/";

  const newPath = pathname.replace(`/${locale}`, "");
  return newPath || "/";
}

function isPublicRoute(pathnameWithoutLocale: string): boolean {
  return PUBLIC_ROUTES.some((route) => {
    return (
      pathnameWithoutLocale === route ||
      pathnameWithoutLocale.startsWith(`${route}/`)
    );
  });
}

export function proxy(request: NextRequest) {
  const { nextUrl, cookies } = request;
  const { pathname, search } = nextUrl;

  const isLoggedIn = Boolean(cookies.get("user")?.value);

  // 1) Detect locale from URL
  const localeFromPath = getLocaleFromPath(pathname);

  // 2) If no locale in URL, redirect using cookie or default locale
  if (!localeFromPath) {
    const localeFromCookie = cookies.get("locale")?.value;
    const locale = LOCALES.includes(
      localeFromCookie as (typeof LOCALES)[number],
    )
      ? localeFromCookie
      : DEFAULT_LOCALE;

    const redirectUrl = new URL(`/${locale}${pathname}${search}`, request.url);
    return NextResponse.redirect(redirectUrl);
  }

  // 3) Normalize route without locale
  const pathnameWithoutLocale = removeLocaleFromPath(pathname, localeFromPath);

  // 4) Save locale back to cookie so it persists
  const response = NextResponse.next();
  response.cookies.set("locale", localeFromPath, {
    path: "/",
    sameSite: "lax",
  });

  const isPublic = isPublicRoute(pathnameWithoutLocale);

  // 5) If not logged in and trying to access protected page -> redirect to login
  if (!isLoggedIn && !isPublic) {
    const loginUrl = new URL(`/${localeFromPath}/login`, request.url);

    // optional: keep where user wanted to go
    if (pathnameWithoutLocale !== "/") {
      loginUrl.searchParams.set("redirect", pathnameWithoutLocale + search);
    }

    return NextResponse.redirect(loginUrl);
  }

  // 6) If logged in and visiting login page -> redirect to dashboard
  if (isLoggedIn && pathnameWithoutLocale === "/login") {
    const dashboardUrl = new URL(`/${localeFromPath}/dashboard`, request.url);
    return NextResponse.redirect(dashboardUrl);
  }

  // 7) Optional: if user visits /en or /zh, route them based on auth
  if (pathname === `/${localeFromPath}`) {
    const target = isLoggedIn ? "/dashboard" : "/login";
    const targetUrl = new URL(`/${localeFromPath}${target}`, request.url);
    return NextResponse.redirect(targetUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
