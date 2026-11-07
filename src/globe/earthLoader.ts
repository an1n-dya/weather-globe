import { dataUrl } from "../data";
import type { DetailTier } from "./earthData";
import type { EarthArrays } from "./earthMesh";
import type { EarthCommand, EarthReply } from "./earthWorker";

export interface EarthSubscriber {
  /** Called with each globe as it's built, light first; the last call is the final tier. */
  onTier(tier: DetailTier, arrays: EarthArrays): void;
  onError(error: unknown): void;
}

/**
 * Downloads the globe's points and has a worker build the globe while they
 * stream in. It starts as the app boots, before three.js has arrived, so the
 * download, the light globe and the three.js download all overlap. The light
 * globe is ready once the first fifth of the file is in; the final tier
 * follows once the scene says which one this device should get.
 */
class EarthLoader {
  private worker: Worker | null = null;
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private downloaded = false;
  private downloadError: unknown = null;
  /** The best globe built so far, kept for a scene that subscribes later. */
  private latest: { tier: DetailTier; arrays: EarthArrays } | null = null;
  private done = false;
  private workerFailed = false;
  private final: DetailTier | null = null;
  private subscriber: EarthSubscriber | null = null;
  private fallback: Promise<void> | null = null;

  constructor() {
    try {
      this.worker = new Worker(new URL("./earthWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }: MessageEvent<EarthReply>) => this.handleReply(data);
      this.worker.onerror = (event) => {
        event.preventDefault();
        this.handleWorkerFailure(new Error(event.message || "The globe worker failed"));
      };
    } catch (error) {
      this.handleWorkerFailure(error);
    }
    void this.download();
  }

  /** One scene at a time; a new one replaces the last and gets the best globe so far. */
  subscribe(final: DetailTier, subscriber: EarthSubscriber): void {
    this.subscriber = subscriber;
    if (this.final === null) {
      this.final = final;
      this.send({ final });
    }
    const latest = this.latest;
    if (latest) queueMicrotask(() => this.deliver(latest.tier, latest.arrays));
    if (this.downloadError) queueMicrotask(() => subscriber.onError(this.downloadError));
    else if (this.workerFailed) this.buildHere();
  }

  unsubscribe(subscriber: EarthSubscriber): void {
    if (this.subscriber === subscriber) this.subscriber = null;
  }

  private async download(): Promise<void> {
    try {
      const response = await fetch(dataUrl("earth.bin"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.forward(value as Uint8Array<ArrayBuffer>);
        }
      } else {
        this.forward(new Uint8Array(await response.arrayBuffer()));
      }
      this.downloaded = true;
      this.send({ end: true });
      if (this.workerFailed) this.buildHere();
    } catch (error) {
      this.downloadError = error;
      this.worker?.terminate();
      this.worker = null;
      this.subscriber?.onError(error);
    }
  }

  private forward(chunk: Uint8Array<ArrayBuffer>): void {
    // A copy stays here, in case the worker fails and the globe has to be built on this thread.
    this.chunks.push(chunk);
    this.send({ chunk });
  }

  private send(command: EarthCommand): void {
    this.worker?.postMessage(command);
  }

  private handleReply(reply: EarthReply): void {
    if ("error" in reply) {
      this.handleWorkerFailure(new Error(reply.error));
      return;
    }
    if ("done" in reply) {
      this.done = true;
      this.worker?.terminate();
      this.worker = null;
      return;
    }
    this.latest = { tier: reply.tier, arrays: reply.arrays };
    this.deliver(reply.tier, reply.arrays);
  }

  private deliver(tier: DetailTier, arrays: EarthArrays): void {
    // A replay must not hand over a globe that a newer one has already replaced.
    if (this.latest?.arrays !== arrays) return;
    this.subscriber?.onTier(tier, arrays);
  }

  private handleWorkerFailure(error: unknown): void {
    if (this.workerFailed || this.done) return;
    console.warn("Building the globe in a worker failed; building it here instead", error);
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    this.buildHere();
  }

  /** Without a worker, the final tier is built here once the whole file is in. */
  private buildHere(): void {
    if (this.fallback || !this.downloaded || this.final === null || this.done) return;
    const final = this.final;
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const file = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      file.set(chunk, offset);
      offset += chunk.length;
    }
    this.fallback = import("./earthFallback")
      .then(({ buildOnMainThread }) => buildOnMainThread(file, final))
      .then((arrays) => {
        this.done = true;
        this.latest = { tier: final, arrays };
        this.deliver(final, arrays);
      })
      .catch((error: unknown) => {
        this.downloadError = error;
        this.subscriber?.onError(error);
      });
  }
}

let loader: EarthLoader | null = null;

/** Starts downloading and building the globe, once; later calls return the same loader. */
export function earthLoader(): EarthLoader {
  loader ??= new EarthLoader();
  return loader;
}
