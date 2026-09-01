# Content-persona cast for Interocitor

Interocitor's public and technical documentation repeatedly serves readers who
must evaluate the application boundary, build a trusted endpoint, or own a
remote mailbox deployment. This cast does not describe end-user market
segments, every role that could touch a deployment, or universal personas for
local-first software.

## Casting verdict

`PROCEED` with three provisional decision-rights classes: **Application-fit
evaluator**, **Trusted-endpoint builder**, and **Mailbox deployment owner**.

Browser developer, Swift developer, Python worker author, protocol implementer,
SOC reviewer, storage operator, and AI agent were not promoted to sibling
personas. They describe a technology, task, review lens, ambiguous operational
role, or trusted-endpoint form. Use them as episodes or modifiers only when they
change the starting context, proof, boundary, density, or next route.

## Goal scaffold

| Layer           | Current evidence-backed answer                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project outcome | Let applications keep structured state useful offline and convergent across trusted devices while remote storage carries protected content without plaintext access.                                  |
| Subject promise | Interocitor provides local-first CRDT rows and directly remote durable files, with client-side protection when a non-null key source is used. Their availability guarantees differ.                   |
| Authorial goal  | Help a decision-maker reject or accept the data and threat model, help a trusted-endpoint builder integrate the matching surface, and help a deployment owner accept and operate the remote boundary. |
| Evidence        | The [technical overview](../README.md), [public-site contract](../docs/README.md), [plain-language boundaries](../docs/QA.md), package READMEs, examples, and repository guidance.                    |
| Non-fit         | Interocitor is a library and protocol, not an end-user hosting service, server-side query engine, selective row-sharing system, or exactly-once job queue.                                            |

## Select by the decision the entrant controls

| Content-persona class         | Durable starting point and decision right                                                                                                                   | Generic reader goal                                                                                                                                            | Observable success                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Application-fit evaluator** | The entrant has an application scenario and can accept or reject Interocitor's data model, trust boundary, and operational tradeoffs.                       | Decide whether local full-copy rows, trusted endpoints, client-held keys, metadata exposure, and directly remote files fit the application.                    | Reach a justified fit or non-fit decision and the correct deeper technical route without inferring unsupported guarantees.    |
| **Trusted-endpoint builder**  | Interocitor has been selected; the entrant controls an application or peer that may hold plaintext and a mesh key.                                          | Compose the appropriate packages or protocol implementation, preserve row/file distinctions and security boundaries, and validate observable interoperability. | A documented integration or peer path works from its stated starting state and fails within the published contract.           |
| **Mailbox deployment owner**  | The entrant controls or accepts risk for a remote mailbox deployment, its access policy, storage, quotas, availability, retention, and recovery operations. | Choose and operate a backend while preserving the boundary between trusted endpoints and an untrusted or honest-but-curious storage layer.                     | The deployment's policy, metadata exposure, limits, backup obligations, and failure/recovery paths are explicit and testable. |

The same person or coding agent may move between these classes when the
decision they control changes. Select one primary class for a surface or major
route; route a materially different decision to its established owner instead
of writing parallel versions of the same facts.

## Keep tasks below the cast

| Observed episode                                 | Class                     | Context or modifier                                        | Established route                                                             |
| ------------------------------------------------ | ------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Decide product and threat-model fit              | Application-fit evaluator | Product scenario and security questions                    | Public homepage, visual explanation, and plain-language Q&A                   |
| Integrate a browser application                  | Trusted-endpoint builder  | Browser-first; local and credential stores are available   | Root package map, web/react package docs, and runnable examples               |
| Build a Swift, Python, or custom compatible peer | Trusted-endpoint builder  | Protocol compatibility and cross-runtime proof matter      | Runtime package docs, core contracts, protocol flows, and compatibility tests |
| Deploy or maintain the Cloudflare mailbox        | Mailbox deployment owner  | Policy, D1/R2 limits, metadata, availability, and recovery | Workers package and its security, runtime, and maintenance docs               |

An AI agent processing rows is a trusted-endpoint episode, not a new class. It
receives database plaintext when given the shared key and does not gain
selective table access or exactly-once queue semantics. “Operator” is too
ambiguous to cast without evidence: it can mean a trusted endpoint, storage
provider, or deployment owner with different authority.

## Form the task-local story

For a new or substantially reworked surface, combine:

```text
primary class + proven modifier + current episode + reader goal
+ authorial goal + intended change + proof and boundary + completion route
```

Treat the current page contracts in [docs/README.md](../docs/README.md) and the
repository routes in [AGENTS.md](../AGENTS.md) as evidence, not automatic
personas. If the actual entrant, controlled decision, subject promise, or
reachable owner conflicts with them, recast and accept a change of reader,
goal, surface, subject, or the need for a document.

## Confidence and progressive disclosure

This cast is based on current repository entry points, contracts, packages, and
examples. It is not validated by interviews, analytics, support volume, or
external adoption evidence. The Swift and Python peer
implementations make “compatible peer” a real episode, while their shared
content delta remains covered by existing runtime and protocol routes rather
than a separate durable class.

No subclass file is currently earned. Add one under
`.context-docs/content-personas/` only when recurring evidence shows a content
delta that cannot remain compact here; the child contains only the delta from
its parent. Recast when a recurring entrant cannot fit, two classes stop
predicting different content choices, or the product's supported data model,
trust boundary, runtime set, or operational ownership changes.
