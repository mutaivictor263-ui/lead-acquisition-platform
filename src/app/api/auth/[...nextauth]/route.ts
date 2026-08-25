/**
 * Auth.js route handler. Delegates GET/POST for /api/auth/* to the NextAuth
 * instance configured in src/auth.ts. Runs on the Node runtime (default), which
 * the Prisma adapter requires.
 */
import { handlers } from "@/auth";

export const { GET, POST } = handlers;