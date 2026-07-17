# Interocitor documentation site

This directory is the deployable Cloudflare Pages site for Interocitor.

Recommended Cloudflare Pages settings:

- Build command: none
- Build output directory: `docs`
- Framework preset: none / static

## Content boundary

The site is for adoption-level documentation:

- explain the use case;
- show the first recommended path;
- give the mental model;
- point readers to exact package and protocol docs.

The site should not become the API reference or protocol manual. Keep detailed
behavior in package READMEs, package-local docs, and JSDoc.

## Stable public anchors

Use these site anchors from public JSDoc with `@see`:

| Concept | URL |
| --- | --- |
| Product thesis | `https://interocitor.dev/#why` |
| Rows and files | `https://interocitor.dev/#surfaces` |
| Browser quickstart | `https://interocitor.dev/#start` |
| Relay backends | `https://interocitor.dev/#relays` |
| Security boundary | `https://interocitor.dev/#security` |
| Deep docs index | `https://interocitor.dev/#docs` |

If the production domain changes, update this table and public `@see` URLs in
the same change.

## Local preview

Any static file server works:

```bash
python3 -m http.server 4173 --directory docs
```

Open `http://127.0.0.1:4173/`.
