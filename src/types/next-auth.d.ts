/**
 * Module augmentation: expose the stable user id on the session so
 * `session.user.id` type-checks under strict mode. The value is populated by the
 * `session` callback in src/auth.ts.
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}