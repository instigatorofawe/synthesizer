import { expect, test, type Page } from './Fixtures.ts';

// A patch dragged out of the browser onto the song: onto a track to play it there, below the tracks for a new track, and an
// insert onto a track or a Mixer strip. WAV files dropped from the desktop, and track heads dragged to move tracks. Wide
// enough that the browser sits beside the page, but for the test of the browser over the page.
test.use({ viewport: { width: 1440, height: 900 } });

const BAR = 1920; // At the demo song's 480 ppq
const browser = (page: Page) => page.getByRole('navigation', { name: 'Browser' });
const patchLink = (page: Page, name: string) =>
	browser(page).getByRole('list', { name: 'Patches' }).getByRole('link', { name, exact: true });

// A drag the way a hand makes one: pressed on the patch, moved a little, which starts it, then let go of over `to`. The place
// to let go is found once the drag has started, since a patch's drag opens the row for a new track.
async function dragPatch(page: Page, name: string, to: () => Promise<{ x: number; y: number }>) {
	const from = (await patchLink(page, name).boundingBox())!;
	await page.mouse.move(from.x + 10, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + 30, from.y + from.height / 2, { steps: 3 });
	const at = await to();
	await page.mouse.move(at.x, at.y, { steps: 5 });
	await page.mouse.up();
}

const middleOf = async (page: Page, testid: string, dx = 0) => {
	const box = (await page.getByTestId(testid).boundingBox())!;
	return { x: box.x + (dx || box.width / 2), y: box.y + box.height / 2 };
};

test('a patch dragged onto a track plays there, and below the tracks makes a new track with a clip at that bar', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await expect(page.getByTestId('track-patch-1')).toHaveText('Stereo lead');

	await dragPatch(page, 'Square, in the library but on no timeline', () => middleOf(page, 'head-1'));
	await expect(page.getByTestId('track-patch-1')).toHaveText('Square, in the library but on no timeline');
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');

	// Below the tracks, a row is there for as long as the drag lasts, and the clip goes at the bar let go of.
	await expect(page.getByTestId('new-track-row')).toHaveCount(0);
	await dragPatch(page, 'Sampled pluck', async () => {
		await expect(page.getByTestId('new-track-row')).toBeVisible();
		const row = (await page.getByTestId('new-track-row').boundingBox())!;
		const ruler = (await page.getByTestId('ruler').boundingBox())!;
		const perBar = await page.evaluate(() => {
			const numbers = [...document.querySelectorAll('[data-testid="arrangement-band"] text.number')];
			return Number(numbers[1].getAttribute('x')) - Number(numbers[0].getAttribute('x'));
		});
		return { x: ruler.x + perBar * 2.5, y: row.y + row.height / 2 }; // Into the third bar
	});
	await expect(page.getByTestId('new-track-row')).toHaveCount(0);
	await expect(page.getByTestId('track-patch-3')).toHaveText('Sampled pluck');
	await expect(page.getByTestId('placement-3-0')).toHaveAttribute('data-tick', String(2 * BAR));
	await expect(page.getByTestId('track-3')).toHaveAttribute('aria-pressed', 'true'); // Chosen, with its clip in the roll
});

test('an insert dragged onto a track joins its effects, and onto a Mixer strip joins that one, and makes no new track', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await dragPatch(page, 'Room', async () => {
		await expect(page.getByTestId('new-track-row')).toHaveCount(0); // An insert plays no notes
		return middleOf(page, 'row-2');
	});
	await expect(page.getByTestId('drop-words-2')).toHaveCount(0);
	await page.getByRole('tablist', { name: 'Song views' }).getByRole('tab', { name: 'Mixer' }).click();
	await expect(page.getByLabel('Insert 1 on Pluck')).toHaveValue('reverb');

	await dragPatch(page, 'Room', () => middleOf(page, 'strip-master'));
	await expect(page.getByLabel('Insert 1 on Master')).toHaveValue('reverb');
	await expect(page.getByTestId('head-3')).toHaveCount(0);
});

