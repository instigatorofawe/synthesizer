// A drum track's kit (Schema.ts): which of its slots each key plays, and what the key is called. The compiler ignores it and
// plays each note's own slot, so the editor keeps the two in step: every note of a clip on a kit track plays its key's slot.
// One function does that, `withKitSlots`, over the whole document, and it is applied where a document changes: to each edit
// the Song view makes (TimelineEditor.svelte's `commit`), and to each note a take writes (Recording.ts). So drawing, step
// entry, a paste, a move, a transpose, quantize, Split, a placement moved onto a kit track and a kit changed all come out right
// without any of them knowing about kits. What is typed into the song's JSON is the document as typed, until the next edit.
//
// A note on a key the kit has no sound for keeps whatever slot it had, and the roll greys it.
//
// A clip is one list of notes wherever it is placed, so it can only play one kit's slots. It takes them from the first track,
// in the song's order, that places it and has a kit: placed on two kit tracks it plays the first one's slots on both, and on a
// kit track and an ordinary one, the kit's on both, since the ordinary track has no say. A placement's transpose moves the
// pitch each sound hears, not which sound plays: a kit reads a note's key as the clip writes it, which is the row the roll
// draws it on.
import { standardKit } from '#lib/GeneralMidi.ts';
import type { Timeline } from '#lib/Schema.ts';
import { setTrack, type Clip, type Track } from '#lib/TimelineEdit.ts';
import { noteName } from '#lib/Units.ts';

export type Kit = NonNullable<Track['kit']>;
export type KitKey = Kit[number];

// The slot a live note on `note` plays in, on a kit track, as its image numbers slots: `slots` is the track's compile report's
// (Request.ts), since an image holds only the slots notes play, and an image that holds them all (a `live` one) needs none.
// Undefined when the key has no sound, so the note plays the track's own slot, and null when the image doesn't hold the
// sound yet, because no note plays it: then it is better not heard than heard as another drum.
export function liveSlot(
	kit: Kit | null | undefined,
	slots: number[] | undefined,
	note: number
): number | null | undefined {
	const key = kit?.find((k) => k.note === note);
	if (!key) return undefined;
	if (!slots) return key.slot;
	const at = slots.indexOf(key.slot);
	return at < 0 ? null : at;
}

// A kit by key, for looking keys up in.
export const kitKeys = (kit: Kit): Map<number, KitKey> => new Map(kit.map((key) => [key.note, key]));

// The track whose kit a clip's notes take their slots from, and the kit, or null for a clip on no kit track.
export function clipKit(doc: Pick<Timeline, 'tracks'>, clip: string): { track: Track; kit: Kit } | null {
	const track = doc.tracks.find((t) => t.kit && t.placements.some((p) => p.clip === clip));
	return track?.kit ? { track, kit: track.kit } : null;
}

// The other tracks that place a clip and play its notes on slots their own kit doesn't choose: tracks without a kit, and kit
// tracks whose kit is another. What the inspector says, since what those tracks play is the first kit's choice.
export function kitStrangers(doc: Pick<Timeline, 'tracks'>, clip: string): Track[] {
	const from = clipKit(doc, clip);
	if (!from) return [];
	const same = JSON.stringify(from.kit);
	return doc.tracks.filter(
		(t) => t !== from.track && t.placements.some((p) => p.clip === clip) && JSON.stringify(t.kit) !== same
	);
}

// A clip's notes each given the slot its key plays, by `slots` from key to slot. A note already on it stays the note it was,
// and one whose key has no sound keeps its slot, so a clip with nothing to change comes back as it was. A note with no slot
// plays slot 0, so one on a key whose slot is 0 has nothing to change either.
export function slotNotes(clip: Clip, slots: ReadonlyMap<number, number>): Clip {
	let changed = false;
	const notes = clip.notes.map((note) => {
		const slot = slots.get(note.note);
		if (slot === undefined || (note.slot ?? 0) === slot) return note;
		changed = true;
		return { ...note, slot };
	});
	return changed ? { ...clip, notes } : clip;
}

