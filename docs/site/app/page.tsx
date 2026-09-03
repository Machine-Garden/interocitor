import type { Metadata } from "next";
import { headers } from "next/headers";
import { HomeLanding } from "@/components/home-landing";

const title = "Interocitor — local-first app data without trusting the cloud";
const description =
  "Interocitor gives applications local-first rows and encrypted durable files that can move through storage you choose without giving the storage provider plaintext access.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;

  return {
    title,
    description,
    openGraph: {
      title,
      description:
        "Keep application data useful offline, convergent across trusted devices, and unreadable to the remote mailbox.",
      type: "website",
      siteName: "Interocitor",
      images: [
        { url: image, width: 1731, height: 909, alt: "Interocitor protected mailbox model" },
      ],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function HomePage() {
  return <HomeLanding />;
}
