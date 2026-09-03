import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interocitor — local-first app data without trusting the cloud",
  description:
    "Keep application data useful offline, convergent across trusted devices, and unreadable to the remote mailbox.",
  icons: { icon: "/assets/mark-dark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
