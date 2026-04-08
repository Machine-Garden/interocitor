/**
 * CRDT Merge Engine — Last-Writer-Wins per column
 *
 * Each column in each row carries its own HLC.
 * The highest HLC wins for that column independently.
 * Deletes are soft (tombstone with HLC).
 *
 * Mirrors packages/interocitor/src/core/crdt.ts
 */

import Foundation

// MARK: - applyOp

/// Apply a single op to the in-memory state.
/// Returns the affected row (mutated in place) or nil if no change.
@discardableResult
public func applyOp(
    tables: inout [String: [String: Row]],
    op: Op,
    schemaVersion: Int
) -> Row? {
    if tables[op.table] == nil {
        tables[op.table] = [:]
    }

    switch op {
    case .delete(let deleteOp):
        return applyDeleteOp(tables: &tables, op: deleteOp, schemaVersion: schemaVersion)
    case .upsert(let upsertOp):
        return applyUpsertOp(tables: &tables, op: upsertOp, schemaVersion: schemaVersion)
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
    schemaVersion: Int
) -> Row? {
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

    for (col, entry) in op.columns {
        if let existing = row.columns[col] {
            if hlcCompareStr(entry.hlc, existing.hlc) > 0 {
                row.columns[col] = entry
                changed = true
            }
        } else {
            row.columns[col] = entry
            changed = true
        }
    }

    // An upsert newer than a delete revives the row
    if row._deleted, let deletedHlc = row._deletedHlc {
        let newestOpHlc = op.columns.values
            .map(\.hlc)
            .max { hlcCompareStr($0, $1) < 0 }
        if let newestOpHlc, hlcCompareStr(newestOpHlc, deletedHlc) > 0 {
            row._deleted = false
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
    schemaVersion: Int
) -> [Row] {
    var affected: [Row] = []
    for op in entry.ops {
        if let row = applyOp(tables: &tables, op: op, schemaVersion: schemaVersion) {
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
