/* Requires Playwright and a local HTTP server serving the repository.
 * node tests/browser-input.cjs http://127.0.0.1:8765/
 * PLAYWRIGHT_MODULE / CHROMIUM_PATH can select existing local installations.
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--enable-features=WebAssemblyJSPI']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(process.argv[2] || 'http://127.0.0.1:8765/');
    const fs = require('node:fs'), zlib = require('node:zlib');
    const manifest = JSON.parse(fs.readFileSync('gd_assets.json'));
    const loader = zlib.gunzipSync(fs.readFileSync(manifest.loader.url)).toString();
    const uploadFunctions = ['_glBufferData', '_glBufferSubData'].map(name =>
      loader.match(new RegExp('function ' + name + '\\([^]*?\\n}'))[0]).join('\n');
    const uploadCheck = await page.evaluate(source => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const heap = new Uint8Array([9, 8, 7, 6, 5, 4]);
      const uploads = new Function('GLctx', 'HEAPU8', source +
        '; return {data:_glBufferData, sub:_glBufferSubData};')(gl, heap);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      uploads.data(gl.ARRAY_BUFFER, 4, 1, gl.DYNAMIC_DRAW);
      uploads.sub(gl.ARRAY_BUFFER, 1, 2, 3);
      uploads.sub(gl.ARRAY_BUFFER, 0, 0, 1);
      const bytes = new Uint8Array(4);
      gl.getBufferSubData(gl.ARRAY_BUFFER, 0, bytes);
      uploads.data(gl.ARRAY_BUFFER, 0, 1, gl.DYNAMIC_DRAW);
      const emptySize = gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE);
      const error = gl.getError();
      gl.deleteBuffer(buffer);
      gl.getExtension('WEBGL_lose_context').loseContext();
      return {bytes: Array.from(bytes), emptySize, error};
    }, uploadFunctions);
    assert.deepEqual(uploadCheck, {bytes: [8, 6, 5, 5], emptySize: 0, error: 0});
    await page.locator('#loadFly').click();
    await page.waitForFunction(() => window.__gdInputReady === true, null, {timeout: 240000});
    const result = await page.evaluate(async () => {
      const originalRaf = window.requestAnimationFrame;
      const originalPoll = Module.gdPollInput;
      const held = [], edges = [];
      // Withhold future display callbacks. Input must wake WASM independently.
      window.requestAnimationFrame = callback => { held.push(callback); return 0; };
      Module.gdPollInput = function () {
        const entry = originalPoll();
        if (entry && (entry[0] === 0x100 || entry[0] === 0x101)) {
          edges.push({message: entry[0], delayMs: performance.now() - entry[3]});
        }
        return entry;
      };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        // Move any previously scheduled real display wait onto the held path.
        Module.gdWakeInput();
        const start = performance.now();
        while (!held.length && performance.now() - start < 5000) await sleep(5);
        if (!held.length) throw new Error('Game did not enter frame wait');
        const framesBefore = Module._gd_frames_get();
        const send = type => window.dispatchEvent(new KeyboardEvent(type,
          {code: 'Space', key: ' ', keyCode: 32, bubbles: true, cancelable: true}));
        send('keydown'); await sleep(30);
        send('keyup'); await sleep(30);
        return {framesBefore, framesAfter: Module._gd_frames_get(), edges,
          queued: Module.gdInputQueue.length,
          error: document.getElementById('errOverlay').textContent};
      } finally {
        window.requestAnimationFrame = originalRaf;
        Module.gdPollInput = originalPoll;
        // Let the final pending game wait resume normal display scheduling.
        for (const callback of held) originalRaf(callback);
      }
    });
    assert.deepEqual(errors, []);
    assert.equal(result.error, '');
    assert.deepEqual(result.edges.map(e => e.message), [0x100, 0x101]);
    assert.ok(result.framesAfter > result.framesBefore);
    assert.equal(result.queued, 0);
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
