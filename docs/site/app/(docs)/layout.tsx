import { DocsSidebar } from "@/components/docs-sidebar";
import { pages } from "@/lib/content";

export default function DocsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="docs-page">
      <div className="docs-workspace">
        <DocsSidebar pages={pages} />
        <div className="docs-column">{children}</div>
      </div>

      <footer className="docs-footer">
        <p>
          interocitor by <a href="http://machine-garden.com/">machine-garden</a>
        </p>
      </footer>
    </div>
  );
}
