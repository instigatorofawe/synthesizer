import { expect, test as base, type Page } from '@playwright/test';
import { redoButton, undoButton } from './Chrome.ts';
import { settled } from './Engine.ts';

// A page load waits until the page has hydrated, as in AppTest.
const test = base.extend({
	page: async ({ page }, use) => {
		const hydrated = async <T extends { ok(): boolean } | null>(response: T) => {
			if (response?.ok()) await page.locator('body[data-hydrated]').waitFor({ state: 'attached' });
			return response;
		};
		const goto = page.goto.bind(page);
		const reload = page.reload.bind(page);
		page.goto = async (...args) => hydrated(await goto(...args));
		page.reload = async (...args) => hydrated(await reload(...args));
		await use(page);
	}
});

// The browser sits beside the page at this width. The last test has the laptop.
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(({ page }) => {
	page.on('dialog', (dialog) => dialog.accept());
});

type Tempo = { tick: number; bpm: number; ramp?: boolean };

const BAR = 96; // Pixels, at the arrangement's zoom until it is changed
const lane = (page: Page) => page.getByTestId('tempo-lane');
const laneButton = (page: Page) => page.getByRole('button', { name: 'Tempo lane' });
const point = (page: Page, index: number) => page.getByTestId(`tempo-point-${index}`);
// A folded change's label, which its tooltip says more than.
const flag = (page: Page, index: number) => page.getByTestId(`tempo-flag-${index}`).locator('text');
const field = (page: Page) => page.getByTestId('tempo');
const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!;

async function tab(page: Page, name: 'Notes' | 'Mixer' | 'JSON') {
	await page
		.getByRole('tablist', { name: 'Timeline views' })
		.getByRole('tab', { name: new RegExp(`^${name}`) })
		.click();
}

async function timelineDoc(page: Page) {
	await tab(page, 'JSON');
	const doc = JSON.parse(await page.getByLabel('Timeline JSON').inputValue());
	await tab(page, 'Notes');
	return doc as { tempo: Tempo[]; tracks: { id: number; gain: number; pan: number }[] };
}

async function setTempo(page: Page, tempo: Tempo[]) {
	await tab(page, 'JSON');
	const json = page.getByLabel('Timeline JSON');
	const doc = JSON.parse(await json.inputValue());
	doc.tempo = tempo;
	await json.fill(JSON.stringify(doc, null, 1));
	await json.blur();
	await tab(page, 'Notes');
}

async function unfold(page: Page) {
	await laneButton(page).click();
	await expect(lane(page)).toHaveAttribute('data-open', 'true');
}

// The middle of a change's point, where a drag takes hold of it.
async function centre(page: Page, index: number) {
	const at = (await point(page, index).boundingBox())!;
	return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
}

// How far down a lane drag goes for a tempo `by` BPM slower, as the lane is scaled now.
const pixelsFor = async (page: Page, by: number) => by * Number(await lane(page).getAttribute('data-per-bpm'));

