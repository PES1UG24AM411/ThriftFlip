// A tiny "something changed on the server" announcement.
// lib/client.ts calls emitMutation() after every request that can change data (POST / PUT / DELETE ...),
// and lib/realtime.ts listens, so every live page refreshes at once instead of waiting for the next poll.
// No React and no imports here: this keeps lib/client.ts and lib/realtime.ts from importing each other.
type Listener = () => void;

const listeners = new Set<Listener>();

export function onMutation(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitMutation(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // a broken listener must never break the action that triggered it
    }
  });
}
