import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LeadForge AI",
  description: "Lead acquisition platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}