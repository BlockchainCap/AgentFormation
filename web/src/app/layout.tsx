import type { Metadata, Viewport } from "next";
import { BrowserSession } from "@/components/browser-session";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentFormation",
  description: "Persistent remote coding agents inside your AWS account",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AgentFormation",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased">
        <BrowserSession>{children}</BrowserSession>
      </body>
    </html>
  );
}
