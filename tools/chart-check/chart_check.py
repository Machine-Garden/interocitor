# chart_check.py — decidable Compass chart invariants. Run from the repository root:
#     python3 tools/chart-check/chart_check.py
# Wired into `yarn check:chart`, which `yarn check:static` runs.
# MINIMUM below is committed on purpose: a check that scanned nothing exits zero
# exactly like a check that scanned everything. Changing a minimum is ask-first.
import pathlib, re, sys
CHART = pathlib.Path(".compass")          # the declared chart root
ABSTRACTIONS = CHART / "ABSTRACTIONS.md"
FIXTURES = pathlib.Path("tests/fixtures/compass")  # declared, does not exist yet; the one exempt path
SELF = pathlib.Path(__file__).resolve()
# Include every source suffix allowed to carry `//`, `#`, or `--` markers.
# Build output carries copies of every marker in its sources; scanning it would make
# the counts depend on whether anyone has run a build.
IGNORED = {"node_modules", "dist", "build", ".yarn"}
SRC_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".go", ".rs",
                ".java", ".rb", ".swift", ".sql"}

fail, seen = [], {"addresses": 0, "abstraction_definitions": 0,
                  "abstraction_markers": 0, "links": 0, "coordinates": 0,
                  "blocks": 0, "diagrams": 0}
# every line, not just the first: a marker legitimately sits under a comment, a licence
# header or an import block, and a file may carry a second coordinate for another root
addr_re = re.compile(r"^\s*(?:#|//|--)\s*compass:\s*(\S+)", re.M)
abstraction_claim_re = re.compile(
    r"^[ \t]*(?:#|//|--)[ \t]*compass-abstraction:[ \t]+(.*?)[ \t]*$", re.M)
anchors = lambda t: {re.sub(r"[^a-z0-9 -]", "", h.lower()).replace(" ", "-")
                     for h in re.findall(r"^#{1,6} (.+)$", t, re.M)}

def doc_for(address):                      # root | root.block | root.block.component
    return CHART.joinpath(*address.split(".")) / "README.md"

entries = []
if ABSTRACTIONS.exists():
    abstraction_body = ABSTRACTIONS.read_text()
    heading_count = len(re.findall(r"^## ", abstraction_body, re.M))
    entry_re = re.compile(
        r"^## [^\n]+ \(`([a-z0-9]+(?:-[a-z0-9]+)*)`\)[ \t]*\n(.*?)(?=^## |\Z)",
        re.M | re.S)
    entries = entry_re.findall(abstraction_body)
    seen["abstraction_definitions"] = len(entries)
    if not entries:
        fail.append(f"{ABSTRACTIONS}: no named abstraction definitions")
    if len(entries) != heading_count:
        fail.append(f"{ABSTRACTIONS}: every ## heading must be 'Name (`lowercase-slug`)'")
    slugs = [slug for slug, _ in entries]
    for slug in sorted({slug for slug in slugs if slugs.count(slug) > 1}):
        fail.append(f"{ABSTRACTIONS}: duplicate abstraction slug '{slug}'")
    for slug, section in entries:
        for heading in ("Meaning", "Essential discriminator", "Nearest non-example"):
            field = re.search(
                rf"^### {re.escape(heading)}[ \t]*\n(.*?)(?=^### |\Z)",
                section, re.M | re.S)
            if not field or not field.group(1).strip():
                fail.append(f"{ABSTRACTIONS}: '{slug}' lacks ### {heading}")

definition_slugs = [slug for slug, _ in entries]
for p in pathlib.Path(".").rglob("*"):
    # any dotted directory: .git, .venv, and — the one that bites — a nested git worktree,
    # which otherwise counts every marker in the repository twice
    if p.is_dir() or any(x.startswith(".") for x in p.parts[:-1]): continue
    if IGNORED & set(p.parts) or p.suffix not in SRC_SUFFIXES: continue
    source = p.read_text(errors="ignore")
    for address in addr_re.findall(source):
        seen["addresses"] += 1
        if not doc_for(address).exists():
            fail.append(f"{p}: compass: {address} resolves to nothing")

