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
