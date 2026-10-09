import { serve } from '@hono/node-server';
import { createMarketingApp } from './marketing-app.js';

const app = createMarketingApp();
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid marketing PORT');
serve({ fetch: app.fetch, port });
