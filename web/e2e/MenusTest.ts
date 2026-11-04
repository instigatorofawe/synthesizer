import { expect, test, type Locator, type Page } from './Fixtures.ts';
import { openView } from './Views.ts';

// A right-click opens a menu on everything that is edited by pointing, so it never does nothing: in a song, and in an example
// or a built-in patch, where what would change it is greyed out and the menu says why.
test.use({ viewport: { width: 1440, height: 900 } });

const menu = (page: Page) => page.getByTestId('context-menu');

// A right-click there opens a menu named so, which Esc closes again.
async function opens(page: Page, at: Locator, name: string | RegExp, position?: { x: number; y: number }) {
	await at.click({ button: 'right', position });
	await expect(menu(page)).toBeVisible();
	await expect(menu(page)).toHaveAccessibleName(name);
	return menu(page);
}

async function closes(page: Page) {
	await page.keyboard.press('Escape');
	await expect(menu(page)).toHaveCount(0);
}

test('a right-click opens a menu on every part of a song that is edited by pointing', async ({ page }) => {
	await page.goto('/?timeline=song');
	const playhead = page.getByTestId('playhead');
	const before = await playhead.getAttribute('x1');

	// The ruler's doesn't move the playhead as a click does, until it is asked to.
	const ruler = await opens(page, page.getByTestId('ruler'), 'Ruler', { x: 300, y: 10 });
	expect(await playhead.getAttribute('x1')).toBe(before);
	await ruler.getByRole('menuitem', { name: 'Move the playhead here' }).click();
	await expect(playhead).not.toHaveAttribute('x1', before ?? '');

	const loop = await opens(page, page.getByTestId('loop-strip'), 'Loop', { x: 300, y: 5 });
	await loop.getByRole('menuitem', { name: 'Loop this bar' }).click();
	await expect(page.getByTestId('loop-brace')).toHaveAttribute('data-on', 'true');

	// The Tempo lane, folded and then open, where a change can be added at the pointer.
	const folded = await opens(page, page.getByTestId('tempo-lane'), 'Tempo lane', { x: 300, y: 8 });
	await folded.getByRole('menuitem', { name: 'Unfold the Tempo lane' }).click();
	await expect(page.getByTestId('tempo-lane')).toHaveAttribute('data-open', 'true');
	const lane = await opens(page, page.getByTestId('tempo-lane'), 'Tempo lane', { x: 400, y: 30 });
	await lane.getByRole('menuitem', { name: 'Add a tempo change here' }).click();
	await expect(page.getByTestId('tempo-point-1')).toBeVisible();

	await opens(page, page.getByTestId('track-1'), 'Track Lead');
	await closes(page);
	const clip = await opens(page, page.getByTestId('placement-1-0').locator('rect.body'), /^Clip /);
	await expect(clip.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
	await closes(page);

	// The roll's ruler, a key, and the velocity lane are the roll's too. A key's chooses every note of it.
	await opens(page, page.getByTestId('roll-ruler'), 'Piano roll', { x: 200, y: 8 });
	await closes(page);
	const pitch = await page.getByTestId('note-0').getAttribute('data-note');
	const key = await opens(page, page.getByTestId(`key-${pitch}`), 'Piano roll');
	await key.getByRole('menuitem', { name: /^Choose every / }).click();
	await expect(page.getByTestId('note-0')).toHaveClass(/chosen/);
	await opens(page, page.getByTestId('velocity'), /notes?$|Piano roll/, { x: 5, y: 5 });
	await closes(page);

	// An automation lane, where no point is: a point added there, or the lane taken away.
	const automation = await opens(page, page.getByTestId('lane-0'), /^Lane /, { x: 260, y: 10 });
	await expect(automation.getByRole('menuitem', { name: 'Add a point here' })).toBeEnabled();
	await expect(automation.getByRole('menuitem', { name: 'Remove this lane' })).toBeEnabled();
	await closes(page);
});

test('in an example every menu opens too, with what would change it greyed out and why', async ({ page }) => {
	await page.goto('/?recipe=HallOfTheMountainKing');
	const why = /An example can't be changed/;

	const clip = await opens(page, page.getByTestId('placement-1-0').locator('rect.body'), /^Clip /);
	await expect(clip).toContainText(why);
	await expect(clip.getByRole('menuitem', { name: 'Open notes' })).toBeEnabled();
	await expect(clip.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
	await expect(clip.getByRole('menuitem', { name: 'Delete clip' })).toBeDisabled();
	await closes(page);

	const head = await opens(page, page.getByTestId('track-1'), /^Track /);
	await expect(head).toContainText(why);
	await expect(head.getByRole('menuitem', { name: 'Rename…' })).toBeDisabled();
	await expect(head.getByRole('menuitem', { name: 'Solo' })).toBeEnabled();
	await expect(head.getByRole('menuitem', { name: 'Use the standard kit' })).toBeDisabled();
	await closes(page);

	// Past the song's end, where the row has no clip.
	const row = page.getByTestId('row-1');
	const width = Number(await row.getAttribute('width'));
	await opens(page, row, /^Row of /, { x: width - 30, y: 30 });
	await expect(menu(page)).toContainText(why);
	await expect(menu(page).getByRole('menuitem', { name: 'New clip here' })).toBeDisabled();
	await expect(menu(page).getByRole('menuitem', { name: 'Move the playhead here' })).toBeEnabled();
	await closes(page);

	await page.getByTestId('placement-1-0').locator('rect.body').click();
	const note = await opens(page, page.getByTestId('note-0').locator('.body'), /^Note|notes$/);
	await expect(note.getByRole('menuitem', { name: 'Copy' })).toBeEnabled();
	await expect(note.getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
	await closes(page);

	// The example's patch is built in: its graph's menu says Edit a copy.
	await openView(page, 'patch');
	const graph = page.getByTestId('graph');
	const box = (await graph.boundingBox())!;
	await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20, { button: 'right' });
	await expect(menu(page)).toHaveAccessibleName('Graph');
	await expect(menu(page)).toContainText(/A built-in patch can't be changed/);
	await expect(menu(page).getByRole('menuitem', { name: 'Add a node…' })).toBeDisabled();
});
