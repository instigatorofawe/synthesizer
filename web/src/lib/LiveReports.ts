import type { CompileReport } from '#lib/Request.ts';

// Matches compile reports to the image that is actually live. Counting loads cannot do this: the worklet drops a load that
// a newer one supersedes, and a load can fail, so ids come back from the worklet instead.
export class LiveReports {
	private reports = new Map<number, CompileReport>();
	private next = 1;
	private applied = 0;

	add(report: CompileReport): number {
		const id = this.next++;
		this.reports.set(id, report);
		return id;
	}

	// The report for the image now live, once per image. Reports older than it can never go live, so they are dropped.
	take(liveId: number): CompileReport | null {
		if (liveId === 0 || liveId === this.applied) return null;
		const report = this.reports.get(liveId) ?? null;
		this.applied = liveId;
		for (const id of this.reports.keys()) {
			if (id <= liveId) this.reports.delete(id);
		}
		return report;
	}
}