test('the folded Tempo lane reads the song’s tempo, and stays unfolded for that song', async ({ page }) => {
	await page.goto('/?timeline=song');
	await expect(lane(page)).toHaveAttribute('data-open', 'false');
	await expect(laneButton(page)).toHaveAttribute('aria-expanded', 'false');
	await expect(flag(page, 0)).toHaveText('140');
	const folded = (await lane(page).boundingBox())!;
	expect(folded.height).toBeLessThan(24);

	// A double-click unfolds it. Which lanes are open is the editor's, kept for the song across a reload, and not in it.
	await page.mouse.dblclick(folded.x + 5 * BAR, folded.y + folded.height / 2);
	await expect(lane(page)).toHaveAttribute('data-open', 'true');
	await expect(laneButton(page)).toHaveAttribute('aria-expanded', 'true');
	const open = (await lane(page).boundingBox())!;
	expect(open.height).toBeGreaterThanOrEqual(64);
	expect(open.height).toBeLessThanOrEqual(80);
	expect((await box(page, 'row-1')).y).toBeGreaterThanOrEqual(open.y + open.height); // The tracks make room
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.reload();
	await expect(lane(page)).toHaveAttribute('data-open', 'true');
	await page.goto('/?timeline=ballad');
	await expect(lane(page)).toHaveAttribute('data-open', 'false');
	await page.goto('/?timeline=song');
	await expect(lane(page)).toHaveAttribute('data-open', 'true');
	await laneButton(page).click();
	await expect(lane(page)).toHaveAttribute('data-open', 'false');
	await page.reload();
	await expect(lane(page)).toHaveAttribute('data-open', 'false');

	await setTempo(page, [
		{ tick: 0, bpm: 140 },
		{ tick: 3840, bpm: 90, ramp: true },
		{ tick: 7680, bpm: 120 }
	]);
	// Reading it takes no clicks: a flag at each change, and a slope where one glides to the next
	await expect(flag(page, 0)).toHaveText('140');
	await expect(flag(page, 1)).toHaveText('90');
	await expect(flag(page, 2)).toHaveText('120');
	await expect(page.getByTestId('tempo-glide-1')).toBeAttached();
	await expect(page.getByTestId('tempo-glide-0')).toHaveCount(0);
	await expect(lane(page)).toHaveAttribute('aria-label', 'Tempo lane: 140 BPM, 90 from bar 3, gliding to 120 by bar 5');
	const third = (await box(page, 'tempo-flag-1')).x - (await lane(page).boundingBox())!.x;
	expect(Math.abs(third - 2 * BAR)).toBeLessThan(2); // At bar 3
	// The inspector's list is the same tempo
	await expect(page.getByText('Tempo, 140 BPM')).toBeAttached();

	// Unfolded, it is a curve, with its scale in its head
	await page.mouse.dblclick(folded.x + 5 * BAR, folded.y + folded.height / 2);
	await expect(lane(page)).toHaveAttribute('data-open', 'true');
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '90');
	await expect(page.getByTestId('tempo-segment-1')).toHaveAttribute('data-glide', 'true');
	await expect(page.getByTestId('tempo-segment-0')).toHaveAttribute('data-glide', 'false');
	await expect(page.getByTestId('lane-head-tempo')).toContainText('150');
	await expect(page.getByTestId('lane-head-tempo')).toContainText('80');
});

test('a click on the lane adds a change, a drag sets its tempo, and a click on the line before it glides there', async ({
	page
}) => {
	await page.goto('/?timeline=song');
	await page.getByRole('button', { name: 'Start audio' }).click();
	await expect(page.getByTestId('generation')).toHaveText('1', { timeout: 10000 });
	await settled(page);
	await unfold(page);
	await expect(field(page)).toHaveValue('140');
	// The playhead in bar 4, where a change at bar 3 is playing
	const ruler = await box(page, 'ruler');
	await page.mouse.click(ruler.x + 3 * BAR + 2, ruler.y + ruler.height / 2);
	await expect(page.getByTestId('tick')).toHaveText('5760');

	// Pressed at bar 3, it is a change at the tempo playing there, and dragged down, a slower one
	const at = (await lane(page).boundingBox())!;
	const press = { x: at.x + 2 * BAR + 3, y: at.y + at.height / 2 };
	const down = await pixelsFor(page, 40);
	await page.mouse.move(press.x, press.y);
	await page.mouse.down();
	await expect(point(page, 1)).toHaveAttribute('data-tick', '3840');
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '140');
	await page.mouse.move(press.x, press.y + down / 2, { steps: 4 });
	await page.mouse.move(press.x, press.y + down, { steps: 4 });
	await expect(page.getByTestId('tempo-readout')).toHaveText('100 BPM · 3.1.000');
	// The top bar follows the drag, and nothing is an edit until it is let go
	await expect(field(page)).toHaveValue('100');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await expect(page.getByTestId('generation')).toHaveText('1');
	await page.mouse.up();
	await expect(page.getByTestId('tempo-readout')).toHaveCount(0);
	await expect(page.getByTestId('unsaved')).toBeVisible();
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '100');
	await expect(field(page)).toHaveValue('100');
	expect((await timelineDoc(page)).tempo).toEqual([
		{ tick: 0, bpm: 140 },
		{ tick: 3840, bpm: 100 }
	]);

	// Adding and dragging was one gesture, so it is one step to undo
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveCount(0);
	await expect(field(page)).toHaveValue('140');
	await redoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '100');

	// A click on the line from the first change makes it glide to the second
	const line = await box(page, 'tempo-segment-0');
	await page.mouse.click(line.x + line.width / 2, line.y + line.height / 2);
	await expect(page.getByTestId('tempo-segment-0')).toHaveAttribute('data-glide', 'true');
	expect((await timelineDoc(page)).tempo).toEqual([
		{ tick: 0, bpm: 140, ramp: true },
		{ tick: 3840, bpm: 100 }
	]);
	await settled(page);
	await expect(page.getByTestId('generation')).not.toHaveText('1');

	// As the song plays through the glide, the top bar reads where it has got to
	await page.mouse.click(ruler.x + 2, ruler.y + ruler.height / 2);
	await expect(page.getByTestId('tick')).toHaveText('0');
	await expect(field(page)).toHaveValue('140');
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	const reading = () =>
		page.evaluate(() => ({
			tick: Number(document.querySelector('[data-testid="tick"]')!.textContent),
			bpm: Number((document.querySelector('[data-testid="tempo"]') as HTMLInputElement).value)
		}));
	const gliding = async () => {
		const { tick, bpm } = await reading();
		const expected = 140 - (40 * tick) / 3840;
		return tick > 240 && tick < 3600 && bpm < 140 && bpm > 100 && Math.abs(bpm - expected) < 0.2
			? 'gliding'
			: `${bpm} at ${tick}`;
	};
	await expect.poll(gliding, { timeout: 10000, intervals: [50] }).toBe('gliding');
	await expect
		.poll(async () => {
			const { tick, bpm } = await reading();
			return tick >= 3840 ? bpm : 'still gliding';
		})
		.toBe(100);
});

