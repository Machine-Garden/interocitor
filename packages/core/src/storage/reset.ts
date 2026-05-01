/**
 * Delete an Interocitor IndexedDB database after callers have disconnected
 * and cleared credentials.
 *
 * This is intentionally low-level: it only deletes the local IndexedDB
 * database named by `dbName`. Apps should call it as the final destructive
 * local reset step, then reload before creating or joining a new mesh.
 */
export function resetLocalDatabase(dbName = 'interocitor'): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`Failed to delete IndexedDB database "${dbName}"`));
    req.onblocked = () => {
      reject(new Error(`Cannot delete IndexedDB database "${dbName}" while another connection is open`));
    };
  });
}
