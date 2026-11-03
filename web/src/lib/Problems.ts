import { placeOfError } from '#lib/TimelineEdit.ts';

// What the compile light lists: what stops the song or the patch on screen from compiling or playing as written, and what
// compiles but may not sound as meant. Each says where it is in words, and goes there when it can.
export interface Problem {
	key: string;
	severity: 'error' | 'warning';
	place: string; // Where it is, in words: "Stereo lead › Filter 13", "Pluck › pluck-a", "Timeline JSON"
	message: string;
	testid?: string; // What the end-to-end tests know it by
	go?: () => void; // Shows where it is
}

// Where a compile error or warning is, from the `where` the compiler gives it.
// - `patch:lead/node:7` is a node. One inside a subpatch, `patch:lead/node:7/node:2`, is the subpatch's node, which is what
//   the graph shows.
// - `timeline:"song"/track:1/clip:lead-a` is a track and a clip, and `timeline:"song"/bus:fx` or `…/master` is the mix.
export type Place =
	| { kind: 'patch'; patch: string; node: number | null }
	| { kind: 'song'; track: number | null; clip: string | null; mix: boolean };

export function placeOf(where: string): Place | null {
	const patch = /^patch:([^/]+)(?:\/node:(\d+))?/.exec(where);
	if (patch) return { kind: 'patch', patch: patch[1], node: patch[2] === undefined ? null : Number(patch[2]) };
	if (!where.startsWith('timeline:')) return null;
	const { track, clip } = placeOfError(where);
	return { kind: 'song', track, clip, mix: track === null && clip === null && /\/(bus:|master)/.test(where) };
}

// What a place is called, so a problem reads "Stereo lead › Filter 13" rather than `patch:6e9f…/node:13`.
export interface Names {
	patch: (id: string) => string | undefined;
	node: (patch: string, node: number) => string | undefined;
	track: (id: number) => string | undefined;
}

export function placeWords(where: string, names: Names): string {
	const place = placeOf(where);
	if (!place) return where;
	if (place.kind === 'patch') {
		const patch = names.patch(place.patch) ?? place.patch;
		return place.node === null ? patch : `${patch} › ${names.node(place.patch, place.node) ?? `node ${place.node}`}`;
	}
	if (place.track !== null) {
		const track = names.track(place.track) || `Track ${place.track}`;
		return place.clip ? `${track} › ${place.clip}` : track;
	}
	if (place.clip) return `Clip ${place.clip}`;
	const bus = /\/bus:([^/]+)/.exec(where)?.[1];
	if (bus) return `Bus ${bus}`;
	return /\/master/.test(where) ? 'Master' : 'The song';
}

const counted = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

// The light at a glance: compiling, problems with a count, warnings with a count, or fine, which shows how big the image is.
export type LightState = 'compiling' | 'problems' | 'warnings' | 'fine' | 'idle';

export function lightOf(busy: boolean, problems: Problem[], size: string): { state: LightState; label: string } {
	const errors = problems.filter((problem) => problem.severity === 'error').length;
	const warnings = problems.length - errors;
	if (busy) return { state: 'compiling', label: 'Compiling…' };
	if (errors) return { state: 'problems', label: counted(errors, 'problem') };
	if (warnings) return { state: 'warnings', label: counted(warnings, 'warning') };
	return size ? { state: 'fine', label: size } : { state: 'idle', label: '' };
}

// The image's size as the light shows it.
export const sizeOf = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
