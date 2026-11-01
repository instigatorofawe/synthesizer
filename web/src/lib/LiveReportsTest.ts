import { describe, expect, it } from 'vitest';
import { LiveReports } from '#lib/LiveReports.ts';
import type { CompileReport } from '#lib/Request.ts';

const report = (name: string) => ({ programs: [{ name }] }) as unknown as CompileReport;

describe('LiveReports', () => {
	it('returns nothing until an image is live', () => {
		const reports = new LiveReports();
		reports.add(report('a'));
		expect(reports.take(0)).toBeNull();
	});

	it('hands over each report once', () => {
		const reports = new LiveReports();
		const a = reports.add(report('a'));
		expect(reports.take(a)?.programs[0].name).toBe('a');
		expect(reports.take(a)).toBeNull();
	});

	it('follows the image that went live when a newer load superseded one', () => {
		const reports = new LiveReports();
		reports.add(report('superseded'));
		const newest = reports.add(report('newest'));
		expect(reports.take(newest)?.programs[0].name).toBe('newest');
	});

	it('skips a load that failed', () => {
		const reports = new LiveReports();
		const first = reports.add(report('first'));
		expect(reports.take(first)?.programs[0].name).toBe('first');
		reports.add(report('failed'));
		const third = reports.add(report('third'));
		expect(reports.take(first)).toBeNull(); // Still live: the failed one changed nothing
		expect(reports.take(third)?.programs[0].name).toBe('third');
	});

	it('forgets reports that can no longer go live', () => {
		const reports = new LiveReports();
		const old = reports.add(report('old'));
		const newer = reports.add(report('newer'));
		reports.take(newer);
		expect(reports.take(old)).toBeNull();
	});
});
