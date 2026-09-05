// compass: interocitor.trust.credential-custody

/**
 * Connected Stores — credentials for derived sub-stores of this Interocitor.
 *
 * Scope: this module only **stores** credentials for other Interocitor
 * stores that this one owns conceptually (sub-stores). It does NOT
 * construct child engines, run them, pair them, or know about adapters.
 * Apps read credentials and build whatever Interocitor they want.
 *
 * Persistence: a single JSON list under a dedicated meta key in the parent
 * LocalStore. No rows, no tables — sub-store credentials never appear in
 * the parent's data model.
 *
 * Direction: one-way by construction. The parent stores credentials for
 * sub-stores; sub-stores have no awareness of the parent.
 *
 * Security stance: anyone with read access to the parent inherits read
 * access to every sub-store's credentials. That is the intended model
 * for derived sub-stores.
 */

import type { LocalStore } from "./types.ts";

const REGISTRY_META_KEY = "interocitor:connected-stores";

/** Adapter pointer. Opaque to the engine; apps interpret `kind` and `config`. */
export interface ConnectedStoreAdapterRef {
  kind: string;
  config?: string;
}

/**
 * Credentials for a sub-store. Just enough for an app to construct the
 * corresponding child Interocitor; the engine never reads these fields.
 */
export interface ConnectedStoreCredentials {
  /** Stable id for the sub-store. Required and unique within parent. */
  id: string;
  /** Optional human-readable label. */
  alias?: string;
  /** Remote folder path inside the adapter for the sub-store. */
  remotePath: string;
  /** Sub-store passphrase, or null for unencrypted sub-stores. */
  passphrase: string | null;
  /** Whether the sub-store uses encryption. */
  encrypted: boolean;
  /** Suggested local store namespace for the sub-store. */
  dbName: string;
  /** Optional adapter pointer the app can use to materialize a StorageAdapter. */
  adapter?: ConnectedStoreAdapterRef;
  /** Optional human-readable app name. */
  appName?: string;
  /** Free-form metadata for app UI. */
  metadata?: Record<string, unknown>;
  /** ISO timestamp the credentials were first stored. Set by the registry. */
  createdAt?: string;
  /** ISO timestamp of the most recent update. Set by the registry. */
  updatedAt?: string;
}

/**
 * Credential vault for connected (sub-)stores.
 *
 * No `connect()`, no factories, no adapter resolution. Apps read what they
 * need and build their own engines.
 */
export interface ConnectedStoresApi {
  list(): Promise<ConnectedStoreCredentials[]>;
  get(id: string): Promise<ConnectedStoreCredentials | null>;
  put(credentials: ConnectedStoreCredentials): Promise<ConnectedStoreCredentials>;
  remove(id: string): Promise<boolean>;
}

/** LocalStore-backed implementation. JSON list under a single meta key. */
export class LocalStoreConnectedStoresApi implements ConnectedStoresApi {
  constructor(private readonly local: LocalStore) {}

  private async readAll(): Promise<ConnectedStoreCredentials[]> {
    const raw = await this.local.getMeta(REGISTRY_META_KEY);
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as ConnectedStoreCredentials[];
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ConnectedStoreCredentials[]) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  private async writeAll(creds: ConnectedStoreCredentials[]): Promise<void> {
    await this.local.setMeta(REGISTRY_META_KEY, JSON.stringify(creds));
  }

  async list(): Promise<ConnectedStoreCredentials[]> {
    return this.readAll();
  }

  async get(id: string): Promise<ConnectedStoreCredentials | null> {
    const all = await this.readAll();
    return all.find((c) => c.id === id) ?? null;
  }

  async put(credentials: ConnectedStoreCredentials): Promise<ConnectedStoreCredentials> {
    if (!credentials.id) throw new Error("ConnectedStoreCredentials.id is required");
    const now = new Date().toISOString();
    const all = await this.readAll();
    const existing = all.find((c) => c.id === credentials.id);
    const stamped: ConnectedStoreCredentials = {
      ...credentials,
      createdAt: existing?.createdAt ?? credentials.createdAt ?? now,
      updatedAt: now,
    };
    const next = [...all.filter((c) => c.id !== credentials.id), stamped];
    await this.writeAll(next);
    return stamped;
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.readAll();
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    await this.writeAll(next);
    return true;
  }
}
