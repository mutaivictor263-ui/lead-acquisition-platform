"use client";

/**
 * Search creation form. Client component so validation errors render inline and
 * field values survive a failed submit (via useActionState). It imports only the
 * server action reference and a shared constant — no server-only modules.
 */

import { useActionState } from "react";

import { createSearchAction, type CreateSearchState } from "../actions";
import { LEAD_COUNT_OPTIONS } from "@/lib/validation/search";

const initialState: CreateSearchState = {};

const field: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  marginTop: 4,
  marginBottom: 12,
  border: "1px solid #ccc",
  borderRadius: 6,
  fontSize: 14,
  boxSizing: "border-box",
};

export function SearchForm() {
  const [state, formAction, isPending] = useActionState(createSearchAction, initialState);

  return (
    <form action={formAction} style={{ maxWidth: 520 }}>
      {state.error ? (
        <p
          role="alert"
          style={{
            background: "#fdecea",
            border: "1px solid #f5c6cb",
            color: "#8a1f2b",
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {state.error}
        </p>
      ) : null}

      <label>
        Category *
        <input name="category" required placeholder="e.g. dentists" style={field} />
      </label>

      <label>
        Search name (optional)
        <input name="name" placeholder="Defaults to category + location" style={field} />
      </label>

      <div style={{ display: "flex", gap: 12 }}>
        <label style={{ flex: 1 }}>
          City
          <input name="city" style={field} />
        </label>
        <label style={{ flex: 1 }}>
          Region / State
          <input name="region" style={field} />
        </label>
      </div>

      <div style={{ display: "flex", gap: 12 }}>
        <label style={{ flex: 1 }}>
          Country
          <input name="country" style={field} />
        </label>
        <label style={{ flex: 1 }}>
          Postal code
          <input name="postalCode" style={field} />
        </label>
      </div>

      <label>
        Number of leads
        <select name="leadsRequested" defaultValue={LEAD_COUNT_OPTIONS[0]} style={field}>
          {LEAD_COUNT_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={{ border: "1px solid #eee", borderRadius: 6, padding: 12, marginBottom: 12 }}>
        <legend style={{ fontSize: 13, color: "#555" }}>Only keep leads that have…</legend>
        {[
          ["hasWebsite", "Website"],
          ["hasEmail", "Email"],
          ["hasPhone", "Phone"],
          ["hasLinkedin", "LinkedIn"],
          ["hasInstagram", "Instagram"],
          ["hasFacebook", "Facebook"],
        ].map(([name, label]) => (
          <label key={name} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
            <input type="checkbox" name={name} /> {label}
          </label>
        ))}
      </fieldset>

      <label>
        Minimum score (0–100, optional)
        <input name="minScore" type="number" min={0} max={100} style={field} />
      </label>

      <button
        type="submit"
        disabled={isPending}
        style={{
          padding: "10px 16px",
          fontSize: 15,
          cursor: isPending ? "default" : "pointer",
          border: "1px solid #ccc",
          borderRadius: 6,
          background: isPending ? "#eee" : "#fff",
        }}
      >
        {isPending ? "Creating…" : "Create search"}
      </button>
    </form>
  );
}
