// Turns the repository's errors into what a form action returns.
import { fail } from '@sveltejs/kit';
import { Conflict, InUse, NotFound, ReadOnly } from '#lib/server/Repository.ts';

export function guarded<T>(work: () => T) {
	try {
		return work();
	} catch (e) {
		if (e instanceof Conflict || e instanceof InUse) return fail(409, { message: e.message });
		if (e instanceof NotFound) return fail(404, { message: e.message });
		if (e instanceof ReadOnly) return fail(403, { message: e.message });
		throw e;
	}
}
