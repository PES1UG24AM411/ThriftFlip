"use client";
// Browser helpers: fetch wrapper, a tiny data hook and formatters.
import { useCallback, useEffect, useState } from "react";
import { emitMutation } from "./liveBus";

// After any request that can change data, live pages are told to refresh at once (see lib/realtime.ts).
// This also runs when the server refused the change (for example "already answered"): the screen was out of date.
// Log in / log out are left out: they do not change what other people see.
const announceChange = (url: string, method: string) => {
  if (method !== "GET" && !url.startsWith("/api/auth/")) emitMutation();
};

export async function apiFetch<T = any>(url: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const res = await fetch(url, {
    method,
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
    signal: opts.signal,
  });
  announceChange(url, method);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // keep the extra details of the response (used by the register form for field-level errors)
    throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status, code: data.code, fields: data.fields });
  }
  return data as T;
}

export async function uploadFiles<T = any>(url: string, files: File[], field = "files"): Promise<T> {
  const form = new FormData();
  files.forEach((f) => form.append(field, f));
  const res = await fetch(url, { method: "POST", body: form });
  announceChange(url, "POST");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
  return data as T;
}

// Loads once. For data that other people can change while this page is open, use useLiveData (lib/realtime.ts):
// it has the same return value and keeps the data up to date by itself.
export function useFetch<T = any>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);

  const reload = useCallback(async () => {
    if (!url) return;
    try {
      setError(null);
      setData(await apiFetch<T>(url));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(!!url);
    reload();
  }, [url, reload]);

  return { data, error, loading, reload };
}

export const money = (v: unknown) => (v === null || v === undefined ? "-" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
export const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : "-");