test('each gesture in the lane is one step to undo, and its keys and menu edit the chosen change', async ({ page }) => {
	await page.goto('/?timeline=song');
	await setTempo(page, [
		{ tick: 0, bpm: 140 },
		{ tick: 3840, bpm: 100 }
	]);
	await unfold(page);
	const tempo = async () => (await timelineDoc(page)).tempo;

	// A drag sideways moves a change a bar on, and one Undo moves it back
	let from = await centre(page, 1);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + BAR / 2, from.y, { steps: 4 });
	await page.mouse.move(from.x + BAR, from.y, { steps: 4 });
	await expect(page.getByTestId('tempo-readout')).toHaveText('100 BPM · 4.1.000');
	await page.mouse.up();
	await expect(point(page, 1)).toHaveAttribute('data-tick', '5760');
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-tick', '3840');

	// It can't pass the change before it, and the first change moves only up and down
	from = await centre(page, 1);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x - 4 * BAR, from.y, { steps: 6 });
	await page.mouse.up();
	await expect(point(page, 1)).toHaveAttribute('data-tick', '480');
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-tick', '3840');
	from = await centre(page, 0);
	const faster = await pixelsFor(page, 10);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 2 * BAR, from.y - faster, { steps: 6 });
	await page.mouse.up();
	await expect(point(page, 0)).toHaveAttribute('data-tick', '0');
	await expect(point(page, 0)).toHaveAttribute('data-bpm', '150');
	await undoButton(page).click();
	await expect(point(page, 0)).toHaveAttribute('data-bpm', '140');

	// A change's menu switches it between holding and gliding, and deletes it, but not the first
	from = await centre(page, 1);
	await page.mouse.click(from.x, from.y, { button: 'right' });
	let menu = page.getByRole('menu', { name: 'Tempo at bar 3' });
	await expect(menu.getByRole('menuitem')).toHaveText(['Glide to the next tempo', 'Delete']);
	await expect(menu.getByRole('menuitem', { name: 'Glide to the next tempo' })).toBeDisabled(); // There's no next
	await page.keyboard.press('Escape');
	from = await centre(page, 0);
	await page.mouse.click(from.x, from.y, { button: 'right' });
	menu = page.getByRole('menu', { name: 'Tempo at bar 1' });
	await expect(menu.getByRole('menuitem')).toHaveText(['Glide to the next tempo']);
	await menu.getByRole('menuitem', { name: 'Glide to the next tempo' }).click();
	await expect(page.getByTestId('tempo-segment-0')).toHaveAttribute('data-glide', 'true');
	await page.mouse.click(from.x, from.y, { button: 'right' });
	await expect(menu.getByRole('menuitem')).toHaveText(['Hold until the next change']);
	await page.keyboard.press('Escape');
	await undoButton(page).click();
	await expect(page.getByTestId('tempo-segment-0')).toHaveAttribute('data-glide', 'false');

	// ↑ and ↓ nudge the chosen change, by 10 with Shift, and Delete takes it away, each one step
	from = await centre(page, 1);
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('ArrowUp');
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '101');
	await page.keyboard.press('Shift+ArrowDown');
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '91');
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '101');
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '100');
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('Delete');
	await expect(point(page, 1)).toHaveCount(0);
	await expect(page.getByTestId('placement-1-0')).toBeAttached(); // Delete in the lane is the lane's, not the clip's
	expect(await tempo()).toEqual([{ tick: 0, bpm: 140 }]);
	await undoButton(page).click();
	await expect(point(page, 1)).toHaveAttribute('data-bpm', '100');
	from = await centre(page, 0);
	await page.mouse.click(from.x, from.y);
	await page.keyboard.press('Delete');
	await expect(point(page, 0)).toHaveAttribute('data-bpm', '140'); // The first stays
	expect(await tempo()).toEqual([
		{ tick: 0, bpm: 140 },
		{ tick: 3840, bpm: 100 }
	]);
});

