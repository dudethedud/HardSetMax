// The one HTTP endpoint: Ko-fi posts donations to POST /kofi. Everything else is a
// 404. Bodies are capped and slow clients time out; the token check is in
// core/donations.ts.
import { createServer, type Server } from 'node:http';
import type { Logger } from '../logger.js';

const MAX_BODY = 64 * 1024;

export type KofiHandler = (formBody: string) => Promise<number>;

export function startWebhookServer(port: number, onKofi: KofiHandler, log: Logger): Promise<Server> {
  const server = createServer((req, res) => {
    const answer = (status: number) => {
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'ok' : String(status));
    };
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/') return answer(200); // "is the bot reachable?" check
    if (req.method !== 'POST' || path !== '/kofi') return answer(404);
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        answer(413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      onKofi(Buffer.concat(chunks).toString('utf8'))
        .then(answer)
        .catch((err: unknown) => {
          log.error({ err }, 'handling a Ko-fi donation failed');
          // A 500 makes Ko-fi try again later; the donation is only saved once.
          answer(500);
        });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      log.info({ port }, 'listening for Ko-fi donations on /kofi');
      resolve(server);
    });
  });
}
