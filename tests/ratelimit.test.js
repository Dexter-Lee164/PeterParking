'use strict';
process.env.LOGIN_RATE_LIMIT_MAX = '3';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, Client } = require('./helpers');

test('repeated failed sign-ins are rate limited', async () => {
  const app = await start();
  const c = new Client(app.base);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await c.post('/login', { email: 'maria@university.test', password: 'wrong-pass-1' })).status);
  assert.deepEqual(codes.slice(0, 3), [401, 401, 401]);
  assert.equal(codes[3], 429); assert.equal(codes[4], 429);
  await app.close();
});
