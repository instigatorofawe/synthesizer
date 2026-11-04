import { expect, test, type Page } from './Fixtures.ts';
import { pianoKey } from './Chrome.ts';

// What the keyboard and the menus reach that a mouse used to be needed for: the sheet of shortcuts, quick open, a menu for
// every track head, empty row and empty roll, the keys as one Tab stop, B into the browser's filter, and the tempo list. At a
// laptop's 1280 by 800, where the browser opens over the page.

test.use({ viewport: { width: 1280, height: 800 } });

const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });

test('? opens a sheet of every key, drawn from the table, and Esc closes it', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.keyboard.press('Shift+Slash');
	const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('region', { name: 'Piano roll' })).toContainText('Chosen notes up a semitone');
	await expect(sheet.getByRole('region', { name: 'Step entry' })).toContainText('The last step’s notes up a semitone');
	await expect(sheet.getByRole('region', { name: 'Everywhere' })).toContainText('Open a song, an example or a patch');
	await page.keyboard.press('Escape');
	await expect(sheet).toHaveCount(0);

	// The rail's ? opens it too, for anyone who doesn't know the key.
	await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
	await expect(sheet).toBeVisible();
});

test('Mod+K finds a song, an example or a patch by part of its name, and Enter opens it', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.keyboard.press('ControlOrMeta+k');
	const found = page.getByRole('dialog', { name: 'Quick open' });
	await expect(found).toBeVisible();
	await page.keyboard.type('mountain');
	await expect(found.getByRole('option').first()).toContainText('HallOfTheMountainKing');
	await expect(found.getByRole('option').first()).toContainText('Example');
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/recipe=HallOfTheMountainKing/);
	await expect(found).toHaveCount(0);
});

test('a track head, an empty row and the empty roll each have a menu, and the menus show their keys', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await page.getByTestId('track-2').click({ button: 'right' });
	const head = page.getByRole('menu', { name: 'Track Pluck' });
	await expect(head.getByRole('menuitem')).toHaveText([
		'Rename…',
		'New clip at the playhead',
		'Move up',
		'Move down',
		'Mute',
		'Solo',
		'Delete track'
	]);
	await head.getByRole('menuitem', { name: 'Rename…' }).click();
	const name = page.getByLabel('Rename the track');
	await expect(name).toBeFocused();
	await name.fill('Plucked');
	await name.press('Enter');
	await expect(page.getByTestId('track-2')).toHaveText('Plucked');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');

	// Past the clips on Lead's row, a right-click offers a clip there.
	const row = (await page.getByTestId('row-1').boundingBox())!;
	const view = (await page.getByTestId('arrangement-view').boundingBox())!;
	await page.mouse.click(view.x + view.width - 60, row.y + row.height / 2, { button: 'right' });
	const rowMenu = page.getByRole('menu', { name: 'Row of Lead' });
	await rowMenu.getByRole('menuitem', { name: 'New clip here' }).click();
	await expect(page.getByTestId('placement-1-1')).toBeVisible();

	// The roll's own menu, where there is no note, and a chosen note's, which names its keys.
	await page.getByTestId('placement-1-0').click();
	const roll = (await page.locator('div.roll').first().boundingBox())!;
	await page.mouse.click(roll.x + roll.width - 40, roll.y + 40, { button: 'right' });
	const ground = page.getByRole('menu', { name: 'Piano roll' });
	await ground.getByRole('menuitem', { name: 'Choose all' }).click();
	await expect(page.locator('[data-testid^="note-"].chosen')).not.toHaveCount(0);
	await page.getByTestId('note-0').locator('.body').click({ button: 'right' });
	await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('aria-keyshortcuts', 'Delete');
});

test('the keys are one Tab stop, the arrows move along them, and Enter plays one', async ({ page }) => {
	await page.goto('/?timeline=song');
	const keys = page.getByRole('group', { name: 'Keys' });
	await expect(pianoKey(page, 48)).toBeEnabled(); // Once the song's image says the chosen track plays
	await expect(keys.locator('button[tabindex="0"]')).toHaveCount(1);
	await pianoKey(page, 48).focus();
	await page.keyboard.press('ArrowRight');
	await expect(pianoKey(page, 49)).toBeFocused();
	await expect(pianoKey(page, 49)).toHaveAttribute('tabindex', '0');
	await page.keyboard.down('Enter');
	await expect(pianoKey(page, 49)).toHaveClass(/down/);
	await page.keyboard.up('Enter');
	await expect(pianoKey(page, 49)).not.toHaveClass(/down/);
});

test('B gives the browser’s filter focus, and Esc there closes the browser and gives focus back', async ({ page }) => {
	await page.goto('/?timeline=song');
	await page.getByTestId('roll').focus();
	await page.keyboard.press('b');
	const filter = browser(page).getByLabel('Filter the browser');
	await expect(filter).toBeFocused();
	await page.keyboard.type('pluck');
	await page.keyboard.press('Escape'); // Empties the filter, as a search field does
	await expect(filter).toHaveValue('');
	await page.keyboard.press('Escape');
	await expect(browser(page)).toHaveCount(0);
	await expect(page.getByTestId('roll')).toBeFocused();
});

test('the ▾ beside BPM lists a song’s tempo changes, and one chosen moves the playhead to it', async ({ page }) => {
	await page.goto('/?recipe=HallOfTheMountainKing');
	await page.getByRole('button', { name: 'Tempo changes' }).click();
	const list = page.getByRole('menu', { name: 'Tempo changes' });
	await expect(list.getByRole('menuitem').nth(1)).toHaveText(/ BPM at bar \d+/);
	const second = await list.getByRole('menuitem').nth(1).textContent();
	const bar = /at bar (\d+)/.exec(second!)![1];
	await list.getByRole('menuitem').nth(1).click();
	await expect(page.getByLabel('Position')).toHaveValue(new RegExp(`^${bar}\\.`));
});
