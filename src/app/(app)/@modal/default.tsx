/**
 * No dialog: the slot's content on a full page load. Soft navigation is covered by the null `page.tsx` next to
 * this at every app route that is not a dialog: a parallel slot keeps its last content when a soft navigation lands
 * on a URL it has no match for, so without them a link or redirect out of a dialog would leave the slot holding the
 * dialog, and opening the same dialog again was ignored (seen in `next dev`). A catch-all (`[...catchAll]`) would be
 * shorter, but Next 16's strict route matching then rejects the `(auth)` pages. `tests/shell.test.tsx` checks that
 * every `(app)` page has its entry here.
 */
export default function NoModal() {
  return null;
}
