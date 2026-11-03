// Undo and redo for every document on the page, a patch or a timeline, each with a history of its own that lasts while
// others are open. An entry is the whole document as it was, so any edit can be undone, one typed into its JSON included,
// with no inverse to write. A history lasts as long as the page does: saving keeps it, and only deleting the document
// forgets it.
import { SvelteMap } from 'svelte/reactivity';

// About as far back as anyone goes. Past it the oldest step is forgotten.
export const HISTORY_LIMIT = 200;

// And as much as one document's history holds, so a big song's 200 steps, each the whole song, don't hold 50 MB until the page
// closes. Past it the oldest steps are forgotten too, but never the last one. A string's size is two bytes a character.
export const HISTORY_BYTES = 20 * 1024 * 1024;
const sizeOf = (snapshot: unknown) => (typeof snapshot === 'string' ? snapshot.length * 2 : 0);

// What an Undo and a Redo button need, for one document.
export interface Undoable {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	undo(): void;
	redo(): void;
}

type Stacks<T> = { past: readonly T[]; future: readonly T[] };

export class History<T> {
	// Replaced whole on each change, so a button reading one document's hears about that document's changes only.
	readonly #stacks = new SvelteMap<string, Stacks<T>>();
	readonly #typing = new Set<string>(); // Documents whose last step is still being typed
	readonly #limit: number;
	readonly #bytes: number;

	constructor(limit = HISTORY_LIMIT, bytes = HISTORY_BYTES) {
		this.#limit = limit;
		this.#bytes = bytes;
	}

	// An edit to the document `key`, which was `before` until now. It drops what could have been redone. An edit that is
	// `typing`, a keystroke in a JSON field, joins the step being typed, so a run of them undoes in one go until `end`.
	record(key: string, before: T, typing = false): void {
		if (typing && this.#typing.has(key)) return;
		const past = [...(this.#stacks.get(key)?.past ?? []), before].slice(-this.#limit);
		let held = past.reduce((sum, step) => sum + sizeOf(step), 0);
		while (past.length > 1 && held > this.#bytes) held -= sizeOf(past.shift());
		this.#stacks.set(key, { past, future: [] });
		if (typing) this.#typing.add(key);
		else this.#typing.delete(key);
	}

	// The step being typed is done, and the next keystroke starts another.
	end(key: string): void {
		this.#typing.delete(key);
	}

	// What the document goes back to from `now`, or undefined if there is nothing to undo.
	undo(key: string, now: T): T | undefined {
		this.#typing.delete(key);
		const stacks = this.#stacks.get(key);
		if (!stacks?.past.length) return undefined;
		this.#stacks.set(key, { past: stacks.past.slice(0, -1), future: [...stacks.future, now] });
		return stacks.past[stacks.past.length - 1];
	}

	// What the document goes forward to from `now`, or undefined if there is nothing to redo.
	redo(key: string, now: T): T | undefined {
		this.#typing.delete(key);
		const stacks = this.#stacks.get(key);
		if (!stacks?.future.length) return undefined;
		this.#stacks.set(key, { past: [...stacks.past, now], future: stacks.future.slice(0, -1) });
		return stacks.future[stacks.future.length - 1];
	}

	canUndo(key: string): boolean {
		return (this.#stacks.get(key)?.past.length ?? 0) > 0;
	}

	canRedo(key: string): boolean {
		return (this.#stacks.get(key)?.future.length ?? 0) > 0;
	}

	// Forgets every document but these, as one that was deleted goes. A new one with the same id starts with nothing to undo.
	keep(keys: ReadonlySet<string>): void {
		for (const key of [...this.#stacks.keys()]) {
			if (keys.has(key)) continue;
			this.#stacks.delete(key);
			this.#typing.delete(key);
		}
	}

	// One document's Undo and Redo: `now` is what it holds, and `apply` puts a step back without recording it as an edit.
	of(key: string, document: { now: () => T; apply: (snapshot: T) => void }): Undoable {
		const can = { undo: () => this.canUndo(key), redo: () => this.canRedo(key) };
		const step = (snapshot: T | undefined) => {
			if (snapshot !== undefined) document.apply(snapshot);
		};
		return {
			get canUndo() {
				return can.undo();
			},
			get canRedo() {
				return can.redo();
			},
			undo: () => step(this.undo(key, document.now())),
			redo: () => step(this.redo(key, document.now()))
		};
	}
}
