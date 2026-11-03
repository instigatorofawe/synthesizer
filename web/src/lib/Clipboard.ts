// What Mod+C last copied, kept in the page and nowhere else, so the system's clipboard is left alone: notes from the roll, a
// placement with its clip from the arrangement, and nodes from a graph, each apart, so copying one doesn't lose the others. It
// lasts as long as the page does, so a copy outlasts opening another clip, timeline or patch. The notes and the placement also
// remember where they were last pasted, which is where the next paste goes after (`pasteAt`).
import type { CopiedNodes } from '#lib/GraphEdit.ts';
import type { CopiedPlacement, Note } from '#lib/TimelineEdit.ts';

export interface Copied<Where, What> {
	what: What;
	from: Where; // The clip, or the track, it was copied from
	at: number; // Where it starts there
	span: number; // How long it lasts
	pasted: { to: Where; at: number } | null;
}

export const clipboard: {
	notes: Copied<string, Note[]> | null; // By clip
	placement: Copied<number, CopiedPlacement> | null; // By track
	nodes: CopiedNodes | null; // From a patch, for any patch, that one included
} = { notes: null, placement: null, nodes: null };
