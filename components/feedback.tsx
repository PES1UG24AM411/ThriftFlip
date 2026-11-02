"use client";
// Confirmation dialogs and toast messages, available to every page through two hooks:
//   const confirm = useConfirm();   if (await confirm({ title: "Delete?", tone: "danger" })) { ... }
//   const toast = useToast();       toast.success("Saved");  toast.error("Something failed");
import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

export type ConfirmOptions = { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: "default" | "danger" };
type Toast = { id: number; kind: "success" | "error" | "info"; text: string };

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async (o) => window.confirm(o.title)); // fallback without provider
const ToastContext = createContext<{ success: (t: string) => void; error: (t: string) => void; info: (t: string) => void }>({ success() {}, error() {}, info() {} });

export const useConfirm = () => useContext(ConfirmContext);
export const useToast = () => useContext(ToastContext);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...o, resolve })), []);
  const close = (v: boolean) => { dialog?.resolve(v); setDialog(null); };

  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 4000);
  }, []);
  const toast = useRef({ success: (t: string) => push("success", t), error: (t: string) => push("error", t), info: (t: string) => push("info", t) }).current;

  // Esc cancels, Tab stays inside the dialog, the safe button (Cancel) has the focus first
  useEffect(() => {
    if (!dialog) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { dialog.resolve(false); setDialog(null); }
      if (e.key === "Tab") {
        const first = cancelRef.current, last = okRef.current;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [dialog]);

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={toast}>
        {children}

        {dialog && (
          <div className="fixed inset-0 z-[100] flex items-end justify-center bg-brown/50 p-4 backdrop-blur-sm sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
            <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md animate-pop-in rounded-2xl border border-[#d4c599] bg-[#f9f4dd] p-6 shadow-lift">
              <div className="flex gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${dialog.tone === "danger" ? "bg-[#f1cdbd] text-[#8a2616]" : "bg-brown/10 text-brown"}`}>
                  <Icon name={dialog.tone === "danger" ? "alert" : "info"} />
                </span>
                <div className="min-w-0">
                  <h2 id="confirm-title" className="text-lg font-bold leading-snug">{dialog.title}</h2>
                  {dialog.message && <div className="mt-1 text-sm text-gray-600">{dialog.message}</div>}
                </div>
              </div>
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button ref={cancelRef} type="button" className="btn-secondary" onClick={() => close(false)}>{dialog.cancelLabel ?? "Cancel"}</button>
                <button ref={okRef} type="button" className={dialog.tone === "danger" ? "btn-danger" : "btn"} onClick={() => close(true)}>{dialog.confirmLabel ?? "Confirm"}</button>
              </div>
            </div>
          </div>
        )}

        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[110] flex flex-col items-center gap-2 px-4 sm:items-end sm:px-6" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className={`pointer-events-auto flex w-full max-w-sm animate-fade-up items-start gap-2.5 rounded-xl px-4 py-3 text-sm shadow-lift ${t.kind === "error" ? "bg-[#8f2d1f] text-white" : "bg-brown text-cream"}`}>
              <Icon name={t.kind === "error" ? "alert" : t.kind === "success" ? "check" : "info"} className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1">{t.text}</span>
              <button type="button" aria-label="Dismiss" className="opacity-70 transition hover:opacity-100" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><Icon name="x" className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}
