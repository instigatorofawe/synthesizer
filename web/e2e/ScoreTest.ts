import { expect, test, type Page } from './Fixtures.ts';
import { clickStill, rollPoint } from './Pointer.ts';

// The inspector is open beside the notes at this width.
test.use({ viewport: { width: 1440, height: 900 } });

const notesBar = (page: Page) => page.getByRole('toolbar', { name: 'Notes' });
const showAs = (page: Page, as: 'Roll' | 'Score') =>
	notesBar(page).getByRole('group', { name: 'Show the notes as' }).getByRole('button', { name: as });
const written = (page: Page, index: number) => page.getByTestId('score-page').locator(`[data-notes~="${index}"]`);

// Shown as a score, once VexFlow and its font are loaded and it has drawn.
async function score(page: Page) {
	await showAs(page, 'Score').click();
	await expect(showAs(page, 'Score')).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('score-page')).not.toHaveAttribute('data-drawn', '0');
}

async function shot(page: Page, name: string) {
	if (process.env.SCORE_SHOTS)
		await page.screenshot({ path: `${process.env.SCORE_SHOTS}/${name}.png`, fullPage: true });
}

test('a clip shows as a score in its song’s time and key, and the editor keeps to it', async ({ page }) => {
	await page.goto('/?recipe=FurElise');
	await expect(page.getByTestId('roll')).toBeVisible();
	await score(page);
	await expect(page.getByTestId('roll')).toHaveCount(0);
	const pageOf = page.getByTestId('score-page');
	await expect(pageOf).toHaveAttribute('data-staves', 'treble bass');
	// The pickup's two sixteenths, the last eighth of the clip's first bar, and the second spelled as A minor has it.
	await expect(written(page, 0)).toHaveAttribute('aria-label', 'E5 · 1/16 · 1.3.000');
	await expect(written(page, 1)).toHaveAttribute('aria-label', 'D♯5 · 1/16 · 1.3.120');
	await written(page, 1).click();
	await expect(page.getByTestId('score-told')).toHaveText('D♯5 · 1/16 · 1.3.120');
	await shot(page, 'FurElise');

	await page.reload();
	await expect(showAs(page, 'Score')).toHaveAttribute('aria-pressed', 'true');
	await expect(pageOf).not.toHaveAttribute('data-drawn', '0');
	await showAs(page, 'Roll').click();
	await expect(page.getByTestId('roll')).toBeVisible();
	await expect(page.getByTestId('score')).toHaveCount(0);
});

test('the score follows the notes and the key, and the playhead moves through it', async ({ page }) => {
	await page.goto('/');
	const before = new URL(page.url()).searchParams.get('timeline');
	await page.getByRole('button', { name: 'New song', exact: true }).click();
	await page.getByLabel('New song name').fill('Written');
	await page.getByLabel('New song name').press('Enter');
	await page.waitForURL((url) => url.searchParams.get('timeline') !== before);
	await expect(page.getByTestId('roll')).toBeVisible();
	await clickStill(page, await rollPoint(page, 0, 61));
	await expect(page.getByTestId('note-0')).toBeVisible();
	await clickStill(page, await rollPoint(page, 480, 65));
	await expect(page.getByTestId('note-1')).toBeVisible();

	await score(page);
	await expect(page.getByTestId('score-page')).toHaveAttribute('data-staves', 'treble');
	await expect(page.getByTestId('score-page')).toHaveAttribute('data-measures', '4');
	await expect(written(page, 0)).toHaveAttribute('aria-label', 'C♯4 · 1/4 · 1.1.000');

	// In A♭ major the same note is its D♭.
	await page.locator('#inspector').getByText('Key, C major').click();
	await page.locator('#inspector').getByLabel('Key at bar 1', { exact: true }).selectOption({ label: 'A♭ major, 4♭' });
	await expect(written(page, 0)).toHaveAttribute('aria-label', 'D♭4 · 1/4 · 1.1.000');

	const position = page.getByTestId('position');
	await position.fill('1.3');
	await position.press('Enter');
	await expect(page.getByTestId('score-playhead')).toBeVisible();
	await shot(page, 'Written');
});
