// compass: interocitor.trust.encryption

/**
 * Raw DEFLATE (RFC 1951) for envelope plaintext.
 *
 * Every Interocitor runtime has this codec without a dependency: browsers,
 * Node and Workers expose it as `CompressionStream("deflate-raw")`, Python as
 * `zlib` with `wbits=-15`, and Apple platforms as `COMPRESSION_ZLIB`.
 */

import { asBufferSource } from "./bytes.ts";

/**
 * Largest plaintext a compressed envelope may hold.
 *
 * Writers seal anything larger uncompressed, so a reader that stops inflating
 * past this size rejects only envelopes no conforming writer produces. The cap
 * keeps a hostile key holder from crashing other devices with a small payload
 * that inflates without bound.
 */
export const MAX_INFLATED_BYTES: number = 256 * 1024 * 1024;

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`Compressed payload inflates past ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function through(bytes: Uint8Array, transform: CompressionStream | DecompressionStream) {
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(asBufferSource(bytes));
      controller.close();
    },
  });
  return source.pipeThrough(transform);
}

export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(through(bytes, new CompressionStream("deflate-raw")), Number.POSITIVE_INFINITY);
}

/** Inflate raw DEFLATE, refusing output beyond {@link MAX_INFLATED_BYTES}. */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await collect(
      through(bytes, new DecompressionStream("deflate-raw")),
      MAX_INFLATED_BYTES,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Compressed payload is malformed: ${reason}`, { cause: err });
  }
}
