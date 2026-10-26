'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numericCount, countFromContext, readAudienceCount } = require('../app/preload/live-audience');
const context = (value, hidden = false) => ({ roomStore: { roomInfo: { room: { room_view_stats: { display_value: value, is_hidden: hidden } } } } });

test('only non-negative exact safe integers are audience counts', () => {
  for (const value of [0, 91234, '91234']) assert.equal(numericCount(value), Number(value));
  for (const value of [null, undefined, '', '9万', '9万+', '90,000', NaN, Infinity, -1, 1.5, true, Number.MAX_SAFE_INTEGER + 1]) assert.equal(numericCount(value), null);
});
test('supports current consumed-context and legacy provider stores', () => {
  assert.equal(countFromContext(context(91234)), 91234);
  assert.equal(countFromContext({ store: context('92345') }), 92345);
  assert.equal(countFromContext({ current: context(45) }), 45);
  assert.equal(countFromContext(context(91234, true)), null);
  assert.equal(countFromContext({ roomStore: { roomInfo: { room: { user_count_str: '9万' } } } }), null);
});
test('finds the current live page context chain and observes data updates', () => {
  const store = context(91234);
  const parent = { dependencies: { firstContext: { memoizedValue: {}, next: { memoizedValue: store } } } };
  const el = { '__reactFiber$test': { return: parent } };
  assert.equal(readAudienceCount(el), 91234);
  store.roomStore.roomInfo.room.room_view_stats.display_value = 93456;
  assert.equal(readAudienceCount(el), 93456);
  el.__reactFiber$test = { memoizedProps: { value: { store: context(45678) } } };
  assert.equal(readAudienceCount(el), 45678);
});
test('walks safely through cycles and tolerates unavailable React state', () => {
  const fiber = { dependencies: { firstContext: {} } };
  fiber.return = fiber;
  fiber.dependencies.firstContext.next = fiber.dependencies.firstContext;
  assert.equal(readAudienceCount({ '__reactFiber$test': fiber }), null);
  assert.equal(readAudienceCount({}), null);
});
