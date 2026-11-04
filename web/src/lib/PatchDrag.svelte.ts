// A patch dragged out of the browser, for the arrangement and the Mixer to take, and WAV files dragged in from the desktop. What
// a drag carries can't be read until it is dropped, and browsers differ in which kinds of data they let a page put in one, so
// the patch is kept here for as long as its drag lasts, as the clipboard keeps a copy. The drag itself carries the patch's
// link, which is what it means anywhere else, such as another tab.
export interface DraggedPatch {
	id: string;
	name: string;
	insert: boolean; // An effect, which goes on a chain's inserts rather than playing a track's notes
}

export const patchDrag = $state<{ patch: DraggedPatch | null }>({ patch: null });

export function startPatchDrag(event: DragEvent, patch: DraggedPatch) {
	patchDrag.patch = patch;
	if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyLink';
}

export function endPatchDrag() {
	patchDrag.patch = null;
}

// What a drag over the page brings: a patch from the browser, WAV files from the desktop, or nothing a target here takes.
export type Bringing = { kind: 'patch'; patch: DraggedPatch } | { kind: 'files' } | null;

export function bringing(event: DragEvent): Bringing {
	if (patchDrag.patch) return { kind: 'patch', patch: patchDrag.patch };
	return event.dataTransfer?.types.includes('Files') ? { kind: 'files' } : null;
}

// The WAV files a drop brought, which an import takes. Anything else dropped with them is left out.
export const wavFiles = (event: DragEvent) =>
	[...(event.dataTransfer?.files ?? [])].filter((file) => /\.wav$/i.test(file.name) || file.type === 'audio/wav');
