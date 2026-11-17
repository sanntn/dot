import type { BoardEvent } from "@dot/shared";

type Listener = (event: BoardEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: BoardEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