test('a track head’s fader and pan are the Mixer’s, live while dragged and one step when let go', async ({ page }) => {
	await page.goto('/?timeline=song');
	const fader = page.getByTestId('head-fader-1');
	const pan = page.getByTestId('head-pan-1');
	await tab(page, 'Mixer');
	const mixerFader = page.getByRole('tabpanel').getByLabel('Fader for Lead');
	const mixerPan = page.getByRole('tabpanel').getByLabel('Pan for Lead');
	await expect(fader).toHaveAttribute('aria-valuetext', '-1.9 dB');
	await expect(mixerFader).toHaveAttribute('aria-valuetext', '-1.9 dB');
	await expect(pan).toHaveAttribute('aria-valuetext', 'L20');

	// Dragged left, it turns the track down, and the song takes the level it was let go at
	const at = (await fader.boundingBox())!;
	const start = { x: at.x + at.width * 0.6, y: at.y + at.height / 2 };
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x - 15, start.y, { steps: 3 });
	await page.mouse.move(start.x - 30, start.y, { steps: 3 });
	await expect(fader).not.toHaveAttribute('aria-valuetext', '-1.9 dB');
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
	await page.mouse.up();
	await expect(page.getByTestId('unsaved')).toBeVisible();
	const level = (await fader.getAttribute('aria-valuetext'))!;
	expect(parseFloat(level)).toBeLessThan(-3);
	await expect(mixerFader).toHaveAttribute('aria-valuetext', level);
	await undoButton(page).click();
	await expect(fader).toHaveAttribute('aria-valuetext', '-1.9 dB');
	await expect(mixerFader).toHaveAttribute('aria-valuetext', '-1.9 dB');
	await redoButton(page).click();
	await expect(mixerFader).toHaveAttribute('aria-valuetext', level);

	// A click changes nothing, and a double-click resets it to 0 dB
	await fader.click();
	await expect(fader).toHaveAttribute('aria-valuetext', level);
	await fader.dblclick();
	await expect(fader).toHaveAttribute('aria-valuetext', '0.0 dB');
	await expect(mixerFader).toHaveAttribute('aria-valuetext', '0.0 dB');
	// And the Mixer's fader moves the head's
	await mixerFader.evaluate((input: HTMLInputElement) => {
		input.value = '0.5';
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await expect(fader).toHaveAttribute('aria-valuetext', '-12.0 dB');

	// The pan goes right as it is dragged up, and a double-click centres it
	const knob = (await pan.boundingBox())!;
	await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
	await page.mouse.down();
	await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2 - 30, { steps: 6 });
	await page.mouse.up();
	await expect(pan).toHaveAttribute('aria-valuetext', 'R30');
	await expect(mixerPan).toHaveValue('0.3');
	await pan.dblclick();
	await expect(pan).toHaveAttribute('aria-valuetext', 'C');
	await expect(mixerPan).toHaveValue('0');

	// The arrow keys step whichever has focus
	await pan.focus();
	await page.keyboard.press('ArrowLeft');
	await expect(pan).toHaveAttribute('aria-valuetext', 'L5');
	const doc = await timelineDoc(page);
	expect(doc.tracks.find((t) => t.id === 1)).toMatchObject({ gain: 0.25, pan: -0.05 });
});

