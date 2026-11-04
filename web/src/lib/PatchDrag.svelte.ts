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

// What a drag over the page brings: a patch from the browser, files from the desktop, or nothing a target here takes. Until a
// drop, a page sees the kind of each file and not its name, so MIDI files are told apart from the rest only where the
// system says what they are, and the drop looks again at their names.
export type Bringing = { kind: 'patch'; patch: DraggedPatch } | { kind: 'files' } | { kind: 'midi' } | null;

const MIDI_TYPES = ['audio/midi', 'audio/mid', 'audio/x-midi', 'audio/x-mid'];
const isMidi = (file: File) => /\.midi?$/i.test(file.name) || MIDI_TYPES.includes(file.type);

export function bringing(event: DragEvent): Bringing {
	if (patchDrag.patch) return { kind: 'patch', patch: patchDrag.patch };
	const transfer = event.dataTransfer;
	if (!transfer?.types.includes('Files')) return null;
	const files = [...transfer.items].filter((item) => item.kind === 'file');
	return files.length && files.every((item) => MIDI_TYPES.includes(item.type)) ? { kind: 'midi' } : { kind: 'files' };
}

// The WAV files a drop brought, which an import takes. Anything else dropped with them is left out.
export const wavFiles = (event: DragEvent) =>
	[...(event.dataTransfer?.files ?? [])].filter((file) => /\.wav$/i.test(file.name) || file.type === 'audio/wav');

// The MIDI files a drop brought, each of which a MIDI import makes a song of.
export const midiFiles = (event: DragEvent) => [...(event.dataTransfer?.files ?? [])].filter(isMidi);