def inside_nested_worktree(p):
    return any(parent != pathlib.Path(".") and (parent / ".git").exists()
               for parent in p.parents)

for p in pathlib.Path(".").rglob("*"):
    # Unlike coordinate scanning, legitimate hidden source directories such as
    # .storybook remain in the named-abstraction universe.
    if p.is_dir() or IGNORED & set(p.parts) or ".git" in p.parts or ".venv" in p.parts:
        continue
    # the declared fixtures and this file spell invalid literals on purpose; nothing else is exempt
    if p.resolve() == SELF or FIXTURES in p.parents: continue
    if inside_nested_worktree(p) or p.suffix not in SRC_SUFFIXES: continue
    source = p.read_text(errors="ignore")
    for slug in abstraction_claim_re.findall(source):
        seen["abstraction_markers"] += 1
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
            fail.append(f"{p}: invalid compass-abstraction slug '{slug}'")
        elif definition_slugs.count(slug) != 1:
            fail.append(f"{p}: compass-abstraction: {slug} does not resolve exactly once")

for root in (d for d in CHART.iterdir() if d.is_dir() and d.name != "externals"):
    containers = root / "CONTAINERS.md"
    if not containers.exists():
        fail.append(f"{root.name}: no CONTAINERS.md"); continue
    listed = set(re.findall(r"\]\(\./([^/)]+)/README\.md\)", containers.read_text()))
    dirs = {d.name for d in root.iterdir() if d.is_dir()}
    seen["blocks"] += len(dirs)
    for miss in dirs - listed: fail.append(f"{root.name}: block '{miss}' is not in CONTAINERS.md")
    for miss in listed - dirs: fail.append(f"{root.name}: CONTAINERS.md lists '{miss}', no folder")

for md in CHART.rglob("*.md"):
    body = md.read_text()
    for href in re.findall(r"\]\(([^)\s]+)\)", body):
        if href.startswith(("http", "mailto:")): continue
        path, _, anchor = href.partition("#")
        target = (md.parent / path) if path else md
        seen["links"] += 1
        if path and not target.exists(): fail.append(f"{md}: dead link {href}")
        elif anchor and not target.is_file():
            fail.append(f"{md}: anchor into a non-document {href}")
        elif anchor and anchor not in anchors(target.read_text(errors="ignore")):
            fail.append(f"{md}: dead anchor {href}")
    # coordinates only. A token with no separator is prose; one with a placeholder is a shape
    section = re.search(r"^## Implementation coordinates\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    for coord in re.findall(r"`([^`]+)`", section.group(1) if section else ""):
        if "/" not in coord or any(c in coord for c in "<>{}*"): continue
        seen["coordinates"] += 1
        if not pathlib.Path(coord).exists(): fail.append(f"{md}: coordinate {coord} not on disk")
    # the five zoom-chain kinds each require a diagram
    zoom = md.name in ("CONTAINERS.md", "VIEWPORTS.md") or (
        md.name == "README.md" and md.parent != CHART)
    if zoom:
        seen["diagrams"] += 1
        if not re.search(r"^ {0,3}```\s*mermaid", body, re.M):
            fail.append(f"{md}: no mermaid diagram")

for name in ("SCOPE.md", "CONTEXT.md", "BLOCK.md", "COMPONENT.md"):
    for p in CHART.rglob(name): fail.append(f"{p}: identity documents are README.md")

# Commit the minimum beside this command. Chart-side counts take the count at the last passing
# run and move only in the diff that changes the chart. Source-side counts (addresses,
# abstraction_markers) take 1 once Phase F has sealed anything or a marker has claimed anything:
# they guard against a scan that stopped looking, not against a declutter that bubbles up.
MINIMUM = {"blocks": 5, "diagrams": 30, "links": 272, "coordinates": 66, "abstraction_definitions": 0,
           "addresses": 1, "abstraction_markers": 0}
for k, minimum in MINIMUM.items():
    if seen[k] < minimum:
        fail.append(f"{k}: {seen[k]} scanned, minimum is {minimum} — the check stopped looking")
print("\n".join(fail) or "chart: clean — " + ", ".join(f"{v} {k}" for k, v in seen.items()))
