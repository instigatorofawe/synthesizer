// The examples are in the editor's browser now.
import { redirect } from '@sveltejs/kit';

export const GET = () => redirect(308, '/');
