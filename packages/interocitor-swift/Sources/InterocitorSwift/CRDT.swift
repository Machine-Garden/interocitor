/**
 * CRDT Merge Engine — Core-compatible per-column merge
 *
 * Each column in each row carries its own HLC. LWW uses that immutable ordering
 * so every peer selects the same value regardless of discovery order.
 * Deletes are soft (tombstone with HLC).
 *
 * Implements the same built-in merge-policy resolution and tombstone rules as
 * `@interocitor/core`. Every database defaults to LWW.
 */

import Foundation

// MARK: - applyOp

/// Apply a single op to the in-memory state.
/// Returns the affected row (mutated in place) or nil if no change.
@discardableResult
public func applyOp(
    tables: inout [String: [String: Row]],
    op: Op,
    schemaVersion: Int,
    schema: DatabaseSchema? = nil
) throws -> Row? {
    if tables[op.table] == nil {
        tables[op.table] = [:]
    }

    switch op {
    case .delete(let deleteOp):
        return applyDeleteOp(tables: &tables, op: deleteOp, schemaVersion: schemaVersion)
    case .upsert(let upsertOp):
        return try applyUpsertOp(tables: &tables, op: upsertOp, schemaVersion: schemaVersion, schema: schema)
    }
}

private func resolveStrategy(
    schema: DatabaseSchema?,
    table: String,
    field: String
) -> MergeStrategy {
    if let merge = schema?.tables[table]?.merge {
        if let fieldStrategy = merge.fields[field] { return fieldStrategy }
        if let tableStrategy = merge.strategy { return tableStrategy }
    }
    return schema?.mergeStrategy ?? .lww
}

private func mergeColumn(
    local: ColumnEntry?,
    remote: ColumnEntry,
    strategy: MergeStrategy
) throws -> ColumnEntry? {
    guard let local, !local.hlc.isEmpty else { return remote }
    switch strategy {
    case .lww:
        let comparison = hlcCompareStr(remote.hlc, local.hlc)
        if comparison > 0 { return remote }
        if comparison < 0 { return nil }
        if remote.value != local.value {
            throw InterocitorError.protocolCorruption(
                "conflicting values share HLC \(remote.hlc)"
            )
        }
        return nil
    }
}

private func applyDeleteOp(
    tables: inout [String: [String: Row]],
    op: DeleteOp,
    schemaVersion: Int
) -> Row? {
    if var existing = tables[op.table]?[op.rowId] {
        // Only apply delete if its HLC is newer than the current deletedHlc
        if let existingDeletedHlc = existing._deletedHlc,
           hlcCompareStr(op.hlc, existingDeletedHlc) <= 0 {
            return nil // stale delete
        }
        // Check if any column has a newer HLC than this delete
        let hasNewerColumn = existing.columns.values.contains { entry in
            hlcCompareStr(entry.hlc, op.hlc) > 0
        }
        if hasNewerColumn { return nil }

        existing._deleted = true
        existing._deletedHlc = op.hlc
        // A tombstone must not retain user payload. Keeping old columns here
        // can resurrect stale fields when a newer partial upsert revives the
        // row on another peer.
        existing.columns = [:]
        tables[op.table]![op.rowId] = existing
        return existing
    } else {
        // Tombstone for a row we haven't seen — create it
        let row = Row(
            table: op.table,
            rowId: op.rowId,
            deleted: true,
            deletedHlc: op.hlc,
            schemaVersion: schemaVersion,
            columns: [:]
        )
        tables[op.table]![op.rowId] = row
        return row
    }
}

private func applyUpsertOp(
    tables: inout [String: [String: Row]],
    op: UpsertOp,
    schemaVersion: Int,
    schema: DatabaseSchema?
) throws -> Row? {
    var row: Row
    var changed = false

    if let existing = tables[op.table]?[op.rowId] {
        row = existing
    } else {
        row = Row(
            table: op.table,
            rowId: op.rowId,
            deleted: false,
            schemaVersion: schemaVersion,
            columns: [:]
        )
        changed = true
    }

    var columnsToApply = op.columns

    // Re-insertion is a new incarnation. Ignore fields which predate the
    // tombstone and remove all retained payload before accepting new fields.
    if row._deleted, let deletedHlc = row._deletedHlc {
        columnsToApply = columnsToApply.filter { hlcCompareStr($0.value.hlc, deletedHlc) > 0 }
        guard !columnsToApply.isEmpty else { return nil }
        row.columns = [:]
        row._deleted = false
        row._deletedHlc = nil
        changed = true
    }

    for (col, entry) in columnsToApply {
        let strategy = resolveStrategy(schema: schema, table: op.table, field: col)
        if let winner = try mergeColumn(local: row.columns[col], remote: entry, strategy: strategy) {
            row.columns[col] = winner
            changed = true
        }
    }

    tables[op.table]![op.rowId] = row
    return changed ? row : nil
}

// MARK: - applyChangeEntry

/// Apply a full change entry (potentially multiple ops).
/// Returns list of affected rows.
public func applyChangeEntry(
    tables: inout [String: [String: Row]],
    entry: ChangeEntry,
    schemaVersion: Int,
    schema: DatabaseSchema? = nil
) throws -> [Row] {
    var affected: [Row] = []
    for op in entry.ops {
        if let row = try applyOp(tables: &tables, op: op, schemaVersion: schemaVersion, schema: schema) {
            affected.append(row)
        }
    }
    return affected
}

// MARK: - Read helpers

/// Read the plain value from a row column.
public func readColumn(_ row: Row, column: String) -> AnyCodable? {
    row.columns[column]?.value
}

/// Build a plain dictionary from a row (strip HLC metadata).
public func rowToPlain(_ row: Row) -> [String: AnyCodable] {
    var result: [String: AnyCodable] = [:]
    for (key, entry) in row.columns {
        result[key] = entry.value
    }
    return result
}
