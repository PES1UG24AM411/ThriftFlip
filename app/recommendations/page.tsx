"use client";
import Link from "next/link";
import { useFetch } from "@/lib/client";
import { Async, Badge, Empty, ListingCard, PageTitle } from "@/components/ui";

export default function Recommendations() {
  const { data, error, loading } = useFetch("/api/recommendations");
  return (
    <div>
      <PageTitle subtitle="Books chosen for you: first your course, department and semester, then your favorites and recent searches, then your campus, then the newest textbooks.">Recommended for you</PageTitle>
      <Async loading={loading} error={error}>
        {!data?.length ? (
          <Empty icon="spark" action={<Link href="/marketplace" className="btn btn-sm">Browse the marketplace</Link>}>No other available books are listed right now. Check back soon, or browse the marketplace.</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((r: any) => (
              <div key={r.listing_id}>
                <div className="mb-1"><Badge tone="blue" tip="Why this book was suggested.">{r.reason}</Badge></div>
                <ListingCard l={r} />
              </div>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
