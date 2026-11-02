"use client";
import { apiFetch } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import Link from "next/link";
import { Async, Empty, ListingCard, PageTitle, Tip } from "@/components/ui";
import { useToast } from "@/components/feedback";

export default function Wishlist() {
  const toast = useToast();
  const { data, error, loading, reload } = useLiveData("/api/wishlist"); // availability of saved books updates by itself
  return (
    <div>
      <PageTitle subtitle="Listings you saved. Come back here to compare them or buy later.">My wishlist</PageTitle>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="heart" action={<Link href="/marketplace" className="btn">Browse the marketplace</Link>}>Your wishlist is empty. Open a listing and choose &ldquo;Add to favorites&rdquo; to save it here.</Empty> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((l: any) => (
              <div key={l.listing_id}>
                <ListingCard l={l} />
                <Tip text="Remove from your favorites. The listing itself is not affected." className="mt-2 w-full"><button className="btn-secondary w-full" onClick={async () => { await apiFetch(`/api/wishlist?listingId=${l.listing_id}`, { method: "DELETE" }); toast.success("Removed from favorites"); reload(); }}>Remove</button></Tip>
              </div>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
