const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(search = '?perf') {
  let id = 0, clock = 1;
  const raf = new Map(), timers = new Map(), listeners = new Map();
  const canvas = {
    width: 1920, height: 1080,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 1920, height: 1080}),
    focus() {}, setPointerCapture() {},
    addEventListener(name, fn) { listeners.set('canvas:' + name, fn); }
  };
  const document = {hidden: false, activeElement: canvas,
    addEventListener(name, fn) { listeners.set('document:' + name, fn); }};
  const Module = {canvas, gdInputQueue: [], gdCursorPos: [0, 0]};
  const context = vm.createContext({Module, document, location: {search}, URLSearchParams,
    performance: {now: () => clock},
    requestAnimationFrame(fn) { raf.set(++id, fn); return id; },
    cancelAnimationFrame(id) { raf.delete(id); },
    setTimeout(fn, ms) { timers.set(++id, {fn, ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    MessageChannel: class {
      constructor() {
        this.port1 = {};
        this.port2 = {postMessage: () => { this.run = () => this.port1.onmessage(); }};
        channels.push(this);
      }
    }
  });
  const channels = [];
  context.window = context;
  context.__gdInputReady = true;
  context.addEventListener = (name, fn) => listeners.set('window:' + name, fn);
  for (const file of ['gd_frame.js', 'gd_input.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  function event(name, data = {}) {
    listeners.get(name)({timeStamp: clock, code: 'Space', key: ' ', keyCode: 32,
      target: canvas, preventDefault() {}, clientX: 100, clientY: 200,
      pointerType: 'mouse', pointerId: 1, button: 0, ...data});
  }
  return {Module, document, event, raf, timers, channels,
    advance(ms) { clock += ms; },
    frame() { for (const fn of [...raf.values()]) fn(); }};
}

test('press wakes JSPI wait before display tick; release wakes the next wait', async () => {
  const h = setup();
  let resumes = 0;
  const wait = h.Module.gdYieldFrame().then(() => resumes++);
  h.advance(3);
  h.event('window:keydown');
  await wait; // No animation frame was dispatched.
  assert.equal(resumes, 1);
  assert.equal(h.raf.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.Module.gdPollInput()[0], 0x100);
  assert.equal(h.Module.gdPollInput()[0], 0x102);
  assert.equal(h.Module.gdPollInput(), null);
  assert.equal(h.Module.gdInputStats.queueMs, 0);
  const release = h.Module.gdYieldFrame();
  h.event('window:keyup');
  await release;
  assert.equal(h.Module.gdPollInput()[0], 0x101);
  assert.equal(h.Module.gdKeyState[32], 0);
});

test('rapid keyboard edges retain order and complete a wait only once', async () => {
  const h = setup();
  let resumes = 0;
  const wait = h.Module.gdYieldFrame().then(() => resumes++);
  h.event('window:keydown'); h.event('window:keyup'); h.event('window:keydown');
  await wait;
  assert.equal(resumes, 1);
  const messages = [];
  for (let e; (e = h.Module.gdPollInput());) messages.push(e[0]);
  assert.deepEqual(messages, [0x100, 0x102, 0x101, 0x100, 0x102]);
});

for (const pointerType of ['mouse', 'touch', 'pen']) {
  test(`${pointerType} down/up interrupt waits without losing button edges`, async () => {
    const h = setup();
    let wait = h.Module.gdYieldFrame();
    h.event('canvas:pointerdown', {pointerType, buttons: 1});
    await wait;
    const messages = [];
    for (let e; (e = h.Module.gdPollInput());) messages.push(e[0]);
    assert.ok(messages.includes(0x201));
    wait = h.Module.gdYieldFrame();
    h.event('canvas:pointerup', {pointerType, buttons: 0});
    await wait;
    assert.equal(h.Module.gdPollInput()[0], 0x202);
    assert.equal(h.Module.gdKeyState[1], 0);
  });
}

test('pointer movement coalesces without scheduling extra game frames', async () => {
  const h = setup();
  let resumed = false;
  const wait = h.Module.gdYieldFrame().then(() => resumed = true);
  for (let i = 0; i < 100; i++) h.event('canvas:pointermove', {buttons: 0, clientX: i});
  await Promise.resolve();
  assert.equal(resumed, false);
  assert.equal(h.Module.gdInputQueue.length, 1);
  h.frame(); await wait;
  assert.equal(h.timers.size, 0);
});

test('blur releases held keys; hidden pages retain a bounded sleep', async () => {
  const h = setup();
  h.event('window:keydown');
  const wait = h.Module.gdYieldFrame();
  h.event('window:blur'); await wait;
  assert.equal(h.Module.gdKeyState[32], 0);
  assert.equal(h.Module.gdInputQueue.at(-1)[0], 0x101);
  h.document.hidden = true;
  let resumed = false;
  const hidden = h.Module.gdYieldFrame().then(() => resumed = true);
  h.Module.gdWakeInput(); await Promise.resolve();
  assert.equal(resumed, false);
  assert.equal(h.raf.size, 0);
  assert.equal([...h.timers.values()][0].ms, 50);
  [...h.timers.values()][0].fn(); await hidden;
});

test('baseline switch keeps input queued until the frame', async () => {
  const h = setup('?perf&inputwake=0');
  let resumed = false;
  const wait = h.Module.gdYieldFrame().then(() => resumed = true);
  h.event('window:keydown'); await Promise.resolve();
  assert.equal(resumed, false);
  h.advance(16); h.frame(); await wait;
  h.Module.gdPollInput();
  assert.equal(h.Module.gdInputStats.queueMs, 16);
});

test('uncapped mode still yields browser tasks', async () => {
  const h = setup('?fastframe');
  const wait = h.Module.gdYieldFrame();
  assert.equal(h.channels.length, 1);
  assert.equal(h.raf.size, 0);
  h.channels[0].run(); await wait;
  assert.equal(h.timers.size, 0);
});


test('stale uncapped wake cannot resolve a newer wait', async () => {
  const h = setup('?fastframe');
  const first = h.Module.gdYieldFrame();
  h.Module.gdWakeInput(); await first;
  let resumed = false;
  const second = h.Module.gdYieldFrame().then(() => resumed = true);
  h.channels[0].run(); await Promise.resolve();
  assert.equal(resumed, false);
  h.channels[0].run(); await second;
});


test('watchdog wakes stalled display callbacks and stale callbacks are harmless', async () => {
  const h = setup();
  let resumes = 0;
  const wait = h.Module.gdYieldFrame().then(() => resumes++);
  const stale = [...h.raf.values()][0];
  assert.equal([...h.timers.values()][0].ms, 250);
  [...h.timers.values()][0].fn(); await wait;
  const next = h.Module.gdYieldFrame();
  stale(); await Promise.resolve();
  assert.equal(resumes, 1);
  assert.equal(h.raf.size, 1);
  h.frame(); await next;
});


test('normal gameplay avoids latency telemetry work unless requested', async () => {
  const h = setup('');
  const wait = h.Module.gdYieldFrame();
  h.event('window:keydown'); await wait;
  assert.equal(h.Module.gdPollInput()[0], 0x100);
  assert.equal(h.Module.gdInputStats.samples, 0);
  h.Module.gdBeginBenchmark(1000);
  h.Module.gdMeasureFrame();
  h.advance(1001); h.Module.gdMeasureFrame();
  assert.equal(h.Module.gdBenchmark.running, false);
});
