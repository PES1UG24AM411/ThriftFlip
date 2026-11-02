"use client";
import { useRouter } from "next/navigation";
import { apiFetch, dt } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Async, Badge, Empty, PageTitle, Tip } from "@/components/ui";
import { useToast } from "@/components/feedback";

// Where the "Open" button of a notification goes. A message opens ITS conversation (?c=<id>) in the Messages page.
function target(n: any): { href: string; label: string } | null {
  if (n.type === "MESSAGE" && n.related_conversation_id) return { href: `/messages?c=${n.related_conversation_id}`, label: "Open chat" };
  if (n.type === "MESSAGE") return { href: "/messages", label: "Open messages" };
  if (n.type === "ADMIN_MESSAGE") return { href: "/notices", label: "Read and reply" };
  if (["SWAP_MATCH", "SWAP_PROPOSAL", "SWAP_UPDATE"].includes(n.type)) return { href: "/swaps", label: "Open swaps" };
  if (["AUCTION_WON", "AUCTION_SOLD", "TRANSACTION_UPDATE", "PURCHASE", "OFFER_ACCEPTED"].includes(n.type)) return { href: "/transactions", label: "Open deals" };
  if (n.related_listing_id) return { href: `/listings/${n.related_listing_id}`, label: "Open listing" };
  return null;
}

export default function Notifications() {
  const toast = useToast();
  const router = useRouter();
  const { data, error, loading, reload } = useLiveData("/api/notifications"); // new notifications appear by themselves

  // price alert: open (or continue) a chat with the seller of the listing the alert is about
  async function messageSeller(n: any) {
    try {
      const r = await apiFetch("/api/conversations", { method: "POST", body: { listingId: n.related_listing_id } });
      if (!n.is_read) await apiFetch("/api/notifications", { method: "POST", body: { id: n.notification_id } }).catch(() => {});
      router.push(`/messages?c=${r.id}`);
    } catch (e: any) { toast.error(e.message ?? "Could not open the chat"); }
  }

  // opening a notification also marks it as read
  async function open(n: any, href: string) {
    if (!n.is_read) await apiFetch("/api/notifications", { method: "POST", body: { id: n.notification_id } }).catch(() => {});
    router.push(href);
  }

  return (
    <div>
      <PageTitle subtitle="Updates about your bids, offers, swaps, wanted books and deals." action={<Tip text="Marks every notification as read. Nothing is deleted." side="bottom" align="end"><button className="btn-secondary" onClick={async () => { await apiFetch("/api/notifications", { method: "POST", body: {} }); toast.success("All notifications marked as read"); reload(); }}>Mark all as read</button></Tip>}>Notifications</PageTitle>
      <Async loading={loading} error={error}>
        {!data?.items.length ? <Empty icon="bell">You are all caught up. New updates will appear here.</Empty> : data.items.map((n: any) => {
          const go = target(n);
          return (
            <div key={n.notification_id} className={`card mb-3 flex flex-wrap items-start justify-between gap-3 !p-4 ${n.is_read ? "opacity-70" : "border-l-4 border-l-brown"}`}>
              <div>
                <p className="text-sm font-medium"><Badge tone="blue">{n.type.replaceAll("_", " ")}</Badge> {n.title}</p>
                <p className="mt-1 text-sm text-gray-700">{n.body}</p>
                <p className="text-xs text-gray-500">{dt(n.created_at)}</p>
              </div>
              <div className="flex gap-2">
                {n.type === "PRICE_ALERT" && n.related_listing_id && <button className="btn btn-sm" onClick={() => messageSeller(n)}>Message seller</button>}
                {go && <button className="btn-secondary btn-sm" onClick={() => open(n, go.href)}>{go.label}</button>}
                {!n.is_read && <Tip text="Mark this notification as read."><button className="btn-secondary btn-sm" onClick={async () => { await apiFetch("/api/notifications", { method: "POST", body: { id: n.notification_id } }); reload(); }}>Mark read</button></Tip>}
              </div>
            </div>
          );
        })}
      </Async>
    </div>
  );
}
