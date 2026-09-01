import { useCallback, useEffect, useRef, useState } from "react";
import type { Interocitor } from "@interocitor/core";
import { getImageBlobUrl, type StoredImageMetadata } from "@interocitor/web";

export interface UseImageResult {
  /** Revokable blob: URL, or null while skipped/loading/error. */
  url: string | null;
  /** Browser Blob backing the URL, or null while unavailable. */
  blob: Blob | null;
  loading: boolean;
  error: Error | null;
  metadata: StoredImageMetadata | null;
  contentType: string | null;
  /** Manually revoke the current URL and clear it from state. Safe to call multiple times. */
  revoke: () => void;
}

const EMPTY_RESULT: UseImageResult = {
  url: null,
  blob: null,
  loading: false,
  error: null,
  metadata: null,
  contentType: null,
  revoke: () => {},
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * React hook for display-only encrypted Interocitor images.
 *
 * Reads `path` via `getImageBlobUrl()`, returns the generated `blob:` URL,
 * and automatically revokes it on unmount/path changes. Rendering stays in app
 * code: `<img src={image.url ?? undefined} />`.
 */
export function useImage<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
>(db: Interocitor<S>, path: string | null | undefined): UseImageResult {
  const [state, setState] = useState<Omit<UseImageResult, "revoke">>(EMPTY_RESULT);
  const revokeRef = useRef<() => void>(() => {});

  const revoke = useCallback(() => {
    revokeRef.current();
    revokeRef.current = () => {};
    setState(EMPTY_RESULT);
  }, []);

  useEffect(() => {
    revoke();
    if (!path) return;

    let cancelled = false;
    setState({
      url: null,
      blob: null,
      loading: true,
      error: null,
      metadata: null,
      contentType: null,
    });

    void getImageBlobUrl(db, path)
      .then((image) => {
        if (cancelled) {
          image.revoke();
          return;
        }
        revokeRef.current = image.revoke;
        setState({
          url: image.url,
          blob: image.blob,
          loading: false,
          error: null,
          metadata: image.metadata,
          contentType: image.contentType,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          url: null,
          blob: null,
          loading: false,
          error: toError(cause),
          metadata: null,
          contentType: null,
        });
      });

    return () => {
      cancelled = true;
      revokeRef.current();
      revokeRef.current = () => {};
    };
  }, [db, path, revoke]);

  return { ...state, revoke };
}
