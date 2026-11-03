// Esc cancels a drag, as Design §19's gesture table has it, wherever focus is: a press often leaves it on the page rather than
// on what was pressed. While a drag is under way, the window's first look at a key goes to it, and Esc lets go of the drag
// and goes no further, so nothing else acts on the same press. The drag's own pointer-up then finds nothing to keep.
import { matches } from '#lib/Shortcuts.ts';

// Sends Esc to `cancel` until the returned function is called, which is when the drag ends.
export function escapeCancels(cancel: () => void): () => void {
	const listener = (event: KeyboardEvent) => {
		if (!matches(event, 'escape')) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		cancel();
	};
	window.addEventListener('keydown', listener, { capture: true });
	return () => window.removeEventListener('keydown', listener, { capture: true });
}

// A native range input has no Esc of its own, and the browser goes on dragging it whatever a page does. So, as an action on
// the input: Esc during a drag puts it back where the press found it, tells `restore`, which puts the sound back, and from
// then until the pointer is let go the input's own `input` and `change` go no further than the input, so its handlers
// never hear of the rest of the drag.
export function rangeEscape(input: HTMLInputElement, restoring: () => void) {
	let restore = restoring;
	let from: string | null = null; // Where the press found it, while a drag is under way
	let cancelled = false;
	let stop: (() => void) | null = null;

	const swallow = (event: Event) => {
		if (!cancelled || from === null) return;
		input.value = from;
		event.stopImmediatePropagation();
	};
	const end = () => {
		window.removeEventListener('pointerup', end, true);
		window.removeEventListener('pointercancel', end, true);
		stop?.();
		stop = null;
		// The release's `change` comes after the pointer is up, so it is still swallowed.
		setTimeout(() => {
			cancelled = false;
			from = null;
		});
	};
	const down = (event: PointerEvent) => {
		if (event.button !== 0 || input.disabled) return;
		from = input.value;
		cancelled = false;
		stop?.();
		stop = escapeCancels(() => {
			if (cancelled || from === null) return;
			cancelled = true;
			input.value = from;
			restore();
		});
		window.addEventListener('pointerup', end, true);
		window.addEventListener('pointercancel', end, true);
	};

	input.addEventListener('pointerdown', down);
	input.addEventListener('input', swallow, true);
	input.addEventListener('change', swallow, true);
	return {
		update(next: () => void) {
			restore = next;
		},
		destroy() {
			input.removeEventListener('pointerdown', down);
			input.removeEventListener('input', swallow, true);
			input.removeEventListener('change', swallow, true);
			window.removeEventListener('pointerup', end, true);
			window.removeEventListener('pointercancel', end, true);
			stop?.();
		}
	};
}
