import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>LeadForge AI</h1>
      <p>Lead acquisition platform</p>
      <p style={{ marginTop: 16 }}>
        <Link href="/dashboard">Go to dashboard</Link>
      </p>
    </main>
  );
}