test('an example’s tempo and mix can be looked at but not changed', async ({ page }) => {
	await page.goto('/?recipe=Kick808');
	await expect(lane(page)).toHaveAttribute('data-open', 'false');
	await expect(page.getByTestId('tempo-flag-0')).toBeAttached();
	await unfold(page);
	const before = await page.locator('[data-testid^="tempo-point-"]').count();
	const at = (await lane(page).boundingBox())!;
	await page.mouse.click(at.x + 2 * BAR + 3, at.y + at.height / 2);
	await expect(lane(page)).toBeFocused();
	await expect(page.locator('[data-testid^="tempo-point-"]')).toHaveCount(before);

	const fader = page.locator('[data-testid^="head-fader-"]').first();
	await expect(fader).toHaveAttribute('aria-disabled', 'true');
	const level = (await fader.getAttribute('aria-valuetext'))!;
	const box = (await fader.boundingBox())!;
	await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 4 });
	await page.mouse.up();
	await expect(fader).toHaveAttribute('aria-valuetext', level);
	await expect(page.getByTestId('unsaved')).toHaveCount(0);
});

test('at 1280 by 800, the arrangement fits beside the inspector, with the song layer and the heads’ controls', async ({
	page
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/?timeline=song');
	const inspector = page.getByRole('button', { name: 'Inspector' });
	await expect(inspector).toHaveAttribute('aria-expanded', 'false');
	await inspector.click();
	await expect(inspector).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('#inspector')).toBeVisible();

	const fits = async () => {
		const view = (await page.getByTestId('arrangement-view').boundingBox())!;
		const side = (await page.locator('#inspector').boundingBox())!;
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
		expect(view.x + view.width).toBeLessThanOrEqual(side.x);
		const heads = (await page.getByTestId('lane-head-tempo').boundingBox())!;
		expect(heads.width).toBeLessThanOrEqual(160);
		expect(view.width - heads.width).toBeGreaterThan(600); // Bars to see
		const tempo = (await lane(page).boundingBox())!;
		expect(tempo.x).toBeGreaterThanOrEqual(view.x + heads.width - 1);
		expect(tempo.y + tempo.height).toBeLessThanOrEqual(view.y + view.height);
		for (const id of ['head-fader-1', 'head-pan-1', 'head-fader-2', 'head-pan-2', 'track-patch-1']) {
			const shown = await box(page, id);
			expect(shown.x, id).toBeGreaterThanOrEqual(view.x);
			expect(shown.x + shown.width, id).toBeLessThanOrEqual(view.x + view.width);
			expect(shown.y + shown.height, id).toBeLessThanOrEqual(view.y + view.height);
		}
		// Each head's controls sit inside it, clear of one another
		const fader = await box(page, 'head-fader-1');
		const knob = await box(page, 'head-pan-1');
		expect(fader.x + fader.width).toBeLessThan(knob.x);
		expect(fader.width).toBeGreaterThan(50);
		const row = await box(page, 'row-1');
		expect(knob.y).toBeGreaterThanOrEqual(row.y);
		expect(knob.y + knob.height).toBeLessThanOrEqual(row.y + row.height);
	};
	await fits();
	await unfold(page);
	await fits();
	// The notes keep room below it
	await expect
		.poll(() => page.getByTestId('roll').evaluate((roll) => roll.closest('.roll')!.clientHeight))
		.toBeGreaterThan(200);
});
