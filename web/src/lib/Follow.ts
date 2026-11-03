// A view that follows the playhead while a song plays: when the playhead moves out of sight, the view jumps to put it near
// its left edge, as a DAW turns a page. A view someone has scrolled away from is left where they put it, until they bring
// the playhead back into it.

// How far in from the left edge a turned page puts the playhead, at most.
export const FOLLOW_MARGIN = 32;

// Where to scroll a view to, or null to leave it. `at` is the playhead's x in the scrolled content, `before` where it was
// last time, or null if the song has only just started, and `scroll` and `width` the part of the content in sight.
export function followScroll(at: number, before: number | null, scroll: number, width: number): number | null {
	const seen = (x: number) => x >= scroll && x <= scroll + width;
	if (width <= 0 || seen(at)) return null;
	if (before !== null && !seen(before)) return null;
	return Math.max(0, at - Math.min(FOLLOW_MARGIN, width / 4));
}