test('a track head dragged down moves the track below the next, and its menu moves it back', async ({ page }) => {
	await page.goto('/?timeline=song');
	const heads = page.locator('[data-testid^="head-"]');
	await expect(heads).toHaveAttribute('data-testid', /./);
	const order = () => heads.evaluateAll((all) => all.map((head) => head.getAttribute('data-testid')));
	expect(await order()).toEqual(['head-1', 'head-2']);

	const lead = (await page.getByTestId('track-1').boundingBox())!;
	const pluck = (await page.getByTestId('head-2').boundingBox())!;
	await page.mouse.move(lead.x + 20, lead.y + lead.height / 2);
	await page.mouse.down();
	await page.mouse.move(lead.x + 20, pluck.y + pluck.height - 5, { steps: 6 });
	await expect(page.getByTestId('track-line')).toBeVisible();
	await page.mouse.up();
	await expect.poll(order).toEqual(['head-2', 'head-1']);
	await expect(page.getByTestId('unsaved')).toHaveText('1 unsaved');

	await page.getByTestId('track-1').click({ button: 'right' });
	const menu = page.getByRole('menu', { name: 'Track Lead' });
	await expect(menu.getByRole('menuitem', { name: 'Move down' })).toBeDisabled(); // It's the last
	await menu.getByRole('menuitem', { name: 'Move up' }).click();
	await expect.poll(order).toEqual(['head-1', 'head-2']);

	// Esc while dragging puts it back.
	await page.mouse.move(lead.x + 20, lead.y + lead.height / 2);
	await page.mouse.down();
	await page.mouse.move(lead.x + 20, pluck.y + pluck.height - 5, { steps: 6 });
	await page.keyboard.press('Escape');
	await page.mouse.up();
	expect(await order()).toEqual(['head-1', 'head-2']);
});

// A short sine, so that a test doesn't depend on a file.
function wavBytes(seconds = 0.3, frequency = 440, rate = 48000) {
	const frames = Math.round(seconds * rate);
	const out = Buffer.alloc(44 + frames * 2);
	out.write('RIFF', 0, 'latin1');
	out.writeUInt32LE(36 + frames * 2, 4);
	out.write('WAVEfmt ', 8, 'latin1');
	out.writeUInt32LE(16, 16);
	out.writeUInt16LE(1, 20);
	out.writeUInt16LE(1, 22);
	out.writeUInt32LE(rate, 24);
	out.writeUInt32LE(rate * 2, 28);
	out.writeUInt16LE(2, 32);
	out.writeUInt16LE(16, 34);
	out.write('data', 36, 'latin1');
	out.writeUInt32LE(frames * 2, 40);
	for (let i = 0; i < frames; ++i)
		out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 24000), 44 + i * 2);
	return [...out];
}

// What the desktop hands a page when files are dropped on it, made in the page, since a test can't drag from the desktop.
async function filesDropped(page: Page, testid: string, at: { x: number; y: number }, name: string) {
	const files = await page.evaluateHandle(
		({ bytes, name }) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'audio/wav' }));
			return transfer;
		},
		{ bytes: wavBytes(), name }
	);
	const where = { dataTransfer: files, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true };
	await page.getByTestId(testid).dispatchEvent('dragover', where);
	await page.getByTestId(testid).dispatchEvent('drop', where);
}

test('WAV files dropped below the tracks become an instrument, played by a new track', async ({ page }) => {
	await page.goto('/?timeline=song');
	const row = (await page.getByTestId('row-2').boundingBox())!;
	await filesDropped(page, 'arrangement-view', { x: row.x + 40, y: row.y + row.height * 1.5 }, 'Bell_C4.wav');
	await expect(page.getByTestId('track-patch-3')).toHaveText('Bell_C4');
	await expect(page.getByTestId('placement-3-0')).toHaveAttribute('data-tick', '0');
	await expect(browser(page).getByRole('list', { name: 'Samples' })).toContainText('Bell_C4');
});

test('WAV files dropped on the browser are imported, as its + does', async ({ page }) => {
	await page.goto('/?timeline=song');
	const box = (await browser(page).boundingBox())!;
	await page.getByRole('navigation', { name: 'Browser' }).evaluate((nav) => nav.setAttribute('data-testid', 'browser'));
	await filesDropped(page, 'browser', { x: box.x + 40, y: box.y + 200 }, 'Gong.wav');
	await expect(browser(page).getByRole('list', { name: 'Samples' })).toContainText('Gong');
});

test.describe('at a laptop width, where the browser opens over the page', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('the browser steps aside while a patch is dragged out of it, and is gone once it is dropped', async ({
		page
	}) => {
		await page.goto('/?timeline=song');
		await page.getByRole('button', { name: 'Patches' }).click(); // The rail's icon opens the browser at its list
		await expect(patchLink(page, 'Stereo lead')).toBeVisible();
		await dragPatch(page, 'Square, in the library but on no timeline', async () => {
			await expect(page.locator('.side.over')).toHaveCSS('opacity', '0');
			return middleOf(page, 'row-2', 60);
		});
		await expect(page.getByTestId('track-patch-2')).toHaveText('Square, in the library but on no timeline');
		await expect(browser(page)).toHaveCount(0);
	});
});
