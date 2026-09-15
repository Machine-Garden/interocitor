/**
 * The first file a crawler asks for, and therefore the site's own statement
 * about who may read it rather than whatever a default answers in its absence.
 *
 * Everything here is public documentation written to be read, so nothing is
 * disallowed — least of all the assistants and coding agents `/llms.txt` is
 * addressed to. Publishing an index for those readers while turning them away
 * at the door would be a contradiction, not a policy.
 */
export function GET(): Response {
  const body = [
    "# Public documentation. Readers that take Markdown should start at",
    "# /llms.txt, which indexes every page and the Markdown it is rendered from.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
  ];

  return new Response(body.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
