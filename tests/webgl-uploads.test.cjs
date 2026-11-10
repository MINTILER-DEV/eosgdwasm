const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const zlib = require('node:zlib');
const manifest = JSON.parse(fs.readFileSync('gd_assets.json'));
const loader = zlib.gunzipSync(fs.readFileSync(manifest.loader.url)).toString();
function setup() {
  const calls = [];
  const heap = new Uint8Array([10, 20, 30, 40, 50, 60]);
  heap.subarray = () => { throw Error('Upload allocated a temporary view'); };
  const context = vm.createContext({HEAPU8: heap, GLctx: {
    bufferData: (...args) => calls.push(['data', ...args]),
    bufferSubData: (...args) => calls.push(['sub', ...args])
  }});
  for (const name of ['_glBufferData', '_glBufferSubData']) {
    const source = loader.match(new RegExp('function ' + name + '\\([^]*?\\n}'))[0];
    vm.runInContext(source, context);
  }
  return {calls, heap, context};
}

test('buffer uploads pass byte ranges directly from the current heap', () => {
  const {calls, heap, context: c} = setup();
  c._glBufferData(34962, 3, 2, 35048);
  c._glBufferSubData(34962, 7, 2, 1);
  assert.deepEqual(calls, [
    ['data', 34962, heap, 35048, 2, 3], ['sub', 34962, 7, heap, 1, 2]
  ]);
});

test('empty uploads cannot expand into a full-heap upload', () => {
  const {calls, context: c} = setup();
  c._glBufferData(34962, 0, 3, 35048);
  c._glBufferSubData(34962, 0, 0, 3);
  assert.deepEqual(calls, [['data', 34962, 0, 35048]]);
});

test('null data allocates storage without reading the heap', () => {
  const {calls, context: c} = setup();
  c._glBufferData(34962, 1024, 0, 35048);
  assert.deepEqual(calls, [['data', 34962, 1024, 35048]]);
});

test('uploads use the replacement heap after WASM memory growth', () => {
  const {calls, context: c} = setup();
  const grown = c.HEAPU8 = new Uint8Array(12);
  c._glBufferSubData(34962, 0, 2, 3);
  assert.equal(calls[0][3], grown);
});
