/**
 * Google Drive Storage Adapter
 *
 * Uses Google Drive API v3 via OAuth2 with `drive.file` scope.
 * The app can only see files it created or the user explicitly shared.
 *
 * Requires: Google API client ID from Google Cloud Console.
 * Auth flow: Google Identity Services (GIS) popup or redirect.
 */

import type { StorageAdapter, FileEntry } from '../core/types.ts';

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

interface GoogleDriveConfig {
  clientId: string;
  /** Redirect URI for OAuth (default: current origin) */
  redirectUri?: string;
}

/**
 * Google Drive adapter using the browser OAuth token flow.
 *
 * This is the easiest zero-infrastructure option when your users already live
 * in Google Workspace or personal Drive.
 *
 * @example
 * ```ts
 * const adapter = new GoogleDriveAdapter({ clientId: 'YOUR_GOOGLE_CLIENT_ID' });
 * const engine = new SyncEngine(adapter, { remotePath: '/MyApp' });
 * ```
 */
export class GoogleDriveAdapter implements StorageAdapter {
  readonly name = 'google-drive';

  private config: GoogleDriveConfig;
  private accessToken: string | null = null;

  // Cache: path → Google Drive file ID
  private fileIdCache: Map<string, string> = new Map();
  private folderIdCache: Map<string, string> = new Map();

  constructor(config: GoogleDriveConfig) {
    this.config = config;
  }

  // ── Auth ─────────────────────────────────────────────────────────

  async authenticate(): Promise<void> {
    // Google Identity Services (GIS) token model
    // In production, use google.accounts.oauth2.initTokenClient
    // This is a simplified version using the implicit grant flow

    return new Promise((resolve) => {
      const params = new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri || window.location.origin,
        response_type: 'token',
        scope: SCOPES,
        include_granted_scopes: 'true',
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

      // Check if we already have a token from a redirect
      const hash = window.location.hash;
      if (hash.includes('access_token=')) {
        const tokenMatch = hash.match(/access_token=([^&]+)/);
        if (tokenMatch) {
          this.accessToken = decodeURIComponent(tokenMatch[1]);
          // Clean the URL
          window.history.replaceState(null, '', window.location.pathname);
          resolve();
          return;
        }
      }

      // Check localStorage for cached token
      const cached = localStorage.getItem('gdrive-access-token');
      if (cached) {
        this.accessToken = cached;
        // Verify token is still valid
        this.verifyToken().then(valid => {
          if (valid) {
            resolve();
          } else {
            localStorage.removeItem('gdrive-access-token');
            window.location.href = authUrl;
          }
        });
        return;
      }

      // Redirect to Google OAuth
      window.location.href = authUrl;
    });
  }

  /** Set token directly (for apps that handle their own OAuth flow). */
  setAccessToken(token: string): void {
    this.accessToken = token;
    localStorage.setItem('gdrive-access-token', token);
  }

  /**
   * Returns the Google OAuth clientId for embedding in a QR payload.
   * The scanner uses this to configure their GoogleDriveAdapter.
   * The OAuth flow (and resulting access token) is performed separately by the user.
   */
  getHandshakeConfig(): string {
    return JSON.stringify({ clientId: this.config.clientId });
  }

  isAuthenticated(): boolean {
    return this.accessToken !== null;
  }

  private async verifyToken(): Promise<boolean> {
    try {
      const res = await fetch(`${DRIVE_API}/about?fields=user`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private headers(): Record<string, string> {
    if (!this.accessToken) throw new Error('Not authenticated');
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  // ── File ID resolution ───────────────────────────────────────────

  /**
   * Resolve a path like "/Interocitor/changes/dev_abc.ndjson"
   * to a Google Drive file ID by walking the folder tree.
   */
  private async resolveFileId(path: string): Promise<string | null> {
    if (this.fileIdCache.has(path)) return this.fileIdCache.get(path)!;

    const parts = path.split('/').filter(Boolean);
    let parentId = 'root';

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      const cacheKey = '/' + parts.slice(0, i + 1).join('/');

      if (this.folderIdCache.has(cacheKey)) {
        parentId = this.folderIdCache.get(cacheKey)!;
        continue;
      }
      if (isLast && this.fileIdCache.has(cacheKey)) {
        return this.fileIdCache.get(cacheKey)!;
      }

      const mimeFilter = isLast ? '' : " and mimeType='application/vnd.google-apps.folder'";
      const q = `name='${name}' and '${parentId}' in parents and trashed=false${mimeFilter}`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
        { headers: this.headers() }
      );
      const data = await res.json();

      if (!data.files || data.files.length === 0) return null;

      const fileId = data.files[0].id;
      if (isLast) {
        this.fileIdCache.set(path, fileId);
      } else {
        this.folderIdCache.set(cacheKey, fileId);
      }
      parentId = fileId;
    }

    return parentId;
  }

  private async resolveFolderId(path: string): Promise<string | null> {
    if (this.folderIdCache.has(path)) return this.folderIdCache.get(path)!;

    const parts = path.split('/').filter(Boolean);
    let parentId = 'root';

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const cacheKey = '/' + parts.slice(0, i + 1).join('/');

      if (this.folderIdCache.has(cacheKey)) {
        parentId = this.folderIdCache.get(cacheKey)!;
        continue;
      }

      const q = `name='${name}' and '${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`,
        { headers: this.headers() }
      );
      const data = await res.json();

      if (!data.files || data.files.length === 0) return null;

      parentId = data.files[0].id;
      this.folderIdCache.set(cacheKey, parentId);
    }

    return parentId;
  }

