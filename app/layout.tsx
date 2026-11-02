import "./globals.css";
import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import { FeedbackProvider } from "@/components/feedback";

export const metadata: Metadata = {
  title: "THRIFTFLIP",
  description: "A student-to-student campus marketplace for used textbooks, goods, bidding and direct swaps",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#4B2E21" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><meta name="color-scheme" content="light" /></head>
      <body className="flex min-h-screen flex-col">
        <FeedbackProvider>
          <Nav />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
          <footer className="mt-8 bg-brown text-cream/80">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs">
              <span className="font-serif text-sm font-bold text-cream">THRIFTFLIP</span>
              <span>Student-to-student campus marketplace. Meet on campus, check the item before you confirm.</span>
            </div>
          </footer>
        </FeedbackProvider>
      </body>
    </html>
  );
}
