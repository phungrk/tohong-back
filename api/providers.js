import { handleProvidersRequest } from '../lib/handler.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  return handleProvidersRequest(request, process.env);
}
