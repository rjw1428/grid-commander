type Listener = (...args: any[]) => void;

/** Tiny typed event emitter. Listener errors are isolated and reported via onError. */
export class Emitter<E extends { [K in keyof E]: Listener }> {
  #listeners = new Map<keyof E, Set<Listener>>();
  constructor(private readonly onError: (err: unknown, event: string) => void = () => {}) {}

  on<K extends keyof E>(event: K, listener: E[K]): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        this.onError(err, String(event));
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