  // ── StorageAdapter interface ───────────────────────────────────────

  async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    let parentId = 'root';

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const cacheKey = '/' + parts.slice(0, i + 1).join('/');

      if (this.folderIdCache.has(cacheKey)) {
        parentId = this.folderIdCache.get(cacheKey)!;
        continue;
      }

      // Check if exists
      const q = `name='${name}' and '${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
      const res = await fetch(
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`,
        { headers: this.headers() }
      );
      const data = await res.json();

      if (data.files && data.files.length > 0) {
        parentId = data.files[0].id;
      } else {
        // Create folder
        const createRes = await fetch(`${DRIVE_API}/files`, {
          method: 'POST',
          headers: {
            ...this.headers(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          }),
        });
        const created = await createRes.json();
        parentId = created.id;
      }

      this.folderIdCache.set(cacheKey, parentId);
    }
  }

  async listFiles(folderPath: string): Promise<FileEntry[]> {
    const folderId = await this.resolveFolderId(folderPath);
    if (!folderId) return [];

    const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
    const fields = 'files(id,name,size,modifiedTime)';
    const res = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${fields}`,
      { headers: this.headers() }
    );
    const data = await res.json();

    return (data.files || []).map((f: any) => {
      const path = `${folderPath}/${f.name}`;
      this.fileIdCache.set(path, f.id);
      return {
        name: f.name,
        path,
        size: parseInt(f.size || '0', 10),
        modifiedTime: f.modifiedTime,
      };
    });
  }

  async listFolders(folderPath: string): Promise<string[]> {
    const folderId = await this.resolveFolderId(folderPath);
    if (!folderId) return [];

    const q = `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`;
    const fields = 'files(name)';
    const res = await fetch(
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=${fields}`,
      { headers: this.headers() }
    );
    const data = await res.json();
    return (data.files || []).map((f: any) => f.name as string);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) throw new Error(`File not found: ${path}`);

    const res = await fetch(
      `${DRIVE_API}/files/${fileId}?alt=media`,
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Failed to read ${path}: ${res.status}`);

    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data;

    const existingId = await this.resolveFileId(path);

    if (existingId) {
      // Update existing file
      const res = await fetch(
        `${UPLOAD_API}/files/${existingId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: {
            ...this.headers(),
            'Content-Type': 'application/octet-stream',
          },
          body: bytes as unknown as BodyInit,
        }
      );
      if (!res.ok) throw new Error(`Failed to write ${path}: ${res.status}`);
    } else {
      // Create new file
      const parts = path.split('/').filter(Boolean);
      const fileName = parts.pop()!;
      const parentPath = '/' + parts.join('/');

      let parentId = await this.resolveFolderId(parentPath);
      if (!parentId) {
        await this.ensureFolder(parentPath);
        parentId = await this.resolveFolderId(parentPath);
      }

      const metadata = {
        name: fileName,
        parents: [parentId],
      };

      // Multipart upload
      const boundary = 'interocitor_boundary';
      const body =
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`;

      const bodyEnd = `\r\n--${boundary}--`;

      const bodyBytes = new TextEncoder().encode(body);
      const endBytes = new TextEncoder().encode(bodyEnd);

      const combined = new Uint8Array(bodyBytes.length + bytes.length + endBytes.length);
      combined.set(bodyBytes, 0);
      combined.set(bytes, bodyBytes.length);
      combined.set(endBytes, bodyBytes.length + bytes.length);

      const res = await fetch(
        `${UPLOAD_API}/files?uploadType=multipart`,
        {
          method: 'POST',
          headers: {
            ...this.headers(),
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: combined as unknown as BodyInit,
        }
      );

      if (!res.ok) throw new Error(`Failed to create ${path}: ${res.status}`);

      const created = await res.json();
      this.fileIdCache.set(path, created.id);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) return;

    await fetch(`${DRIVE_API}/files/${fileId}`, {
      method: 'DELETE',
      headers: this.headers(),
    });

    this.fileIdCache.delete(path);
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) return null;

    const res = await fetch(
      `${DRIVE_API}/files/${fileId}?fields=id,name,size,modifiedTime`,
      { headers: this.headers() }
    );
    if (!res.ok) return null;

    const data = await res.json();
    return {
      name: data.name,
      path,
      size: parseInt(data.size || '0', 10),
      modifiedTime: data.modifiedTime,
    };
  }

  /** Clear caches (useful after compaction deletes files). */
  clearCache(): void {
    this.fileIdCache.clear();
    this.folderIdCache.clear();
  }
}
