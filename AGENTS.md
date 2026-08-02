# Repository guidance

- Start by reading `README.md` for the public overview and package map.
- For core behavior, read `packages/core/README.md` before changing engine, sync, storage, CRDT, encryption, pairing, or file APIs.
- Keep root documentation minimal. Protocol and design deep dives belong in `docs/`; package-specific docs belong under that package.
- Treat files marked historical/planning/archive as non-authoritative. Prefer current READMEs and `packages/core/docs/*`.
- Use targeted tests for the package you change. Relevant root scripts are in `package.json`.

## Documentation goals and standards

- Before creating or substantially reworking a reader-facing surface, use the
  [content-persona cast](.context-docs/CONTENT-PERSONAS.md). Select by the
  decision the entrant controls, keep the task as an episode, and keep the
  reader goal separate from why Interocitor wants that surface to speak. If
  evidence rejects the assumed reader, goal, subject, or surface, follow that
  shift instead of forcing the planned document.
- Follow the Diataxis framework for documentation architecture and writing style: [diataxis.fr](https://diataxis.fr/). Keep tutorials, how-to guides, reference, and explanation distinct instead of blending them into one page.
- Document current behavior, not migration history. Remove bridge/legacy wording. If docs still explain how to move from old shape to new shape, cleanup is not finished.
- Prefer one primary story per concept. Show the recommended path first. Document alternatives only when they serve different scenarios.
- Lead with user-facing entry points. Package READMEs should start with the package users actually import and the first call they make.
- Browser-first packages must read browser-first. Do not route web users through core internals before showing the browser package workflow.
- Describe capabilities in terms of scenarios and guarantees before primitives and implementation details.
- For security-sensitive topics, state encryption boundaries, key custody, isolation properties, and what a database dump does or does not reveal. Write so a SOC auditor can follow the model.
- Keep docs executable: use real markdown links, valid API names, and snippets that match the current code shape.
- Root docs stay navigational. Deep protocol, security, and design material belongs in `docs/` or package-local docs.
- If a concept has a singular public API, all docs must use that same API name, argument shape, and defaults across README, package docs, examples, and deep dives.
- Do not bury multiple documentation intents in one endless README. Use the README as the landing page, then link out to focused pages for deeper how-to, reference, and explanation material.
- Substantial features need a small documentation set, not a monolith. For example, browser credential features should typically have:
  - a short package README entry and recommended first call
  - focused how-to pages for common tasks
  - a reference page for API surface and storage modes
  - an explanation/security page for custody, boundaries, and threat model
- Examples are part of the docs surface. Keep runnable examples under `examples/`, keep them aligned with the recommended public API, and link to them from the owning package docs.
