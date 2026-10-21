import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
// Authentication is enforced in the server layout and every API operation.
export default createMiddleware(routing);
export const config = { matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"] };
