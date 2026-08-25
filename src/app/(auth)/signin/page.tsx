/**
 * Basic sign-in page. Plain markup (no UI framework is installed). Uses a Server
 * Action to start the Google OAuth flow, so no client SessionProvider is needed.
 */
import { signIn } from "@/auth";

export default function SignInPage() {
  async function signInWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 360, padding: 24 }}>
        <h1 style={{ marginBottom: 8 }}>LeadForge AI</h1>
        <p style={{ marginBottom: 24, color: "#555" }}>Sign in to continue</p>
        <form action={signInWithGoogle}>
          <button
            type="submit"
            style={{
              padding: "10px 16px",
              fontSize: 16,
              cursor: "pointer",
              border: "1px solid #ccc",
              borderRadius: 6,
              background: "#fff",
            }}
          >
            Continue with Google
          </button>
        </form>
      </div>
    </main>
  );
}
