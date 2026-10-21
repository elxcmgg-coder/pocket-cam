import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const token = () => randomBytes(32).toString('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createHandler({ hosts = ['localhost', '127.0.0.1'], now = Date.now } = {}) {
  const rooms = new Map();
  const attempts = new Map();
  const codes = new Map();
  function cleanup() {
    for (const [id, room] of rooms) {
      if (now() - room.active > 10 * 60_000 || now() - room.created > 4 * 3600_000) {
        rooms.delete(id); codes.delete(room.code);
      }
    }
    for (const [ip, item] of attempts) if (now() - item.since > 60_000) attempts.delete(ip);
  }
  function limit(ip, category, max) {
    const key = `${category}:${ip}`;
    const item = attempts.get(key) || { since: now(), count: 0 };
    if (++item.count > max) throw fail(429, '请求太频繁，请一分钟后再试。');
    attempts.set(key, item);
  }
  function send(room, role, message) {
    const queue = room.messages[role];
    queue.push({ id: ++room.sequence, message });
    if (queue.length > 256) queue.shift();
  }
  return async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    };
    const reply = (status, data) => {
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const protocol = req.socket.encrypted ? 'https' : 'http';
      const origin = `${protocol}://${req.headers.host}`;
      const url = new URL(req.url, origin);
      if (!hosts.includes(url.hostname)) throw fail(403, '不允许的主机名。');
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [filename, type] = staticFiles.get(url.pathname);
        const content = await readFile(path.join(root, 'public', filename));
        res.writeHead(200, { ...headers, 'Content-Type': type }); return res.end(content);
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) throw fail(404, '未找到。');
      if (req.headers.origin !== origin) throw fail(403, '请求必须来自本机页面。');
      if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, '需要 JSON。');
      let raw = ''; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw fail(413, '请求过大。');
        raw += chunk.toString('utf8');
      }
      let body;
      try { body = JSON.parse(raw); } catch { throw fail(400, '无效的 JSON。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '无效的请求。');
      cleanup();
      const ip = req.socket.remoteAddress;
      if (url.pathname === '/api/create') {
        limit(ip, 'create', 10);
        if (rooms.size >= 32) throw fail(503, '会话已满，请稍后重试。');
        let code;
        do { code = String(randomInt(10_000_000, 100_000_000)); } while (codes.has(code));
        const id = randomBytes(16).toString('hex');
        const hostToken = token();
        rooms.set(id, { code, hostToken, phoneToken: null, created: now(), active: now(),
          sequence: 0, messages: { host: [], phone: [] }, closed: false });
        codes.set(code, id);
        return reply(201, { roomId: id, token: hostToken, code });
      }
      if (url.pathname === '/api/join') {
        limit(ip, 'join', 8);
        const roomId = codes.get(String(body.code));
        const room = rooms.get(roomId);
        if (!room || room.closed || room.phoneToken || now() - room.created > 10 * 60_000)
          throw fail(404, '配对码无效、已使用或已过期，请在 PC 新建连接。');
        room.phoneToken = token(); room.active = now(); codes.delete(room.code);
        send(room, 'host', { type: 'joined' });
        return reply(200, { roomId, token: room.phoneToken });
      }
      const room = rooms.get(body.roomId);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const role = room && bearer ? (bearer === room.hostToken ? 'host' : bearer === room.phoneToken ? 'phone' : null) : null;
      if (!role) throw fail(401, '会话已失效，请重新配对。');
      room.active = now();
      if (url.pathname === '/api/poll') {
        if (!Number.isSafeInteger(body.after) || body.after < 0) throw fail(400, '无效的消息游标。');
        return reply(200, { messages: room.messages[role].filter(item => item.id > body.after) });
      }
      if (url.pathname === '/api/leave') {
        room.closed = true; codes.delete(room.code);
        send(room, role === 'host' ? 'phone' : 'host', { type: 'ended' });
        return reply(200, { ok: true });
      }
      if (url.pathname === '/api/signal') {
        if (room.closed) throw fail(410, '连接已结束。');
        const m = body.message;
        const valid = m && ((m.type === 'offer' && role === 'phone' && typeof m.sdp === 'string') ||
          (m.type === 'answer' && role === 'host' && typeof m.sdp === 'string') ||
          (m.type === 'candidate' && m.candidate && typeof m.candidate.candidate === 'string'));
        if (!valid) throw fail(400, '无效的信令。');
        limit(ip, 'signal', 180);
        send(room, role === 'host' ? 'phone' : 'host', m);
        return reply(200, { ok: true });
      }
      throw fail(404, '未找到。');
    } catch (error) {
      if (!res.headersSent) reply(error.status || 500, { error: error.status ? error.message : '服务器错误。' });
      else res.end();
    }
  };
}

export async function start() {
  const port = Number(process.env.PORT || 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535。');
  const addresses = Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  const hosts = ['localhost', '127.0.0.1', ...addresses, ...(process.env.ALLOWED_HOSTS || '').split(',').filter(Boolean)];
  const cert = await readFile(process.env.TLS_CERT || path.join(root, 'certs', 'server.pem'));
  const key = await readFile(process.env.TLS_KEY || path.join(root, 'certs', 'server-key.pem'));
  const server = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, createHandler({ hosts }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`PocketCam PC: https://localhost:${port}`);
    for (const address of addresses) console.log(`iPhone Safari: https://${address}:${port}/?mode=phone`);
    console.log('摄像头画面通过 WebRTC 传输；请保持 iPhone 页面前台运行。');
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => {
    console.error(error.code === 'ENOENT' ? '缺少 HTTPS 证书。请先阅读 README 并完成证书配置。' : error.message);
    process.exitCode = 1;
  });
}
