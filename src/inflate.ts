/** Inflates raw DEFLATE data, natively where the browser can, else with fflate. */
export async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (typeof DecompressionStream === "function") {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Older engines know DecompressionStream but not this format.
    }
  }
  const { inflateSync } = await import("fflate");
  return inflateSync(data);
}

export interface StreamInflater {
  /** Adds compressed bytes; the inflated ones come out through the callback. */
  push(chunk: Uint8Array<ArrayBuffer>): void;
  /** Resolves once everything pushed has come out, or rejects if the data is damaged. */
  end(): Promise<void>;
}

/** Inflates raw DEFLATE data as it arrives, so it can be used before the end is in. */
export async function createInflater(onData: (chunk: Uint8Array) => void): Promise<StreamInflater> {
  if (typeof DecompressionStream === "function") {
    let stream: DecompressionStream | null = null;
    try {
      stream = new DecompressionStream("deflate-raw");
    } catch {
      // Older engines know DecompressionStream but not this format.
    }
    if (stream) {
      const writer = stream.writable.getWriter();
      const reader = stream.readable.getReader();
      const drained = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          onData(value);
        }
      })();
      // Damage surfaces once, from end(); until then nobody is waiting on it.
      drained.catch(() => {});
      return {
        push: (chunk) => {
          writer.write(chunk).catch(() => {});
        },
        end: async () => {
          await writer.close().catch(() => {});
          await drained;
        },
      };
    }
  }
  const { Inflate } = await import("fflate");
  const inflater = new Inflate((chunk) => onData(chunk));
  let failure: unknown = null;
  const guard = (run: () => void) => {
    if (failure) return;
    try {
      run();
    } catch (error) {
      failure = error;
    }
  };
  return {
    push: (chunk) => guard(() => inflater.push(chunk)),
    end: async () => {
      guard(() => inflater.push(new Uint8Array(0), true));
      if (failure) throw failure;
    },
  };
}