// Every note on a kit track playing its key's slot. A document with nothing to change comes back as it was, so an edit that
// changed nothing still changes nothing.
export function withKitSlots(doc: Timeline): Timeline {
	const kits = new Map<string, Map<number, number>>(); // Each clip on a kit track, and its kit's slot for each key
	for (const track of doc.tracks) {
		if (!track.kit) continue;
		const slots = new Map(track.kit.map((key) => [key.note, key.slot]));
		for (const placed of track.placements) if (!kits.has(placed.clip)) kits.set(placed.clip, slots);
	}
	if (!kits.size) return doc;
	let changed = false;
	const clips = doc.clips.map((clip) => {
		const slots = kits.get(clip.id);
		const next = slots ? slotNotes(clip, slots) : clip;
		if (next !== clip) changed = true;
		return next;
	});
	return changed ? { ...doc, clips } : doc;
}

// How many sounds a kit plays, which is how many slots its keys reach between them.
export const kitSounds = (kit: Kit) => new Set(kit.map((key) => key.slot)).size;

// What a kit's size is called: "20 sounds", and "1 sound".
export const soundsText = (kit: Kit) => `${kitSounds(kit)} sound${kitSounds(kit) === 1 ? '' : 's'}`;

// A key as a kit names it, "36 Bass Drum 1", or for a key it has no sound for, "50, no sound".
export const keyText = (keys: ReadonlyMap<number, KitKey>, note: number) => {
	const key = keys.get(note);
	return key ? `${note} ${key.name}` : `${note}, no sound`;
};

// What a note is called where the roll describes it: by the kit on a kit track, and by its pitch elsewhere.
export const noteText = (keys: ReadonlyMap<number, KitKey> | null, note: number) =>
	keys ? keyText(keys, note) : noteName(note);

// The standard set's kit, as Use the standard kit gives it to a track: a slot for each of the set's drums, and every GM
// percussion key it has a sound for, by GM's name. Empty while the set has no drums.
export const STANDARD_KIT: { slots: string[]; kit: Kit } = standardKit();

// Whether a track plays a kit already, slots and all.
export const playsKit = (track: Track, kit: { slots: string[]; kit: Kit }) =>
	JSON.stringify(track.slots) === JSON.stringify(kit.slots) &&
	JSON.stringify(track.kit ?? null) === JSON.stringify(kit.kit);

// Why Use the standard kit has nothing to do for a track, or '' if it has.
export function standardKitWhy(track: Track, standard = STANDARD_KIT): string {
	if (!standard.slots.length) return 'The standard set has no drums yet, so there is no standard kit to use.';
	return playsKit(track, standard) ? 'It plays the standard kit already.' : '';
}

// The voices a kit track has at least. A cymbal or a ride rings for 9 to 14 s, and holds its voice all that time, so a groove
// with a few of them needs room, and a voice taken from one fades rather than clicks.
export const KIT_VOICES = 32;

// A track made a kit: these slots and this kit, as Use the standard kit gives it from the standard set (GeneralMidi.ts), and
// its notes on the kit's sounds, with voices enough for its cymbals' tails, and a stolen one faded out. The slots it had go,
// so a note on a key the kit has no sound for keeps a slot that is now another patch's, or one the track lacks, which the
// compiler says.
export function useKit(doc: Timeline, id: number, standard: { slots: string[]; kit: Kit }): Timeline {
	const track = doc.tracks.find((t) => t.id === id);
	if (!track) return doc;
	return withKitSlots(
		setTrack(doc, id, {
			slots: [...standard.slots],
			kit: standard.kit.map((key) => ({ ...key })),
			voices: Math.max(track.voices, KIT_VOICES),
			steal: 'fade'
		})
	);
}

// A track that isn't a kit any more. Its slots and its notes' slots stay as they are, so it plays as it did, and from now on a
// note moved to another key keeps its slot, as on any other track.
export function dropKit(doc: Timeline, id: number): Timeline {
	return {
		...doc,
		tracks: doc.tracks.map((track) => {
			if (track.id !== id || !track.kit) return track;
			const { kit: _, ...rest } = track;
			return rest;
		})
	};
}
