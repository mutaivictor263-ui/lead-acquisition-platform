"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 1100 }}>
      <h1>Couldn&apos;t load leads</h1>
      <p style={{ color: "#8a1f2b" }}>{error.message || "Something went wrong."}</p>
      <button
        onClick={reset}
        style={{ padding: "8px 14px", border: "1px solid #ccc", borderRadius: 6, background: "#fff", cursor: "pointer" }}
      >
        Try again
      </button>
    </main>
  );
}
