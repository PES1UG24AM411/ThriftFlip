"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, dt } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Empty, Hint, Loading, PageTitle, Tip } from "@/components/ui";
import { Icon } from "@/components/icons";

export default function Messages() {
  // Both the conversation list (unread counts, last message) and the open chat refresh by themselves every 2 seconds.
  // Reading the open chat also marks its messages as read on the server (GET /api/conversations/[id]).
  const list = useLiveData("/api/conversations");
  const [active, setActive] = useState<number | null>(null);
  const convo = useLiveData<any[]>(active === null ? null : `/api/conversations/${active}`);
  const messages: any[] = convo.data ?? [];
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [me, setMe] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true); // follow new messages only while the reader is at the bottom of the chat

  useEffect(() => {
    // ?c=<conversation id>: the notification (or the Message button) tells us which chat to open
    const c = Number(new URLSearchParams(window.location.search).get("c"));
    if (Number.isInteger(c) && c > 0) setActive(c);
    apiFetch("/api/auth/me").then((r) => setMe(r.user?.id ?? null)).catch(() => {});
  }, []);

  useEffect(() => { atBottom.current = true; }, [active]);
  const lastMessageId = messages.length ? messages[messages.length - 1].message_id : null;
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [active, messages.length, lastMessageId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (active === null) return;
    setError("");
    try {
      await apiFetch(`/api/conversations/${active}`, { method: "POST", body: { body } });
      setBody("");
      atBottom.current = true; // show my own message
      convo.reload();
      list.reload();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div>
      <PageTitle subtitle="Private chats with buyers and sellers about a listing.">Messages</PageTitle>
      <Hint id="messages-how" title="Starting a chat" icon="chat">Open any listing and choose <b>Message seller</b>. Conversations appear in the list on the left. New messages load automatically.</Hint>
      <div className="grid gap-5 md:grid-cols-3">
        <div className="card overflow-hidden !p-0">
          {list.loading ? <Loading /> : !list.data?.length ? <div className="p-4"><Empty icon="chat">No conversations yet. Use &ldquo;Message seller&rdquo; on a listing.</Empty></div> : list.data.map((c: any) => (
            <button key={c.conversation_id} onClick={() => setActive(c.conversation_id)} className={`block w-full border-b border-brown/15 px-4 py-3 text-left transition hover:bg-brown/10 ${active === c.conversation_id ? "bg-brown/10" : ""}`}>
              <p className="text-sm font-medium">{c.other_name} {c.unread > 0 && c.conversation_id !== active && <span className="rounded-full bg-brown px-2 text-xs text-cream">{c.unread}</span>}</p>
              <p className="text-xs text-gray-500">{c.title}</p>
              <p className="truncate text-xs text-gray-600">{c.last_message}</p>
            </button>
          ))}
        </div>
        <div className="card md:col-span-2">
          {active === null ? <Empty icon="chat">Select a conversation to read and reply.</Empty> : (
            <>
              <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className="mb-4 max-h-96 min-h-[12rem] space-y-2 overflow-y-auto pr-1">
                {messages.map((m) => (
                  <div key={m.message_id} className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[80%] ${m.sender_id === me ? "ml-auto rounded-br-sm bg-brown text-cream" : "rounded-bl-sm bg-gray-200"}`}>
                    <p className={`text-xs ${m.sender_id === me ? "text-cream/70" : "text-gray-500"}`}>{m.sender_name} · {dt(m.sent_at)}</p>
                    {m.body}
                  </div>
                ))}
              </div>
              {(error || convo.error) && <Alert>{error || convo.error}</Alert>}
              <form onSubmit={send} className="flex gap-2"><input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message..." required /><Tip text="Send your message"><button className="btn"><Icon name="chat" className="h-4 w-4" />Send</button></Tip></form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
