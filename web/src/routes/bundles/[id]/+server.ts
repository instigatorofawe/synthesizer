// The editor is one page now, and these addresses open it on what they used to show.
import { redirect } from '@sveltejs/kit';

export const GET = ({ params }) => redirect(308, `/?bundle=${encodeURIComponent(params.id)}`);
