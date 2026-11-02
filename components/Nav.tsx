"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import { resetLive, useLiveData } from "@/lib/realtime";
import { Icon, IconName } from "./icons";
import { Tip } from "./ui";
import { useToast } from "./feedback";

type NavLink = { href: string; label: string; icon: IconName; tip: string };

const STUDENT_MAIN: NavLink[] = [
  { href: "/dashboard", label: "Dashboard", icon: "home", tip: "Your overview: listings, deals, notifications and recommendations." },
  { href: "/marketplace", label: "Marketplace", icon: "store", tip: "Browse and search the books and goods students are selling." },
  { href: "/auctions", label: "Auctions", icon: "gavel", tip: "Bid on items. The highest bid when the timer ends wins." },
  { href: "/swaps", label: "Swaps", icon: "swap", tip: "Trade a book you have for one you want, and list the books you want." },
  { href: "/transactions", label: "Deals", icon: "list", tip: "Your purchases and sales: see each step and what to do next." },
  { href: "/messages", label: "Messages", icon: "chat", tip: "Chat with buyers and sellers about a listing." },
];
const STUDENT_MORE: NavLink[] = [
  { href: "/wishlist", label: "Favorites", icon: "heart", tip: "Listings you saved to look at again." },
  { href: "/recently-viewed", label: "Recent", icon: "clock", tip: "Listings you opened recently." },
  { href: "/recommendations", label: "For you", icon: "spark", tip: "Suggestions based on your favorites, course and searches." },
  { href: "/price-intelligence", label: "Prices", icon: "tag", tip: "Check a fair price, see demand and set price alerts." },
  { href: "/notices", label: "Admin messages", icon: "chat", tip: "Official messages and warnings from the administrators. You can reply." },
];
const ADMIN_LINKS: NavLink[] = [
  { href: "/admin", label: "Overview", icon: "home", tip: "Key numbers and suspicious bidding." },
  { href: "/admin/reports", label: "Reports", icon: "flag", tip: "Review reports from students and take action." },
  { href: "/admin/users", label: "Users", icon: "user", tip: "Find students, send messages, warn or suspend." },
  { href: "/admin/listings", label: "Listings & Reviews", icon: "store", tip: "Remove inappropriate listings and reviews." },
];
export default function Nav() {
  const path = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [user, setUser] = useState<any>(null);
  const [open, setOpen] = useState(false); // mobile menu
  const [moreOpen, setMoreOpen] = useState(false); // "More" dropdown
  const moreRef = useRef<HTMLDivElement>(null);
  // The bell count refreshes by itself every 2 seconds. The Notifications page uses the same URL, so they share one request.
  const notifications = useLiveData<{ unread: number }>(user?.role === "STUDENT" ? "/api/notifications" : null);
  const unread = notifications.data?.unread ?? 0;

  useEffect(() => {
    apiFetch("/api/auth/me").then((r) => setUser(r.user)).catch(() => setUser(null));
  }, [path]);

  useEffect(() => { setOpen(false); setMoreOpen(false); }, [path]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMoreOpen(false); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, []);

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST", body: {} });
    resetLive(); // stop polling and forget loaded data: nothing of this account may be shown to the next one
    setUser(null);
    toast.info("You have been logged out.");
    router.push("/login");
  }

  const isAdmin = user?.role === "ADMIN";
  const main = isAdmin ? ADMIN_LINKS : user ? STUDENT_MAIN : [];
  const more = user && !isAdmin ? STUDENT_MORE : [];
  const active = (href: string) => path === href || (href !== "/dashboard" && href !== "/admin" && path.startsWith(href + "/"));
  const moreActive = more.some((l) => active(l.href));

  const linkCls = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${on ? "bg-cream text-brown" : "text-cream/90 hover:bg-cream/15 hover:text-cream"}`;

  return (
    <header className="sticky top-0 z-40 bg-brown text-cream shadow-md">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
        <Tip text="THRIFTFLIP home" side="bottom" align="start">
          <Link href={user ? (isAdmin ? "/admin" : "/dashboard") : "/"} className="mr-2 flex items-center gap-2 font-serif text-xl font-bold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-cream text-base text-brown">T</span>
            <span className="hidden sm:inline">THRIFTFLIP</span>
          </Link>
        </Tip>

        {/* desktop links */}
        <nav className="hidden flex-1 items-center gap-1 lg:flex" aria-label="Main">
          {main.map((l) => (
            <Tip key={l.href} text={l.tip} side="bottom" align="start">
              <Link href={l.href} className={linkCls(active(l.href))} aria-current={active(l.href) ? "page" : undefined}><Icon name={l.icon} className="h-4 w-4" />{l.label}</Link>
            </Tip>
          ))}
          {more.length > 0 && (
            <div ref={moreRef} className="relative">
              <button type="button" className={linkCls(moreActive || moreOpen)} aria-expanded={moreOpen} aria-haspopup="menu" onClick={() => setMoreOpen((v) => !v)}>
                More <Icon name="chevron" className={`h-4 w-4 transition ${moreOpen ? "rotate-180" : ""}`} />
              </button>
              {moreOpen && (
                <div role="menu" className="absolute left-0 top-full z-50 mt-2 w-64 animate-pop-in rounded-xl border border-[#d4c599] bg-[#f9f4dd] p-1.5 text-brown shadow-lift">
                  {more.map((l) => (
                    <Link key={l.href} href={l.href} role="menuitem" className={`flex items-start gap-3 rounded-lg px-3 py-2 transition hover:bg-brown/10 ${active(l.href) ? "bg-brown/10" : ""}`}>
                      <Icon name={l.icon} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span><span className="block text-sm font-semibold">{l.label}</span><span className="block text-xs text-gray-600">{l.tip}</span></span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </nav>
        <div className="flex-1 lg:hidden" />

        {/* account area */}
        <div className="flex items-center gap-1.5">
          {user?.role === "STUDENT" && (
            <>
              <Tip text={unread > 0 ? `${unread} unread notification${unread > 1 ? "s" : ""}` : "Notifications: bids, offers, swaps and deal updates"} side="bottom" align="end">
                <Link href="/notifications" aria-label="Notifications" className="relative rounded-lg p-2 text-cream/90 transition hover:bg-cream/15 hover:text-cream">
                  <Icon name="bell" />
                  {unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cream px-1 text-[10px] font-bold text-brown">{unread}</span>}
                </Link>
              </Tip>
              <Tip text="Your profile, ratings and contact settings" side="bottom" align="end">
                <Link href="/profile" className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium text-cream/90 transition hover:bg-cream/15 hover:text-cream sm:inline-flex"><Icon name="user" className="h-4 w-4" />{user.name}</Link>
              </Tip>
            </>
          )}
          {isAdmin && <span className="hidden items-center gap-1.5 px-2 text-sm text-cream/80 sm:inline-flex"><Icon name="shield" className="h-4 w-4" />Admin: {user.name}</span>}
          {user ? (
            <Tip text="Sign out of THRIFTFLIP" side="bottom" align="end">
              <button onClick={logout} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-cream/40 px-3 py-1.5 text-sm font-medium transition hover:bg-cream hover:text-brown"><Icon name="logout" className="h-4 w-4" /><span className="hidden sm:inline">Log out</span></button>
            </Tip>
          ) : (
            <>
              <Link href="/login" className="rounded-lg border border-cream/40 px-3 py-1.5 text-sm font-medium transition hover:bg-cream hover:text-brown">Log in</Link>
              <Link href="/register" className="rounded-lg bg-cream px-3 py-1.5 text-sm font-semibold text-brown transition hover:bg-white">Register</Link>
            </>
          )}
          {user && (
            <button type="button" className="rounded-lg p-2 text-cream transition hover:bg-cream/15 lg:hidden" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <Icon name={open ? "x" : "menu"} />
            </button>
          )}
        </div>
      </div>

      {/* mobile / tablet menu */}
      {open && user && (
        <nav className="animate-fade-up border-t border-cream/20 px-4 pb-4 pt-2 lg:hidden" aria-label="Mobile">
          <div className="mx-auto grid max-w-6xl gap-1 sm:grid-cols-2">
            {[...main, ...more].map((l) => (
              <Link key={l.href} href={l.href} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${active(l.href) ? "bg-cream text-brown" : "hover:bg-cream/15"}`}>
                <Icon name={l.icon} className="h-5 w-5 shrink-0" />
                <span><span className="block">{l.label}</span><span className={`block text-xs font-normal ${active(l.href) ? "text-gray-600" : "text-cream/70"}`}>{l.tip}</span></span>
              </Link>
            ))}
            {user.role === "STUDENT" && (
              <Link href="/profile" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition hover:bg-cream/15"><Icon name="user" className="h-5 w-5" />My profile</Link>
            )}
          </div>
        </nav>
      )}

    </header>
  );
}
