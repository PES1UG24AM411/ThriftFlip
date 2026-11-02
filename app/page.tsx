import Link from "next/link";
import { Icon, IconName } from "@/components/icons";
import { Tip } from "@/components/ui";

const features: { icon: IconName; title: string; text: string; tip: string }[] = [
  { icon: "store", title: "Buy and sell", text: "Used textbooks and campus goods from students on your campus.", tip: "List a book in a minute, or search the marketplace and buy at a fixed price." },
  { icon: "gavel", title: "Auctions with anti-sniping", text: "Bid safely: the database locks bids and extends the deadline for last-minute bids.", tip: "If someone bids in the last minute, the timer is extended so nobody loses to a last-second bid." },
  { icon: "swap", title: "Direct and multi-way swaps", text: "The system finds swap cycles, e.g. A wants B's book, B wants C's, C wants A's.", tip: "Tell us which book you give and which you want. THRIFTFLIP looks for students who can trade in a circle." },
  { icon: "search", title: "Semantic search", text: "Search by meaning, e.g. \"third year machine learning textbook\" (pgvector).", tip: "Describe the book in your own words. You do not need the exact title." },
  { icon: "chart", title: "Fair price and demand", text: "Price estimates and demand levels are computed from real marketplace history.", tip: "See what similar books really sold for before you set or accept a price." },
  { icon: "shield", title: "Trust and safety", text: "Ratings and reviews, reports reviewed by admins, and automatic detection of suspicious bidding.", tip: "Check a seller's ratings, report problems, and rate every finished deal." },
];
const steps = [
  ["1", "Sign up", "Register with your e-mail address and start using the marketplace right away.", "Use your Student ID (SRN) and a THRIFTFLIP password. Never reuse your PESU Academy password."],
  ["2", "List or browse", "Post a book in a minute, or search the campus marketplace.", "Photos help books sell faster. You can add up to 5."],
  ["3", "Deal safely", "Buy, bid or swap, then confirm the hand-off on campus.", "Each deal moves through clear steps so both sides know what happens next."],
];

export default function Landing() {
  return (
    <div>
      <section className="relative overflow-hidden rounded-3xl bg-brown px-6 py-14 text-center text-cream shadow-lift sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-cream/10" />
        <div className="pointer-events-none absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-cream/10" />
        <span className="relative inline-block rounded-full border border-cream/40 px-3 py-1 text-xs font-semibold tracking-wide">Campus marketplace for students</span>
        <h1 className="relative mx-auto mt-5 max-w-3xl text-4xl font-bold leading-tight sm:text-6xl">Give your old books a second life</h1>
        <p className="relative mx-auto mt-5 max-w-2xl text-base text-cream/85 sm:text-lg">
          THRIFTFLIP is a student-to-student marketplace for used textbooks, goods, bidding and direct swaps. Save money, free up shelf space.
        </p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-3">
          <Tip text="Free account in under a minute. You need your Student ID (SRN) and an e-mail address."><Link href="/register" className="inline-flex items-center rounded-lg bg-cream px-6 py-3 font-semibold text-brown transition hover:-translate-y-px hover:bg-white hover:shadow-lg">Create account</Link></Tip>
          <Tip text="Already registered? Log in to continue."><Link href="/login" className="inline-flex items-center rounded-lg border border-cream/50 px-6 py-3 font-semibold transition hover:bg-cream/15">Log in</Link></Tip>
        </div>
      </section>

      <h2 className="mb-5 mt-14 text-center text-3xl font-bold">Everything a campus marketplace needs</h2>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <Tip key={f.title} text={f.tip} className="w-full">
            <div className="card w-full hover:-translate-y-0.5 hover:shadow-lift">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brown text-cream"><Icon name={f.icon} /></div>
              <h3 className="font-sans text-base font-bold">{f.title}</h3>
              <p className="mt-1 text-sm text-gray-600">{f.text}</p>
            </div>
          </Tip>
        ))}
      </section>

      <h2 className="mb-5 mt-14 text-center text-3xl font-bold">How it works</h2>
      <section className="grid gap-4 md:grid-cols-3">
        {steps.map(([n, title, text, tip]) => (
          <Tip key={n} text={tip} className="w-full">
            <div className="card w-full text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border-2 border-brown font-serif text-lg font-bold">{n}</div>
              <h3 className="font-sans text-base font-bold">{title}</h3>
              <p className="mt-1 text-sm text-gray-600">{text}</p>
            </div>
          </Tip>
        ))}
      </section>

      <section className="mt-14 rounded-3xl border border-brown/20 bg-[#f9f4dd] p-8 text-center">
        <h2 className="text-2xl font-bold">Ready to clear your bookshelf?</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-gray-600">Join your campus community. Registration is free.</p>
        <Link href="/register" className="btn mt-5 !px-6 !py-3">Get started</Link>
      </section>
    </div>
  );
}
