'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyUrl,
  isByteDanceHost,
  isCustomScheme,
  isDouyinHost,
  isSafeNavigationUrl,
  isWebUrl,
} = require('../app/platform/url-policy');

test('isWebUrl accepts only http and https', () => {
  assert.equal(isWebUrl('https://www.douyin.com/'), true);
  assert.equal(isWebUrl('http://127.0.0.1:8080/x'), true);
  assert.equal(isWebUrl('bytedance://open'), false);
  assert.equal(isWebUrl('snssdk1128://user/profile?uid=1'), false);
  assert.equal(isWebUrl('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(isWebUrl('javascript:alert(1)'), false);
  assert.equal(isWebUrl('not a url'), false);
  assert.equal(isWebUrl(''), false);
  assert.equal(isWebUrl(undefined), false);
});

test('isCustomScheme flags every non-web scheme', () => {
  assert.equal(isCustomScheme('bytedance://x'), true);
  assert.equal(isCustomScheme('tiktok://x'), true);
  assert.equal(isCustomScheme('aweme://x'), true);
  assert.equal(isCustomScheme('douyin://x'), true);
  assert.equal(isCustomScheme('https://douyin.com'), false);
  assert.equal(isCustomScheme('%%%'), false);
});

test('isSafeNavigationUrl blocks anything the OS would have to resolve', () => {
  assert.equal(isSafeNavigationUrl('https://www.douyin.com/'), true);
  assert.equal(isSafeNavigationUrl('about:blank'), true);
  assert.equal(isSafeNavigationUrl('blob:https://www.douyin.com/abc'), true);
  assert.equal(isSafeNavigationUrl('bytedance://open?url=x'), false);
  assert.equal(isSafeNavigationUrl('snssdk1128://x'), false);
  assert.equal(isSafeNavigationUrl('file:///C:/secret.txt'), false);
  assert.equal(isSafeNavigationUrl('mailto:a@b.c'), false);
  assert.equal(isSafeNavigationUrl(''), false);
});

test('classifyUrl separates douyin, bytedance popups, plain web and custom schemes', () => {
  assert.equal(classifyUrl('https://www.douyin.com/video/1').kind, 'douyin');
  assert.equal(classifyUrl('https://douyin.com/').kind, 'douyin');
  assert.equal(classifyUrl('https://live.iesdouyin.com/x').kind, 'douyin');

  assert.equal(classifyUrl('https://www.toutiao.com/x').kind, 'bytedance-popup');
  assert.equal(classifyUrl('https://www.bytedance.com/x').kind, 'bytedance-popup');
  assert.equal(classifyUrl('https://www.ixigua.com/x').kind, 'bytedance-popup');
  assert.equal(classifyUrl('https://p3.douyinpic.com/x').kind, 'bytedance-popup');

  assert.equal(classifyUrl('https://github.com/yhgeo/douyin-desktop').kind, 'web');
  assert.equal(classifyUrl('https://scriptcat.org/x').kind, 'web');

  assert.equal(classifyUrl('bytedance://open').kind, 'custom-scheme');
  assert.equal(classifyUrl('snssdk1128://user').kind, 'custom-scheme');
  assert.equal(classifyUrl('about:blank').kind, 'custom-scheme');
  assert.equal(classifyUrl('garbage').kind, 'invalid');
});

test('host matching does not fall for lookalike domains', () => {
  assert.equal(isDouyinHost('www.douyin.com'), true);
  assert.equal(isDouyinHost('douyin.com'), true);
  assert.equal(isDouyinHost('douyin.com.evil.example'), false);
  assert.equal(isDouyinHost('notdouyin.com'), false);
  assert.equal(isDouyinHost('evil-douyin.com'), false);

  assert.equal(isByteDanceHost('www.toutiao.com'), true);
  assert.equal(isByteDanceHost('toutiao.com.attacker.net'), false);
  assert.equal(isByteDanceHost('faketoutiao.com'), false);
});

test('a lookalike domain is treated as an ordinary external link, never as ByteDance', () => {
  // Guards against over-blocking: only real ByteDance hosts are popup-blocked.
  assert.equal(classifyUrl('https://douyin.com.evil.example/login').kind, 'web');
});
