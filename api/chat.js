/**
 * Vercel Edge Function entry point.
 *
 * Deploy:
 *   1. Place in `api/chat.js` of Vercel project
 *   2. Set env vars: CLAUDE_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROK_API_KEY
 *   3. Deploy via Vercel CLI: `vercel --prod`
 *
 * URL: POST https://your-app.vercel.app/api/chat
 */

import { handleChatRequest } from '../lib/handler.js';

export const config = {
  runtime: 'edge',
  // Optional: regions: ['sin1', 'hkg1'], // Singapore + Hong Kong for VN users
};

export default async function handler(request) {
  // Vercel: process.env automatically populated từ project settings
  return handleChatRequest(request, process.env);
}
