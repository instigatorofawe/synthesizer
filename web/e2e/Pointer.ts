import type { Locator, Page } from '@playwright/test';

// Clicks at a computed point, which `page.mouse` neither scrolls to nor checks: a row out of sight, something covering it, or a
// page that moved since the point was measured, would send the click to something else, and the test would fail later and far
// from the cause ("Expected 67, Received 64", as flake 2 did). These make such a click fail where it is made, saying why.

export type Point = { x: number; y: number };

// The point in the roll's grid at `tick`, in the middle of `note`'s row, `inset` pixels into the tick. A row out of sight is
// scrolled into the roll's own view first (the page itself never scrolls), and the point is checked to be on the roll: its grid,
// or a note on it.
export async function rollPoint(page: Page, tick: number, note: number, inset = 3): Promise<Point> {
	const roll = page.getByTestId('roll');
	const key = page.getByTestId(`key-${note}`);
	await key.evaluate((row) => {
		let view = row.parentElement;
		while (view && !/(auto|scroll)/.test(getComputedStyle(view).overflowY)) view = view.parentElement;
		if (!view) return;
		const at = row.getBoundingClientRect();
		const seen = view.getBoundingClientRect();
		if (at.top < seen.top) view.scrollTop -= seen.top - at.top + at.height;
		else if (at.bottom > seen.bottom) view.scrollTop += at.bottom - seen.bottom + at.height;
	});
	const box = (await roll.boundingBox())!;
	const row = (await key.boundingBox())!;
	const at = { x: box.x + tick * Number(await roll.getAttribute('data-per-tick')) + inset, y: row.y + row.height / 2 };
	const covered = await roll.evaluate((grid, { x, y }) => {
		const there = document.elementFromPoint(x, y);
		return there && grid.contains(there) ? null : (there?.outerHTML.slice(0, 120) ?? 'nothing');
	}, at);
	if (covered !== null)
		throw new Error(`tick ${tick} of row ${note} isn't on the roll at (${at.x}, ${at.y}): ${covered}`);
	return at;
}

// Clicks, or double-clicks, at a measured point, and fails if `still` (the roll, unless said) moved as it did: what was under
// the pointer wasn't what the point was measured on.
export async function clickStill(page: Page, at: Point, options: { count?: 1 | 2; still?: Locator } = {}) {
	const still = options.still ?? page.getByTestId('roll');
	const before = (await still.boundingBox())!;
	if (options.count === 2) await page.mouse.dblclick(at.x, at.y);
	else await page.mouse.click(at.x, at.y);
	const after = (await still.boundingBox())!;
	if (before.x !== after.x || before.y !== after.y) {
		const what = await still.evaluate(
			(element) => element.getAttribute('data-testid') ?? element.tagName.toLowerCase()
		);
		throw new Error(
			`${what} moved by (${after.x - before.x}, ${after.y - before.y}) as (${at.x}, ${at.y}) was clicked: the click was measured on a page that has since changed`
		);
	}
}
