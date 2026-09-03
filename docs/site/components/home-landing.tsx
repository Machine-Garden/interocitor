import { SpaLink } from "./spa-link";

export function HomeLanding() {
  return (
    <div className="home-page">
      <SpaLink className="skip-link" href="#main">
        Skip to content
      </SpaLink>
      <header className="site-header">
        <div className="shell nav">
          <SpaLink className="brand" href="#top" aria-label="Interocitor home">
            <img className="brand-logo" src="/assets/hero-dark.svg" alt="Interocitor" />
          </SpaLink>
          <nav className="nav-links" aria-label="Primary navigation">
            <SpaLink href="#why">Why Interocitor</SpaLink>
            <SpaLink href="examples/todomvc/">Live TodoMVC</SpaLink>
            <SpaLink href="#decisions">Architecture guides</SpaLink>
            <SpaLink href="#security">Trust boundary</SpaLink>
          </nav>
          <SpaLink className="nav-cta" href="how-it-works.html">
            How it works <span aria-hidden="true">↗</span>
          </SpaLink>
        </div>
      </header>
      <main id="main">
        <section id="top" className="site-hero" aria-labelledby="hero-title">
          <div className="shell site-hero-inner">
            <div className="site-hero-copy">
              <p className="site-kicker">Local-first data over storage you choose</p>
              <h1 id="hero-title">
                Your app keeps working.
                <span className="heading-highlight">Your storage provider stays blind.</span>
              </h1>
              <p className="site-hero-lede">
                Interocitor keeps structured data on trusted devices, syncs independent changes when
                connectivity returns, and carries documents and media as durable files. With a key
                source, payloads are encrypted before remote storage receives them.
              </p>
              <div className="actions">
                <SpaLink className="button primary demo-button" href="examples/todomvc/">
                  Try live TodoMVC <span aria-hidden="true">↗</span>
                </SpaLink>
                <SpaLink className="button secondary" href="how-it-works.html">
                  See the technical model
                </SpaLink>
              </div>
            </div>
          </div>
        </section>

        <section id="why" className="site-section why-section" aria-labelledby="why-title">
          <div className="shell section-intro">
            <div>
              <p className="site-kicker">Why Interocitor</p>
              <h2 id="why-title">Keep work close. Use the network to move it.</h2>
            </div>
            <div className="intro-copy">
              <p>
                Server-owned state is convenient, but it turns network outages into product outages
                and puts database operators inside the plaintext trust boundary. Interocitor splits
                synchronization from storage: trusted endpoints merge changes; the remote stores and
                moves them.
              </p>
            </div>
          </div>

          <div className="shell responsibility-map">
            <p>Responsibility split with a non-null key source</p>
            <dl>
              <div>
                <dt>Trusted devices</dt>
                <dd>Keep working state and resolve changes.</dd>
              </div>
              <div>
                <dt>Remote mailbox</dt>
                <dd>Stores and moves encrypted artifacts.</dd>
              </div>
              <div>
                <dt>Storage operator</dt>
                <dd>Operates storage without payload plaintext.</dd>
              </div>
            </dl>
          </div>

          <div className="shell reason-grid">
            <article>
              <h3>Keep working without a round trip</h3>
              <p>
                A local-first interface can respond from local state when a device is in the field,
                moving between networks, or temporarily offline. Connectivity becomes the way work
                travels, not a prerequisite for doing the work.
              </p>
            </article>
            <article>
              <h3>Store data without sharing the contents</h3>
              <p>
                A provider can retain and serve encrypted artifacts without needing the final
                decryption key. This narrows the confidentiality boundary and makes a storage dump
                materially less revealing than a plaintext application database.
              </p>
            </article>
            <article>
              <h3>Put the mailbox where it belongs</h3>
              <p>
                The same application model can use a Cloudflare mailbox, a user’s Google Drive, a
                WebDAV server or home NAS, or a custom adapter. The storage decision can follow the
                product’s deployment, ownership, and operational needs.
              </p>
            </article>
          </div>
        </section>

        <section id="use-cases" className="site-section use-section" aria-labelledby="use-title">
          <div className="shell">
            <div className="section-intro compact-intro">
              <div>
                <p className="site-kicker">See it in action</p>
                <h2 id="use-title">Local collaboration, protected data and trusted automation.</h2>
              </div>
              <p>
                One model covers application state that changes, files that must stay exact, and
                trusted workers that need to participate without exposing their work to storage.
              </p>
            </div>

            <div className="task-examples">
              <article className="task-example todo-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>01</span> Local-first application
                  </p>
                  <h3>TodoMVC, live in this browser.</h3>
                  <p>
                    Use two familiar TodoMVC clients side by side. A live in-page filesystem exposes
                    the exact manifest, device, head, and change files without asking the visitor to
                    provide storage or run a backend.
                  </p>
                  <div className="example-outcome">
                    <strong>Make convergence observable.</strong>
                    <span>
                      Change either client, simulate a disconnect, and inspect the files created on
                      reconnection. Everything resets when the page reloads.
                    </span>
                    <SpaLink href="examples/todomvc/">
                      Try the live TodoMVC <span aria-hidden="true">→</span>
                    </SpaLink>
                  </div>
                </div>

                <div className="code-window" aria-label="Partial TodoMVC application code">
                  <div className="code-window-bar">
                    <span aria-hidden="true">
                      <i></i>
                      <i></i>
                      <i></i>
                    </span>
                    <b>one page · two clients</b>
                  </div>
                  <pre>
                    <code>
                      <span className="code-keyword">const</span> memory ={" "}
                      <span className="code-keyword">new</span> MemoryAdapter();
                      <span className="code-keyword">const</span> left = createDatabase(
                      <span className="code-string">'client-1'</span>);
                      <span className="code-keyword">const</span> right = createDatabase(
                      <span className="code-string">'client-2'</span>);
                      <span className="code-keyword">await</span> left.table(
                      <span className="code-string">'todos'</span>).add({"{"}
                      title: <span className="code-string">'Ship it'</span>, done:{" "}
                      <span className="code-value">false</span>
                      {"}"});
                      <span className="code-keyword">await</span> left.flush();
                      <span className="code-keyword">await</span> right.pull();
                    </code>
                  </pre>
                </div>
              </article>

              <article className="task-example chat-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>02</span> End-to-end encrypted chat
                  </p>
                  <h3>Two clients. One mailbox that cannot read the conversation.</h3>
                  <p>
                    Alice and Bob share a mesh key and exchange message rows through an inspectable
                    in-page mailbox. The application deletes messages older than the newest fifteen,
                    synchronizes the tombstones, and compacts covered history.
                  </p>
                  <div className="example-outcome">
                    <strong>Inspect the actual ciphertext.</strong>
                    <span>
                      Send from either client, watch the other converge, and verify that the mailbox
                      never receives the message text. Everything resets when the page reloads.
                    </span>
                    <SpaLink href="examples/chat/">
                      Try encrypted chat <span aria-hidden="true">→</span>
                    </SpaLink>
                  </div>
                </div>

                <div
                  className="chat-route"
                  aria-label="Encrypted chat message moving through a blind mailbox"
                >
                  <div className="chat-bubble alice-bubble">
                    <span>Alice</span>
                    <strong>Meet at five?</strong>
                    <small>plaintext endpoint</small>
                  </div>
                  <div className="chat-envelope">
                    <span>Mailbox</span>
                    <strong>v1 · iv · ciphertext</strong>
                    <small>no mesh key</small>
                  </div>
                  <div className="chat-bubble bob-bubble">
                    <span>Bob</span>
                    <strong>Meet at five?</strong>
                    <small>plaintext endpoint</small>
                  </div>
                  <p>
                    <strong>15</strong> newest messages remain visible on both clients.
                  </p>
                </div>
              </article>

              <article className="task-example board-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>03</span> Collaborative board
                  </p>
                  <h3>A Trello-style board that works from each local copy.</h3>
                  <p>
                    Maya and Noah add and move cards independently, then exchange encrypted row
                    changes through the in-page mailbox. Their boards converge without asking the
                    mailbox to understand columns, cards, or conflicts.
                  </p>
                  <div className="example-outcome">
                    <strong>Make independent edits, then sync.</strong>
                    <span>
                      Watch each board stay local until both clients exchange their changes.
                    </span>
                    <SpaLink href="examples/board/">
                      Try the shared board <span aria-hidden="true">→</span>
                    </SpaLink>
                  </div>
                </div>
                <div className="board-preview" aria-label="Three-column local-first board preview">
                  <section>
                    <span>Ideas</span>
                    <b>Interview users</b>
                    <b>Plan launch</b>
                  </section>
                  <section>
                    <span>Doing</span>
                    <b>Rewrite onboarding</b>
                  </section>
                  <section>
                    <span>Done</span>
                    <b>Private beta</b>
                  </section>
                </div>
              </article>

              <article className="task-example locator-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>04</span> Protected family location
                  </p>
                  <h3>Strong payload privacy does not make a safety product.</h3>
                  <p>
                    Two devices share encrypted latest-known location rows while the mailbox sees no
                    place names or coordinates. The five-second demo cadence keeps both views
                    current; broad key-holder access, consent, revocation, and emergency reliability
                    remain product responsibilities.
                  </p>
                  <div className="example-outcome">
                    <strong>Inspect the privacy boundary and the failure boundary.</strong>
                    <span>
                      This is a protected-data demonstration, not a tracking recommendation.
                    </span>
                    <SpaLink href="examples/family-locator/">
                      Try the locator boundary <span aria-hidden="true">→</span>
                    </SpaLink>
                  </div>
                </div>
                <div className="locator-preview" aria-label="Two protected latest-known locations">
                  <span className="preview-road road-one"></span>
                  <span className="preview-road road-two"></span>
                  <b className="preview-pin pin-alex">
                    Alex <small>Home</small>
                  </b>
                  <b className="preview-pin pin-sam">
                    Sam <small>School</small>
                  </b>
                  <p>
                    <strong>Latest known</strong> is not live or emergency-safe.
                  </p>
                </div>
              </article>

              <article className="task-example file-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>05</span> Private file share
                  </p>
                  <h3>A private Dropbox over storage you choose.</h3>
                  <p>
                    Let storage do what it is good at—retain and deliver files—without giving it the
                    document contents. Interocitor encrypts bytes before the adapter receives them,
                    then another paired endpoint decrypts the same object.
                  </p>
                </div>

                <div
                  className="file-route"
                  role="img"
                  aria-label="A file is encrypted on one trusted device, stored as ciphertext in the user's cloud, and decrypted on another paired device."
                >
                  <div className="file-endpoint">
                    <span>Trusted device</span>
                    <strong>plan.pdf</strong>
                    <small>readable</small>
                  </div>
                  <div className="file-transfer">
                    <span>encrypt</span>
                    <b aria-hidden="true">→</b>
                  </div>
                  <div className="file-mailbox">
                    <span>User’s cloud</span>
                    <strong>7f a2 91 c8…</strong>
                    <small>ciphertext + metadata</small>
                  </div>
                  <div className="file-transfer reverse">
                    <span>decrypt</span>
                    <b aria-hidden="true">→</b>
                  </div>
                  <div className="file-endpoint">
                    <span>Paired device</span>
                    <strong>plan.pdf</strong>
                    <small>readable</small>
                  </div>
                </div>

                <pre className="file-code" aria-label="Partial durable-file application code">
                  <code>
                    <span className="code-keyword">await</span> db.putFile(path, bytes, file.type);
                    <span className="code-keyword">const</span> copy ={" "}
                    <span className="code-keyword">await</span> db.getFile(path);
                  </code>
                </pre>
                <p className="example-limit">
                  File calls use the remote directly, so transfers need connectivity. Object paths,
                  sizes, timing, and request identity can still be visible to the storage operator.
                </p>
              </article>

              <article className="task-example agent-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>06</span> Agent workflow
                  </p>
                  <h3>Share task state without exposing it to storage.</h3>
                  <p>
                    A product writes a task row. An authorized agent endpoint observes it, does the
                    work, and writes result rows or files back into the same mesh. Both endpoints
                    can keep their own working state; the mailbox only exchanges encrypted
                    artifacts. Work that must happen once needs an application-owned claim, lease,
                    or safe retry rule.
                  </p>
                </div>

                <figure className="agent-workflow">
                  <div className="workflow-node trusted-node">
                    <span>Trusted endpoint</span>
                    <strong>Product</strong>
                    <small>Writes task rows</small>
                  </div>
                  <div className="workflow-transfer">
                    <span>encrypted changes</span>
                    <b aria-hidden="true">⇄</b>
                  </div>
                  <div className="workflow-node blind-node">
                    <span>Remote mailbox</span>
                    <strong>Cannot read the task</strong>
                    <small>Stores artifacts</small>
                  </div>
                  <div className="workflow-transfer">
                    <span>encrypted results</span>
                    <b aria-hidden="true">⇄</b>
                  </div>
                  <div className="workflow-node trusted-node agent-node">
                    <span>Trusted endpoint</span>
                    <strong>Agent</strong>
                    <small>Reads, acts, writes</small>
                  </div>
                  <figcaption>
                    The agent holds a mesh key and sees plaintext, so isolate workflows into
                    separate databases and keys when they need smaller trust boundaries.
                  </figcaption>
                </figure>
              </article>
            </div>
          </div>
        </section>

        <section
          id="plain-language"
          className="site-section story-section"
          aria-labelledby="story-title"
        >
          <div className="shell story-layout">
            <div className="story-heading">
              <p className="site-kicker">What that means in practice</p>
              <h2 id="story-title">
                The useful copy stays close. The remote carries sealed parcels.
              </h2>
              <p className="story-note">
                A plain-language view of the promises—and the trade-offs.
              </p>
            </div>
            <div className="story-prose">
              <p className="story-lede">
                Picture two people changing the same shared workspace from different devices. One is
                offline on a train; the other is connected at home. Each can keep changing local
                rows. When their devices can reach the mailbox again, they exchange encrypted
                changes and arrive at the same result without asking the mailbox to choose a winner.
              </p>
              <p>
                The mailbox is important, but deliberately unhelpful: it stores and returns
                protected artifacts without receiving the final key or interpreting the row data
                inside them. It can still see operational metadata—names, sizes, timing, request
                identity, and device identifiers—and it can still lose, withhold, or roll back what
                it stores.
              </p>
              <p>
                That is why local-first and encrypted do not mean consequence-free. Row work
                survives offline only when the app uses durable local storage; durable-file calls
                still need a connection. A lost key needs recovery prepared in advance, a copied key
                requires a new database and key for full revocation, and important data still needs
                tested backups.
              </p>
              <SpaLink className="text-link" href="QA.md">
                Read the simple questions and honest answers <span aria-hidden="true">→</span>
              </SpaLink>
            </div>
          </div>
        </section>

        <section id="model" className="site-section model-summary" aria-labelledby="model-title">
          <div className="shell narrow-layout">
            <div>
              <p className="site-kicker">Why local convergence matters</p>
              <h2 id="model-title">Independent work does not need a central editor.</h2>
            </div>
            <div>
              <p>
                Trusted devices can change local rows without first acquiring a server lock or
                waiting for a leader. Interocitor’s structured data model lets those devices
                converge after they exchange encrypted changes.
              </p>
              <aside className="section-takeaway">
                <span>Design consequence</span>
                <strong>The remote can remain a mailbox, not the central editor.</strong>
                <p>Application policy and trusted processing stay at the endpoints.</p>
              </aside>
              <SpaLink className="text-link" href="how-it-works.html">
                Follow a change through the complete sync loop <span aria-hidden="true">→</span>
              </SpaLink>
            </div>
          </div>
        </section>

        <section
          id="surfaces"
          className="site-section surfaces-summary"
          aria-labelledby="surfaces-title"
        >
          <div className="shell">
            <div className="section-intro compact-intro">
              <div>
                <p className="site-kicker">Two data surfaces</p>
                <h2 id="surfaces-title">
                  <span className="heading-highlight">Rows should converge.</span>
                  <span className="heading-highlight alternate">Files should stay exact.</span>
                </h2>
              </div>
              <p>
                Application state and file content need different promises. Treating them honestly
                avoids forcing large binary objects into a merge model or pretending remote files
                have the same offline behavior as local records.
              </p>
            </div>

            <div className="surface-cards">
              <article>
                <p className="card-type">Structured rows</p>
                <h3>Local working state that can converge</h3>
                <p>
                  Use rows for the facts an application reads, changes, and reconciles across
                  devices—titles, statuses, notes, relationships, and other structured state. Reads
                  and writes use the application’s local store, so the product can remain responsive
                  without a live remote.
                </p>
              </article>
              <article>
                <p className="card-type">Durable files</p>
                <h3>Exact remote objects for documents and media</h3>
                <p>
                  Use files when the bytes themselves must remain intact. They are encrypted before
                  storage, but they are not merged as records. File calls need the remote, which
                  makes their availability boundary explicit instead of hiding it.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section
          id="remotes"
          className="site-section remotes-summary"
          aria-labelledby="remotes-title"
        >
          <div className="shell narrow-layout">
            <div>
              <p className="site-kicker">Bring your own cloud</p>
              <h2 id="remotes-title">Put the mailbox where ownership makes sense.</h2>
            </div>
            <div>
              <p>
                Storage is part of a product’s trust, cost, portability, and recovery story. Some
                teams want an operated Cloudflare deployment. Some want data in a user-controlled
                Google Drive account. Others prefer WebDAV on infrastructure they already own.
              </p>
              <p>
                Interocitor keeps those choices behind the same storage role. Changing the operator
                does not require moving plaintext merge logic into that operator’s environment.
              </p>
              <ul className="remote-list" aria-label="Supported storage approaches">
                <li>
                  <strong>Cloudflare</strong>
                  <span>Operate a mailbox with D1 and R2.</span>
                </li>
                <li>
                  <strong>Google Drive</strong>
                  <span>Let a user connect their own storage.</span>
                </li>
                <li>
                  <strong>WebDAV</strong>
                  <span>Use a compatible server or home NAS.</span>
                </li>
                <li>
                  <strong>Custom adapter</strong>
                  <span>Fit an existing storage environment.</span>
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section
          id="security"
          className="site-section security-summary"
          aria-labelledby="security-title"
        >
          <div className="shell">
            <div className="section-intro">
              <div>
                <p className="site-kicker">The actual trust boundary</p>
                <h2 id="security-title">
                  Encryption narrows trust.
                  <span className="heading-highlight caution">It does not remove it.</span>
                </h2>
              </div>
              <div className="intro-copy">
                <p>
                  With a non-null key source, row payloads, snapshots, durable-file bodies, and
                  recovery-wrapper contents are encrypted before the remote adapter receives them.
                  <strong className="key-point">
                    The final decryption keys and usable plaintext remain at trusted endpoints.
                  </strong>
                </p>
                <p>
                  The remote still observes operational metadata such as object names, sizes,
                  timing, request identity, mesh identifiers, and device identifiers. It can also
                  withhold, delete, or roll back stored data. Interocitor protects payload
                  confidentiality and entry integrity; reliable storage and backups still protect
                  availability.
                </p>
              </div>
            </div>

            <div className="boundary-grid">
              <article className="boundary-card protected">
                <h3>Protected from the remote</h3>
                <ul>
                  <li>Row field names and values</li>
                  <li>Snapshot payloads</li>
                  <li>Durable-file contents</li>
                  <li>Recovery-wrapper contents</li>
                </ul>
              </article>
              <article className="boundary-card visible">
                <h3>Still visible to the remote</h3>
                <ul>
                  <li>Object names, paths, sizes, and timing</li>
                  <li>Mesh and device identifiers</li>
                  <li>Request and storage-account identity</li>
                  <li>Deletion, withholding, and rollback opportunities</li>
                </ul>
              </article>
            </div>

            <p className="security-route">
              See the{" "}
              <SpaLink href="how-it-works.html#boundary">illustrated trust boundary</SpaLink> for
              the path from trusted endpoints through remote storage.
            </p>
          </div>
        </section>

        <section id="decisions" className="decision-chooser" aria-labelledby="decisions-title">
          <div className="shell">
            <div className="decision-chooser-heading">
              <div>
                <p className="site-kicker">Choose the next decision</p>
                <h2 id="decisions-title">Turn the model into an architecture.</h2>
              </div>
              <p>
                Interocitor changes where plaintext, working state, availability, and processing
                live. Follow the question you control before reaching for package configuration.
              </p>
            </div>

            <nav className="decision-chooser-grid" aria-label="Architecture decision guides">
              <SpaLink className="decision-choice" href="trust.html">
                <span>01</span>
                <div>
                  <strong>Design a trusted mesh</strong>
                  <p>
                    Choose which endpoints may read plaintext and how keys, recovery, and compromise
                    are handled.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="data-boundaries.html">
                <span>02</span>
                <div>
                  <strong>Plan data scope and availability</strong>
                  <p>
                    Place data into convergent rows, directly remote files, and appropriately
                    bounded meshes.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="mailbox.html">
                <span>03</span>
                <div>
                  <strong>Choose and operate a mailbox</strong>
                  <p>
                    Assign access, metadata, quotas, retention, backup, and restoration to the right
                    owner.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="auth.html">
                <span>04</span>
                <div>
                  <strong>Choose access and identity</strong>
                  <p>
                    Keep ordinary authorization with the host, or adopt application-managed grants
                    when delegation truly requires them.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="automation.html">
                <span>05</span>
                <div>
                  <strong>Design trusted automation</strong>
                  <p>
                    Give workers and agents honest authority, isolation, coordination, and retry
                    semantics.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
            </nav>
          </div>
        </section>

        <section
          id="docs"
          className="site-section decision-section"
          aria-labelledby="decision-title"
        >
          <div className="shell">
            <div className="decision-heading">
              <p className="site-kicker">Before choosing the architecture</p>
              <h2 id="decision-title">Decide who holds trust, not only where bytes live.</h2>
              <p>
                A local-first encrypted mesh changes several product responsibilities. These are the
                questions worth answering before implementation details.
              </p>
            </div>

            <div className="question-grid">
              <article>
                <h3>Which endpoints may read everything?</h3>
                <p>
                  A client, worker, or AI agent with the mesh key is a trusted endpoint. It can
                  process the row database, so use separate databases and keys when work needs a
                  smaller trust boundary.
                </p>
              </article>
              <article>
                <h3>How will users recover a lost key?</h3>
                <p>
                  Recovery must be prepared before loss. Another trusted device or a previously
                  published recovery wrapper can restore access; without either, encrypted data is
                  unreadable.
                </p>
              </article>
              <article>
                <h3>What happens when a device is no longer trusted?</h3>
                <p>
                  Removing remote access does not erase a key that was already copied. Full
                  revocation requires a new mesh and key, which should be part of the product’s
                  incident plan.
                </p>
              </article>
              <article>
                <h3>Who protects availability?</h3>
                <p>
                  Encryption cannot recreate deleted objects. Important deployments still need
                  provider version history or an independent copy, plus a restore path that has been
                  tested.
                </p>
              </article>
            </div>

            <div className="next-step">
              <div>
                <h2>Ready for the mechanics?</h2>
                <p>
                  See how independent writes converge, what the remote stores, and how clients keep
                  history bounded.
                </p>
              </div>
              <SpaLink className="button primary" href="how-it-works.html">
                Open how it works <span aria-hidden="true">↗</span>
              </SpaLink>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-map-footer">
        <div className="shell site-map-footer-grid">
          <div className="site-map-brand">
            <SpaLink className="brand" href="index.html" aria-label="Interocitor home">
              <img className="brand-logo" src="/assets/hero-dark.svg" alt="Interocitor" />
            </SpaLink>
            <p>Local-first application data without remote plaintext.</p>
            <SpaLink className="footer-demo-link" href="examples/todomvc/">
              Try the live TodoMVC <span aria-hidden="true">↗</span>
            </SpaLink>
          </div>
          <nav className="site-map-nav" aria-label="Interocitor site map">
            <section>
              <h2>Explore</h2>
              <SpaLink href="index.html">Overview</SpaLink>
              <SpaLink href="how-it-works.html">How it works</SpaLink>
              <SpaLink href="examples/todomvc/">Live TodoMVC</SpaLink>
              <SpaLink href="examples/chat/">Live encrypted chat</SpaLink>
              <SpaLink href="examples/board/">Live shared board</SpaLink>
              <SpaLink href="examples/family-locator/">Protected family locator</SpaLink>
              <SpaLink href="https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/security-model.md">
                Security model
              </SpaLink>
            </section>
            <section>
              <h2>Architecture guides</h2>
              <SpaLink href="trust.html">Trust &amp; keys</SpaLink>
              <SpaLink href="data-boundaries.html">Rows, files &amp; scale</SpaLink>
              <SpaLink href="mailbox.html">Mailbox operations</SpaLink>
              <SpaLink href="auth.html">Access &amp; identity</SpaLink>
              <SpaLink href="automation.html">Trusted automation</SpaLink>
            </section>
            <section>
              <h2>Build</h2>
              <SpaLink href="https://github.com/Machine-Garden/interocitor/tree/main/packages/web#readme">
                Browser apps
              </SpaLink>
              <SpaLink href="https://github.com/Machine-Garden/interocitor/tree/main/packages/workers#readme">
                Cloudflare mailbox
              </SpaLink>
              <SpaLink href="https://github.com/Machine-Garden/interocitor/tree/main/examples">
                Examples
              </SpaLink>
              <SpaLink href="https://github.com/Machine-Garden/interocitor">
                Source on GitHub
              </SpaLink>
            </section>
          </nav>
        </div>
        <div className="shell site-map-bottom">
          <span>Interocitor · MIT licensed</span>
          <span>Trusted endpoints · protected mailbox</span>
        </div>
      </footer>
    </div>
  );
}
