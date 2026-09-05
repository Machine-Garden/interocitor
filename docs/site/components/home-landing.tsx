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
            <SpaLink href="#decisions">Choose a path</SpaLink>
            <SpaLink href="#security">Security model</SpaLink>
          </nav>
          <SpaLink className="nav-cta" href="how-it-works.html">
            Docs <span aria-hidden="true">↗</span>
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
                Interocitor keeps useful rows on trusted devices, exchanges changes when the network
                returns, and encrypts private contents before the remote mailbox receives them.
              </p>
              <div className="actions">
                <SpaLink className="button primary demo-button" href="examples/todomvc/">
                  Try live TodoMVC <span aria-hidden="true">↗</span>
                </SpaLink>
                <SpaLink className="button secondary" href="how-it-works.html">
                  Open how it works
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
                Many apps stop when the server disappears. Interocitor lets trusted devices keep
                working with local rows, then use the network to exchange changes when it returns.
              </p>
            </div>
          </div>

          <div className="shell responsibility-map">
            <p>Who does what?</p>
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
                <dd>Runs storage without reading private contents.</dd>
              </div>
            </dl>
          </div>

          <div className="shell reason-grid">
            <article>
              <h3>Keep working without a round trip</h3>
              <p>
                A device in the field or on a train can keep reading and changing local rows. The
                network is how work travels, not permission to begin.
              </p>
            </article>
            <article>
              <h3>Store data without sharing the contents</h3>
              <p>
                The mailbox can keep encrypted artifacts without holding the key that opens them. A
                stolen mailbox reveals far less than a plain application database.
              </p>
            </article>
            <article>
              <h3>Put the mailbox where it belongs</h3>
              <p>
                Use Cloudflare, Google Drive, WebDAV, a home NAS, or another remote backend. Choose
                one whose ownership and failure modes your product can explain.
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
                Watch local rows converge, files cross the blind mailbox, and trusted agents join
                the workflow.
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
                    Use two familiar TodoMVC clients side by side. Make a change, cut the network,
                    reconnect, and watch the other side catch up.
                  </p>
                  <div className="example-outcome">
                    <strong>Watch two local copies converge.</strong>
                    <span>
                      Change either client and watch local work travel when the network returns.
                      Everything resets when the page reloads.
                    </span>
                    <SpaLink href="examples/todomvc/">
                      Try the live TodoMVC <span aria-hidden="true">→</span>
                    </SpaLink>
                  </div>
                </div>

                <div className="code-window" aria-label="A TodoMVC change crossing the mailbox">
                  <div className="code-window-bar">
                    <span aria-hidden="true">
                      <i></i>
                      <i></i>
                      <i></i>
                    </span>
                    <b>one page · two clients</b>
                  </div>
                  <div className="demo-journey">
                    <span>Aya changes a task offline</span>
                    <b aria-hidden="true">↓</b>
                    <span>The network returns</span>
                    <b aria-hidden="true">↓</b>
                    <span>Bo sees the same task</span>
                  </div>
                </div>
              </article>

              <article className="task-example chat-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>02</span> End-to-end encrypted chat
                  </p>
                  <h3>Two clients. One mailbox that cannot read the conversation.</h3>
                  <p>
                    Alice and Bob share a key and exchange message rows through an inspectable
                    in-page mailbox. The mailbox never receives their readable conversation.
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
                    <strong>encrypted artifact</strong>
                    <small>no key to open it</small>
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
                  <h3>Encrypted location data does not make a safety product.</h3>
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
                    Let storage retain and deliver files without giving it the document contents.
                    One trusted device encrypts the bytes; another trusted device decrypts them.
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

                <p className="example-limit">
                  File transfers need a network. Their paths, sizes, and timing can still be visible
                  to the remote.
                </p>
              </article>

              <article className="task-example agent-example">
                <div className="task-example-copy">
                  <p className="example-label">
                    <span>06</span> Agent workflow
                  </p>
                  <h3>Share task state without exposing it to storage.</h3>
                  <p>
                    A product leaves a task row. A trusted agent reads it, does the work, and
                    returns a result. If pressing the outside-world button twice would hurt, the
                    product must add a rule that makes only one press count.
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
                    <small>Stores encrypted artifacts</small>
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
                    The agent holds a key and sees plaintext. Give a powerful agent the narrowest
                    mesh that fits its work.
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
                The useful copy stays local. The remote carries encrypted changes.
              </h2>
              <p className="story-note">
                Rows keep working offline; file bytes still require network access.
              </p>
            </div>
            <div className="story-prose">
              <p className="story-lede">
                Consider two people changing the same shared workspace from different devices. One
                is offline on a train; the other is connected at home. Each can keep changing local
                rows. When their devices can reach the mailbox again, they exchange encrypted
                changes and arrive at the same result without asking the mailbox to choose a winner.
              </p>
              <p>
                The mailbox is important, but deliberately unhelpful: it stores and returns
                encrypted artifacts without receiving the key or understanding the rows inside. It
                still sees metadata such as paths, sizes, and timing, and it can still lose or hide
                what it stores.
              </p>
              <p>
                Local-first and encrypted are strong promises with explicit limits. Files still need
                network access. A lost key needs recovery prepared earlier. A copied key means
                moving to a new mesh, and important data still needs a tested backup.
              </p>
              <SpaLink className="text-link" href="QA.md">
                Read common questions and direct answers <span aria-hidden="true">→</span>
              </SpaLink>
            </div>
          </div>
        </section>

        <section id="model" className="site-section model-summary" aria-labelledby="model-title">
          <div className="shell narrow-layout">
            <div>
              <p className="site-kicker">Why convergence matters</p>
              <h2 id="model-title">Independent work does not need a central editor.</h2>
            </div>
            <div>
              <p>
                Trusted devices can change local rows without waiting for a leader. After they
                exchange encrypted change artifacts, the same merge rules lead them to the same
                result.
              </p>
              <aside className="section-takeaway">
                <span>Design consequence</span>
                <strong>The remote can remain a mailbox, not the central editor.</strong>
                <p>The devices keep the key and do the meaningful work.</p>
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
                Working facts and heavy files need different promises. Keeping them honest stops a
                phone carrying every video and stops the app pretending remote files are offline.
              </p>
            </div>

            <div className="surface-cards">
              <article>
                <p className="card-type">Structured rows</p>
                <h3>Local working state that can converge</h3>
                <p>
                  Use rows for titles, statuses, notes, and other facts people keep changing. They
                  live on the device first, so work can continue without a live remote.
                </p>
              </article>
              <article>
                <p className="card-type">Durable files</p>
                <h3>Exact remote objects for documents and media</h3>
                <p>
                  Use files for PDFs, photos, audio, video, and any result produced once. A row
                  points at one by content, so the bytes are fetched when a screen needs them and
                  cached safely, but they do not merge like rows.
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
                Storage is part of a product’s trust, cost, and recovery story. Start with the
                smallest home every endpoint can reach, then add infrastructure only when the
                application needs it.
              </p>
              <p>
                Each can play the same mailbox role without becoming the place that reads rows and
                decides what they mean.
              </p>
              <ul className="remote-list" aria-label="Supported storage approaches">
                <li>
                  <strong>Local NAS</strong>
                  <span>Keep one household or office mailbox on its own network.</span>
                </li>
                <li>
                  <strong>Private WebDAV</strong>
                  <span>Operate a reachable server without giving it plaintext.</span>
                </li>
                <li>
                  <strong>Family Google Drive</strong>
                  <span>Let one clearly owned Drive account carry the mailbox.</span>
                </li>
                <li>
                  <strong>Cloudflare Free</strong>
                  <span>Run a small protocol-aware mailbox within current allowances.</span>
                </li>
                <li>
                  <strong>Advanced Cloudflare</strong>
                  <span>Add application policy, operations, realtime, and R2 or S3 bodies.</span>
                </li>
              </ul>
              <SpaLink className="text-link" href="storage.html">
                See how Interocitor stores data <span aria-hidden="true">→</span>
              </SpaLink>
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
                <p className="site-kicker">Security boundary</p>
                <h2 id="security-title">
                  The mailbox stays blind.
                  <span className="heading-highlight caution">The key holders do not.</span>
                </h2>
              </div>
              <div className="intro-copy">
                <p>
                  Protected rows, snapshots, and files are encrypted before the remote receives
                  them.
                  <strong className="key-point">
                    Trusted devices keep the keys and readable contents.
                  </strong>
                </p>
                <p>
                  The mailbox still sees metadata such as paths, sizes, timing, and device activity.
                  It can also hide, delete, or replay an older protected object. Good storage and
                  tested backups still matter.
                </p>
              </div>
            </div>

            <div className="boundary-grid">
              <article className="boundary-card protected">
                <h3>Protected from the remote</h3>
                <ul>
                  <li>Private row contents</li>
                  <li>Fresh-start snapshots</li>
                  <li>Ordinary file contents</li>
                </ul>
              </article>
              <article className="boundary-card visible">
                <h3>Still visible to the remote</h3>
                <ul>
                  <li>Paths, sizes, and timing</li>
                  <li>Mesh and device activity</li>
                  <li>The power to lose, hide, or replay objects</li>
                </ul>
              </article>
            </div>

            <p className="security-route">
              Read <SpaLink href="security.html">the complete security model</SpaLink>.
            </p>
          </div>
        </section>

        <section id="decisions" className="decision-chooser" aria-labelledby="decisions-title">
          <div className="shell">
            <div className="decision-chooser-heading">
              <div>
                <p className="site-kicker">Choose the next guide</p>
                <h2 id="decisions-title">Plan the system boundaries.</h2>
              </div>
              <p>Start with the product decision you need to make.</p>
            </div>

            <nav className="decision-chooser-grid" aria-label="Planning guides">
              <SpaLink className="decision-choice" href="trust.html">
                <span>01</span>
                <div>
                  <strong>Who receives the key?</strong>
                  <p>Draw the trusted circle and prepare for loss or theft.</p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="data-boundaries.html">
                <span>02</span>
                <div>
                  <strong>What travels as rows or files?</strong>
                  <p>Classify local rows, remote files, and separate mesh boundaries.</p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="mailbox.html">
                <span>03</span>
                <div>
                  <strong>Who keeps the mailbox?</strong>
                  <p>Choose the backend, its operational owner, and its recovery plan.</p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="auth.html">
                <span>04</span>
                <div>
                  <strong>How does authentication fit?</strong>
                  <p>
                    Interocitor manages encrypted data; your identity provider controls access.
                    Aliases and clear 4xx events connect the two.
                  </p>
                </div>
                <span aria-hidden="true">↗</span>
              </SpaLink>
              <SpaLink className="decision-choice" href="automation.html">
                <span>05</span>
                <div>
                  <strong>Should an agent join the mesh?</strong>
                  <p>Treat it as a trusted endpoint and coordinate external effects separately.</p>
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
              <p className="site-kicker">Before using real data</p>
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
              <SpaLink href="storage.html">Storage model</SpaLink>
              <SpaLink href="flows.html">Core flows</SpaLink>
              <SpaLink href="security.html">Security model</SpaLink>
              <SpaLink href="compaction.html">Compaction</SpaLink>
              <SpaLink href="tainted-files.html">Tainted files</SpaLink>
              <SpaLink href="examples/todomvc/">Live TodoMVC</SpaLink>
              <SpaLink href="examples/chat/">Live encrypted chat</SpaLink>
              <SpaLink href="examples/board/">Live shared board</SpaLink>
              <SpaLink href="examples/family-locator/">Protected family locator</SpaLink>
            </section>
            <section>
              <h2>Plan your app</h2>
              <SpaLink href="trust.html">Trust &amp; key custody</SpaLink>
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
