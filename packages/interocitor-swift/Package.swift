// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "InterocitorSwift",
    platforms: [
        .macOS(.v13),
        .iOS(.v16)
    ],
    products: [
        .library(name: "InterocitorSwift", targets: ["InterocitorSwift"])
    ],
    targets: [
        .target(
            name: "InterocitorSwift",
            // SQLite3 ships with macOS and iOS — no external dependency needed.
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "InterocitorSwiftTests",
            dependencies: ["InterocitorSwift"]
        )
    ]
)
