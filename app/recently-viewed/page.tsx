"use client";
import { useLiveData } from "@/lib/realtime";
import Link from "next/link";
import { Async, Empty, ListingCard, PageTitle } from "@/components/ui";

export default function RecentlyViewed() {
  const { data, error, loading } = useLiveData("/api/recently-viewed"); // availability updates by itself
  return (
    <div>
      <PageTitle subtitle="Listings you opened lately, so you can find them again.">Recently viewed</PageTitle>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="clock" action={<Link href="/marketplace" className="btn">Browse the marketplace</Link>}>You have not looked at any listing yet.</Empty> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.map((l: any) => <ListingCard key={l.listing_id} l={l} />)}</div>
        )}
      </Async>
    </div>
  );
}
