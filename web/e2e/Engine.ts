import { startAudio } from './Chrome.ts';
import { expect, type Locator, type Page } from './Fixtures.ts';

// A test waits for something on the page to change, never for time to pass, so a slow machine makes it slower and no less sure.
// The rules for what plays:
// 1. After an edit, wait for it to show (its element, a name, `unsaved`, the address), then for `settled`, or for `newestPlays`
//    if the test listens or measures what the engine's report changes.
// 2. Never count images or compiles to mean "the newest plays": how many an edit makes depends on how quickly things came. Read
//    the count before, act, and wait for it to change, or keep an exact count only where the count is the claim (a lint asks
//    for the reason).
// 3. Play waits for an edit on its way, so a note just drawn is heard; a test that listens from the start still waits for
//    `newestPlays` before reading.
// 4. A check that nothing was scheduled reads the light once, right after the event (`busyNow`): an edit sets it in the same
//    flush, and a retrying read would pass once a wrongly scheduled compile had finished.
// 5. "Once it has ended" waits for `data-playing="false"`.

// The loudest a meter or a scope's level has been since Play, or since the image playing now began. A short note shows here
// whenever it is read, where the level shows it only while it sounds.
export const loudest = (meter: Locator) => meter.getAttribute('data-loudest').then(Number);

// Nothing is on its way: every edit has compiled, and any image made from one is playing. True before audio starts too, and
// after a refused edit, when an older image plays.
// `timeout` is for an edit whose compile is known to be long, sized from its work.
export const settled = (page: Page, timeout = 10000) =>
	expect(page.getByTestId('status')).toHaveAttribute('aria-busy', 'false', { timeout });

// Audio has started and the image playing is the newest edit's, as the light says. Before a check that listens, or that measures
// a layout the engine's report changes, such as a scope arriving.
export const newestPlays = (page: Page) =>
	expect(page.getByTestId('status')).toHaveAttribute('data-heard', 'newest', { timeout: 10000 });

// Audio started, and the newest image playing.
export async function startAudioNewest(page: Page) {
	await startAudio(page);
	await newestPlays(page);
}

// Whether an edit is on its way, read once, right after the event that would have made one.
export const busyNow = async (page: Page) => (await page.getByTestId('status').getAttribute('aria-busy')) === 'true';

// The count of images since audio started, read now, to compare with after an edit.
export const imagesNow = async (page: Page) => (await page.getByTestId('generation').textContent()) ?? '';

// An edit's image has replaced the one playing when `before` was read, and nothing newer is on its way.
export async function swappedFrom(page: Page, before: string) {
	await expect(page.getByTestId('generation')).not.toHaveText(before, { timeout: 10000 });
	await newestPlays(page);
}

// Waits for the engine to render `seconds` more audio, however long that takes. A check that something doesn't happen, such as
// a playhead that stays put or a track that stays silent, waits for this.
export async function engineRenders(page: Page, seconds: number) {
	const time = () => page.getByTestId('state').getAttribute('data-time').then(Number);
	const from = await time();
	await expect.poll(time, { timeout: 10000 + 2000 * seconds }).toBeGreaterThanOrEqual(from + seconds);
}

// Waits for the playhead to go round a loop that ends at `end` some number of times, and fails if it ever passes `end`. The
// playhead may still be outside the loop when this starts, as when a click has just put it there.
export async function goesRound(page: Page, times: number, end: number) {
	const tick = async () => Number(await page.getByTestId('tick').textContent());
	let last: number | null = null;
	let rounds = 0;
	let furthest = 0;
	await expect
		.poll(
			async () => {
				const now = await tick();
				if (last === null && now > end) return rounds;
				if (last !== null && now < last) ++rounds;
				furthest = Math.max(furthest, now);
				last = now;
				return rounds;
			},
			{ timeout: 10000 + 4000 * times, intervals: [100] }
		)
		.toBeGreaterThanOrEqual(times);
	expect(furthest).toBeLessThanOrEqual(end);
}
