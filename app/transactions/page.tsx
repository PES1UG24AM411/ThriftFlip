"use client";
import Link from "next/link";
import { dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Async, Badge, Empty, Hint, PageTitle } from "@/components/ui";
import { STATE_TIPS } from "@/lib/ui-text";

export default function Transactions() {
  const { data, error, loading } = useLiveData("/api/transactions"); // finished swaps, purchases and state changes appear by themselves
  return (
    <div>
      <PageTitle subtitle="Every purchase, sale and swap you are part of. Open a deal to see its steps and what to do next.">My deals</PageTitle>
      <Hint id="deals-how" title="Reading this page" icon="list">The <b>State</b> column shows how far each deal has come. Hover a state for its meaning, then open the deal to take the next step.</Hint>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="list">No deals yet. When you buy, sell or swap something, it shows up here.</Empty> : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full">
              <thead><tr><th className="th">Item</th><th className="th">Type</th><th className="th">Amount</th><th className="th">You are</th><th className="th">With</th><th className="th">State</th><th className="th">Updated</th></tr></thead>
              <tbody>
                {data.map((t: any) => (
                  <tr key={t.transaction_id}>
                    <td className="td"><Link className="link" href={`/transactions/${t.transaction_id}`}>{t.swapped_for_title ? `${t.swapped_for_title} ⇄ ${t.title}` : t.title}</Link></td>
                    <td className="td">{t.transaction_type.replace("_", " ")}</td>
                    <td className="td">{t.transaction_type === "SWAP" ? (Number(t.amount) > 0 ? `swap + ${money(t.amount)}` : "swap") : money(t.amount)}</td>
                    <td className="td">{t.my_role}</td>
                    <td className="td">{t.my_role === "BUYER" ? t.seller_name : t.buyer_name}</td>
                    <td className="td"><Badge tone={t.state === "RELEASED" ? "green" : t.state === "CANCELLED" ? "red" : "yellow"} tip={STATE_TIPS[t.state]}>{t.state}</Badge></td>
                    <td className="td">{dt(t.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </div>
  );
}
