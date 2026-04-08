/**
 * Hybrid Logical Clock
 *
 * Combines wall-clock time with a logical counter to produce
 * a total order across distributed devices without coordination.
 *
 * Serialized format: "{ts}-{counter:04x}-{nodeId}"
 * Example: "1711785600000-0000-dev_x1"
 */

import Foundation

// MARK: - Constants

/// Guard against poisoned/misconfigured peers that report far-future clocks.
public let HLC_MAX_FUTURE_SKEW_MS: Int64 = 5 * 60 * 1000

// MARK: - HLC

/// Hybrid logical clock state used to order CRDT writes across devices.
public struct HLC: Sendable, Equatable {
    public var ts: Int64       // wall-clock milliseconds since epoch
    public var counter: Int    // logical tie-breaker
    public var nodeId: String  // stable device identifier

    public init(ts: Int64, counter: Int, nodeId: String) {
        self.ts = ts
        self.counter = counter
        self.nodeId = nodeId
    }
}

// MARK: - Factory

/// Create a new clock seeded from the current wall time.
public func hlcInit(nodeId: String) -> HLC {
    HLC(ts: currentMs(), counter: 0, nodeId: nodeId)
}

// MARK: - Tick

/// Tick the local clock forward for a new local event.
public func hlcNow(_ local: HLC) -> HLC {
    let wall = currentMs()
    if wall > local.ts {
        return HLC(ts: wall, counter: 0, nodeId: local.nodeId)
    }
    return HLC(ts: local.ts, counter: local.counter + 1, nodeId: local.nodeId)
}

// MARK: - Receive

/// Merge a remote HLC into the local clock (called on receive).
public func hlcReceive(_ local: HLC, _ remote: HLC) -> HLC {
    let wall = currentMs()
    let safeRemoteTs = min(remote.ts, wall + HLC_MAX_FUTURE_SKEW_MS)
    let maxTs = max(wall, max(local.ts, safeRemoteTs))

    let counter: Int
    if maxTs == local.ts && maxTs == remote.ts {
        counter = max(local.counter, remote.counter) + 1
    } else if maxTs == local.ts {
        counter = local.counter + 1
    } else if maxTs == safeRemoteTs {
        counter = remote.counter + 1
    } else {
        counter = 0
    }

    return HLC(ts: maxTs, counter: counter, nodeId: local.nodeId)
}

// MARK: - Compare

/// Total ordering: negative if a < b, 0 if equal, positive if a > b.
public func hlcCompare(_ a: HLC, _ b: HLC) -> Int {
    if a.ts != b.ts { return a.ts < b.ts ? -1 : 1 }
    if a.counter != b.counter { return a.counter - b.counter }
    if a.nodeId < b.nodeId { return -1 }
    if a.nodeId > b.nodeId { return 1 }
    return 0
}

/// Compare two serialized HLC strings without fully parsing (lexicographic).
/// Because ts is zero-padded to 15 digits and counter is zero-padded to 4 hex
/// digits, the plain string comparison is equivalent to the structured compare.
public func hlcCompareStr(_ a: String, _ b: String) -> Int {
    if a == b { return 0 }
    return a < b ? -1 : 1
}

// MARK: - Serialization

/// Serialize HLC to a string that sorts lexicographically.
/// Format: "{ts:15d}-{counter:04x}-{nodeId}"
public func hlcSerialize(_ hlc: HLC) -> String {
    let ts = String(format: "%015lld", hlc.ts)
    let counter = String(format: "%04x", hlc.counter)
    return "\(ts)-\(counter)-\(hlc.nodeId)"
}

/// Parse a serialized HLC string back to an HLC value.
public func hlcParse(_ s: String) -> HLC {
    guard let firstDash = s.firstIndex(of: "-") else {
        return HLC(ts: 0, counter: 0, nodeId: s)
    }
    let afterFirst = s.index(after: firstDash)
    guard let secondDash = s[afterFirst...].firstIndex(of: "-") else {
        return HLC(ts: 0, counter: 0, nodeId: s)
    }

    let tsStr = String(s[s.startIndex..<firstDash])
    let counterStr = String(s[afterFirst..<secondDash])
    let nodeId = String(s[s.index(after: secondDash)...])

    let ts = Int64(tsStr) ?? 0
    let counter = Int(counterStr, radix: 16) ?? 0
    return HLC(ts: ts, counter: counter, nodeId: nodeId)
}

// MARK: - Internal helper

private func currentMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
}
