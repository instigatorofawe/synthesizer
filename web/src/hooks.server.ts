import { prepareDatabase } from '#lib/server/Db.ts';

// Runs once at startup, before the first request.
export const init = () => {
	prepareDatabase();
};
