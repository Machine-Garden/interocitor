import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="shell nav">
        <Link className="brand" href="/" aria-label="Interocitor home">
          <img className="brand-logo" src="/assets/hero-dark.svg" alt="Interocitor" />
        </Link>
        <nav className="nav-links" aria-label="Primary navigation">
          <Link href="/">Overview</Link>
          <Link href="/qa">Q&amp;A</Link>
          <a href="/examples/todomvc/">Live TodoMVC</a>
          <a href="https://github.com/Machine-Garden/interocitor">GitHub ↗</a>
        </nav>
        <Link className="nav-cta" href="/how-it-works">
          Docs <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </header>
  );
}
