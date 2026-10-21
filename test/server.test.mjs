import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler } from '../server.mjs';

async function fixture(t) {
  let clock = Date.now();
  const server = http.createServer(createHandler({ now: () => clock }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body = {}, session = null, extra = {}) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: {
      Origin: base, 'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...extra
    }, body: JSON.stringify({ ...body, ...(session ? { roomId: session.roomId } : {}) }) });
    return { status: response.status, data: await response.json() };
  };
  return { base, call, advance: ms => { clock += ms; } };
}

test('pairing is single-use; messages survive repeated polls and role tokens are isolated', async t => {
  const { call } = await fixture(t);
  const { data: host, status: created } = await call('create'); assert.equal(created, 201);
  assert.match(host.code, /^\d{8}$/);
  const { data: phone, status: joined } = await call('join', { code: host.code }); assert.equal(joined, 200);
  assert.equal(phone.roomId, host.roomId); assert.notEqual(phone.token, host.token);
  assert.equal((await call('join', { code: host.code })).status, 404);
  assert.equal((await call('signal', { message: { type: 'offer', sdp: 'test-offer' } }, phone)).status, 200);
  const first = await call('poll', { after: 0 }, host);
  const repeat = await call('poll', { after: 0 }, host);
  assert.deepEqual(first.data, repeat.data);
  assert.deepEqual(first.data.messages.map(item => item.message.type), ['joined', 'offer']);
  const last = first.data.messages.at(-1).id;
  assert.deepEqual((await call('poll', { after: last }, host)).data.messages, []);
  assert.deepEqual((await call('poll', { after: 0 }, phone)).data.messages, []);
  assert.equal((await call('poll', { after: 0 }, { ...host, token: 'wrong' })).status, 401);
  assert.equal((await call('poll', { roomId: host.roomId, after: 0 })).status, 401);
});

test('roles may only send their own SDP; leave blocks further signaling', async t => {
  const { call } = await fixture(t);
  const { data: host } = await call('create');
  const { data: phone } = await call('join', { code: host.code });
  assert.equal((await call('signal', { message: { type: 'offer', sdp: 'x' } }, host)).status, 400);
  assert.equal((await call('signal', { message: { type: 'answer', sdp: 'x' } }, phone)).status, 400);
  assert.equal((await call('signal', { message: { type: 'answer', sdp: 'answer' } }, host)).status, 200);
  assert.equal((await call('signal', { message: { type: 'candidate', candidate: { candidate: 'candidate:test' } } }, phone)).status, 200);
  assert.equal((await call('leave', {}, host)).status, 200);
  assert.ok((await call('poll', { after: 0 }, phone)).data.messages.some(x => x.message.type === 'ended'));
  assert.equal((await call('signal', { message: { type: 'offer', sdp: 'x' } }, phone)).status, 410);
});

test('cross-origin and untrusted Host requests are refused', async t => {
  const { base, call } = await fixture(t);
  assert.equal((await call('create', {}, null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('create', {}, null, { Origin: '' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
});

test('one room cannot read another room with its own token', async t => {
  const { call } = await fixture(t);
  const { data: a } = await call('create'); const { data: b } = await call('create');
  assert.equal((await call('poll', { after: 0 }, { roomId: b.roomId, token: a.token })).status, 401);
});

test('pair codes expire even if the PC keeps polling', async t => {
  const { call, advance } = await fixture(t);
  const { data: host } = await call('create');
  advance(9 * 60_000); await call('poll', { after: 0 }, host);
  advance(2 * 60_000);
  assert.equal((await call('join', { code: host.code })).status, 404);
});

test('idle sessions expire and attempts are rate limited then recover', async t => {
  const { call, advance } = await fixture(t);
  const { data: host } = await call('create');
  for (let i = 0; i < 8; i++) assert.equal((await call('join', { code: '00000000' })).status, 404);
  assert.equal((await call('join', { code: host.code })).status, 429);
  advance(61_000); assert.equal((await call('join', { code: host.code })).status, 200);
  advance(11 * 60_000); assert.equal((await call('poll', { after: 0 }, host)).status, 401);
});

test('serves only app assets; certificates and source cannot be fetched', async t => {
  const { base } = await fixture(t);
  const page = await fetch(base); assert.equal(page.status, 200);
  assert.match(await page.text(), /PocketCam/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const route of ['/certs/server-key.pem', '/server.mjs', '/package.json', '/missing', '/..%2Fserver.mjs'])
    assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/app.js')).status, 200);
});

test('rejects invalid cursors, malformed JSON and oversized bodies', async t => {
  const { base, call } = await fixture(t);
  const { data: host } = await call('create');
  assert.equal((await call('poll', { after: -1 }, host)).status, 400);
  const raw = body => fetch(base + '/api/create', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal((await raw('null')).status, 400);
  assert.equal((await raw('{')).status, 400);
  assert.equal((await raw(JSON.stringify({ text: 'x'.repeat(70_000) }))).status, 413);
});
