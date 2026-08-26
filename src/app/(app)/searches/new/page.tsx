import Link from "next/link";
import { SearchForm } from "./search-form";

export default function NewSearchPage() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 32,
        maxWidth: 640,
      }}
    >
      <p style={{ marginBottom: 16 }}>
        <Link href="/searches">← Searches</Link>
      </p>

      <h1 style={{ marginBottom: 24 }}>New search</h1>

      <SearchForm />
    </main>
  );
}
