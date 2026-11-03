import { expect, type Locator, type Page } from '@playwright/test';

// A test waits for something on the page to change, never for time to pass, so a slow machine makes it slower and no less sure.

// The loudest a meter or a scope's level has been since Play, or since the image playing now began. A short note shows here
// whenever it is read, where the level shows it only while it sounds.
export const loudest = (meter: Locator) => meter.getAttribute('data-loudest').then(Number);

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
