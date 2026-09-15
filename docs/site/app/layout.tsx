import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
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
      <body>
        {/*
          Every page says where its own description for machine readers lives, so an
          agent that landed anywhere on the site finds the index without guessing a
          path. The file is Markdown, which is what the type states; it is served as
          `text/plain` so that opening it in a browser tab reads it rather than
          downloading it.
        */}
        <link rel="describedby" href="/llms.txt" type="text/markdown" />
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
