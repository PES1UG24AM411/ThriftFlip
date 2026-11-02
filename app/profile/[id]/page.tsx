"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Async, Empty, PageTitle, SectionTitle } from "@/components/ui";

export default function PublicProfile() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading } = useLiveData(`/api/profile/${id}`); // active listings and new ratings update by themselves
  const rep = data?.ratingSummary;
  return (
    <Async loading={loading} error={error}>
      {data && (
        <div>
          <PageTitle subtitle={`${data.student.department} · ${data.student.campus} · semester ${data.student.semester} · member since ${dt(data.student.created_at)}`}>{data.student.name}</PageTitle>
          <div className="grid gap-5 md:grid-cols-3">
            <div className="card"><p className="text-xs font-semibold uppercase tracking-wide text-gray-600">Rating</p>
              {rep?.rating_count ? <p className="font-serif text-4xl font-bold"><span className="text-[#a26a00]">★</span> {Number(rep.avg_rating).toFixed(1)}<span className="text-base font-normal text-gray-600"> / 5</span></p> : <p className="font-serif text-2xl font-bold text-gray-500">Not rated yet</p>}
              <p className="hint">{rep?.rating_count} {rep?.rating_count === 1 ? "rating" : "ratings"} · {rep?.completed_transactions} completed deals ({rep?.completed_sales} sales/purchases, {rep?.completed_swaps} swaps)</p></div>
            <div className="card md:col-span-2">
              <h3 className="mb-2 font-sans text-base font-bold">Reviews ({data.ratings.length})</h3>
              {data.ratings.length === 0 ? <Empty icon="shield">Not rated yet.</Empty> : data.ratings.map((r: any, i: number) => (
                <div key={i} className="border-t border-brown/15 py-2 text-sm first:border-0"><b aria-label={`${r.score} out of 5 stars`}>{"★".repeat(r.score)}{"☆".repeat(5 - r.score)}</b> by {r.rater_name} <span className="text-xs text-gray-500">{dt(r.created_at)}</span>{r.review && <p>{r.review}</p>}</div>
              ))}
            </div>
          </div>
          <SectionTitle>Active listings</SectionTitle>
          {data.listings.length === 0 ? <Empty icon="store">No active listings.</Empty> : data.listings.map((l: any) => (
            <p key={l.listing_id} className="border-t border-brown/15 py-2 text-sm first:border-0"><Link className="link" href={`/listings/${l.listing_id}`}>{l.title}</Link> · {money(l.price)}</p>
          ))}
        </div>
      )}
    </Async>
  );
}
