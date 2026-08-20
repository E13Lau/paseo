export interface ForwardPortShortcut {
  serverId: string;
  target: string;
  label: string;
}

const listeners = new Set<(input: ForwardPortShortcut) => void>();
let pending: ForwardPortShortcut | null = null;

export function openForwardPortShortcut(input: ForwardPortShortcut): void {
  pending = input;
  for (const listener of listeners) listener(input);
}

export function consumeForwardPortShortcut(
  listener: (input: ForwardPortShortcut) => void,
): () => void {
  listeners.add(listener);
  if (pending && pending.serverId) {
    listener(pending);
    pending = null;
  }
  return () => {
    listeners.delete(listener);
  };
}
