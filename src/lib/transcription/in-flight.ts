/**
 * Same-process promise coalescing for expensive idempotent work. This is an
 * efficiency guard only; durable correctness still belongs to the database.
 */
export class InFlightByKey<T> {
    private readonly promises = new Map<string, Promise<T>>();

    run(key: string, task: () => Promise<T>): Promise<T> {
        const existing = this.promises.get(key);
        if (existing) return existing;

        const promise = Promise.resolve().then(task);
        this.promises.set(key, promise);

        const clear = () => {
            if (this.promises.get(key) === promise) {
                this.promises.delete(key);
            }
        };
        void promise.then(clear, clear);

        return promise;
    }
}
