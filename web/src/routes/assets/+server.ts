// Recordings by id, for a page that opens a built-in patch, or names one in an edit not yet saved, before anything saved
// uses it. The library's load leaves those out, so that a page carries no recording nobody plays.
import { json } from '@sveltejs/kit';
import { db } from '#lib/server/Db.ts';
import { assetsById } from '#lib/server/Repository.ts';

export const GET = ({ url }) => json(assetsById(db(), [...new Set(url.searchParams.getAll('id'))]));
