import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, History, type Undoable } from '#lib/History.ts';

// A document as the page holds one, with its edits going through a history as the page's go.
function document(history: History<string>, key: string, text: string) {
	const doc: { text: string; edit: (next: string, typing?: boolean) => void; buttons: Undoable } = {
		text,
		edit(next, typing = false) {
			history.record(key, doc.text, typing);
			doc.text = next;
		},
		buttons: history.of(key, { now: () => doc.text, apply: (snapshot) => (doc.text = snapshot) })
	};
	return doc;
}

describe('the undo history', () => {
	it('undoes and redoes edits in order', () => {
		const history = new History<string>();
		const doc = document(history, 'patch:a', 'one');
		expect(doc.buttons.canUndo).toBe(false);
		doc.edit('two');
		doc.edit('three');
		expect(doc.buttons.canUndo).toBe(true);
		expect(doc.buttons.canRedo).toBe(false);
		doc.buttons.undo();
		expect(doc.text).toBe('two');
		doc.buttons.undo();
		expect(doc.text).toBe('one');
		expect(doc.buttons.canUndo).toBe(false);
		doc.buttons.undo(); // Nothing left, so nothing changes
		expect(doc.text).toBe('one');
		doc.buttons.redo();
		doc.buttons.redo();
		expect(doc.text).toBe('three');
		expect(doc.buttons.canRedo).toBe(false);
	});

	it('drops what could be redone when a new edit comes after an undo', () => {
		const history = new History<string>();
		const doc = document(history, 'timeline:a', 'one');
		doc.edit('two');
		doc.edit('three');
		doc.buttons.undo();
		doc.edit('other');
		expect(doc.buttons.canRedo).toBe(false);
		doc.buttons.redo();
		expect(doc.text).toBe('other');
		doc.buttons.undo();
		doc.buttons.undo();
		expect(doc.text).toBe('one');
	});

	it('keeps a history for each document, whichever is open', () => {
		const history = new History<string>();
		const patch = document(history, 'patch:a', 'p0');
		const timeline = document(history, 'timeline:a', 't0');
		const other = document(history, 'patch:b', 'q0');
		patch.edit('p1');
		timeline.edit('t1');
		other.edit('q1');
		patch.edit('p2');
		timeline.buttons.undo();
		expect(timeline.text).toBe('t0');
		expect(patch.text).toBe('p2');
		patch.buttons.undo();
		patch.buttons.undo();
		expect(patch.text).toBe('p0');
		expect(other.text).toBe('q1');
		expect(other.buttons.canUndo).toBe(true);
		expect(history.canUndo('timeline:b')).toBe(false); // One it has never seen
	});

	it('takes a run of typing as one step, until it ends', () => {
		const history = new History<string>();
		const doc = document(history, 'patch:a', '{}');
		doc.edit('{ ', true);
		doc.edit('{ "', true);
		doc.edit('{ "a', true);
		history.end('patch:a');
		doc.edit('{ "a"', true); // Another visit to the field, and another step
		doc.buttons.undo();
		expect(doc.text).toBe('{ "a');
		doc.buttons.undo();
		expect(doc.text).toBe('{}');

		doc.edit('x', true);
		doc.edit('y'); // An edit made some other way is a step of its own, and ends the typing
		doc.edit('z', true);
		doc.buttons.undo();
		expect(doc.text).toBe('y');
		doc.buttons.undo();
		expect(doc.text).toBe('x');
	});

	it('ends a run of typing at an undo, so typing after it is a new step', () => {
		const history = new History<string>();
		const doc = document(history, 'patch:a', 'a');
		doc.edit('ab', true);
		doc.buttons.undo();
		doc.edit('ac', true);
		doc.edit('acd', true);
		doc.buttons.undo();
		expect(doc.text).toBe('a');
		expect(doc.buttons.canUndo).toBe(false);
	});

	it('forgets the oldest step past its limit', () => {
		const history = new History<string>();
		const doc = document(history, 'timeline:a', '0');
		for (let i = 1; i <= HISTORY_LIMIT + 50; i++) doc.edit(String(i));
		let undone = 0;
		while (doc.buttons.canUndo) {
			doc.buttons.undo();
			undone++;
		}
		expect(undone).toBe(HISTORY_LIMIT);
		expect(doc.text).toBe('50');
	});

	it('forgets a document that was deleted, and only that one', () => {
		const history = new History<string>();
		const kept = document(history, 'patch:a', 'a');
		const gone = document(history, 'patch:b', 'b');
		kept.edit('a1');
		gone.edit('b1', true);
		history.keep(new Set(['patch:a']));
		expect(kept.buttons.canUndo).toBe(true);
		expect(gone.buttons.canUndo).toBe(false);
		gone.edit('b2', true); // A run of typing went with it
		expect(gone.buttons.canUndo).toBe(true);
	});

	it('works from a key without a document bound to it', () => {
		const history = new History<string>(3);
		history.record('k', 'a');
		history.record('k', 'b');
		expect(history.undo('k', 'c')).toBe('b');
		expect(history.redo('k', 'b')).toBe('c');
		expect(history.redo('k', 'c')).toBeUndefined();
		history.record('k', 'c');
		history.record('k', 'd');
		expect([history.undo('k', 'e'), history.undo('k', 'd'), history.undo('k', 'c')]).toEqual(['d', 'c', 'b']);
		expect(history.undo('k', 'b')).toBeUndefined();
	});
});
