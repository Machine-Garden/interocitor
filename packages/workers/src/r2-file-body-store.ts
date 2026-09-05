// compass: interocitor.mailbox-host.file-body-stores

import type {
  FileBody,
  FileBodyStore,
  FileBodyValue,
  FileBodyWriteOptions,
  R2Bucket,
} from "./types.ts";

/** Cloudflare R2 binding exposed through the provider-neutral file-body boundary. */
export class R2FileBodyStore implements FileBodyStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(key: string): Promise<FileBody | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      size: object.size,
      etag: object.httpEtag || object.etag,
    };
  }

  async put(key: string, value: FileBodyValue, options: FileBodyWriteOptions = {}): Promise<void> {
    await this.bucket.put(key, value, {
      httpMetadata: { contentType: options.contentType || "application/octet-stream" },
    });
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
