Input presses and releases now resolve the game's pending JSPI frame wait
immediately. The game polls its existing ordered Win32-message queue when it
resumes, after the current browser event handler finishes. This removes the
additional wait for the next `requestAnimationFrame` callback; it does not
bypass game physics or synthesize extra presses. Idle rendering still follows
the display refresh rate. Pointer movement remains coalesced and does not
request extra frames.

Keyboard, mouse, pen, touch, wheel, and focus-loss releases use the same wake
path. Each wait resolves once, cancelling its animation callback and watchdog.
Hidden pages retain the existing 50 ms sleep. Latency telemetry is disabled
during normal gameplay unless `?perf` or a benchmark is active. Input percentile sorting runs periodically during frame
accounting instead of inside each input poll. The WebGL context requests the browser's high-performance GPU preference.

The repository ships compiled WASM and compressed Emscripten glue rather than
native build sources. `python3 tools/update-loader.py` patches/repackages that
glue, updates its content-addressed filename and manifest, and refreshes script
cache versions. Run it after changing `gd_input.js` or `gd_frame.js`. The WASM
and game data are unchanged.

Validation:

- `node --test tests/input-latency.test.cjs` checks immediate wake, release
  ordering, mouse/touch/pen, movement coalescing, blur, hidden-page throttling,
  and stale callbacks in uncapped mode.
- With Playwright installed and the repository served over HTTP, run
  `node tests/browser-input.cjs http://127.0.0.1:8765/` to boot the actual game,
  withhold display callbacks, and verify that keyboard press/release edges
  still reach WASM. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can select existing
  local installations.
- Open `?perf` for frame and event-to-game-poll statistics. Compare with
  `?perf&inputwake=0` to disable input-triggered wakes. The existing `?fastframe`
  option still yields through MessageChannel for uncapped rendering.

A headless Chromium run against the packaged game consumed keyboard press
and release with display callbacks withheld, reporting 0.8 ms and 0.5 ms
event-to-poll delays. These are synthetic test results, not hardware latency
guarantees.

Queue measurements exclude hardware/OS delivery, game simulation, GPU work,
compositing, and display scanout. They are not click-to-photon measurements.
A busy main thread must still finish its current WASM task before a browser
input handler can run.

Rendering allocation reduction:

The WebGL2 glue now passes the current WASM heap with explicit byte offsets
and lengths to buffer uploads, including emulated client-side vertex/index
arrays. It avoids creating a typed-array subview for every upload. Empty
updates remain no-ops, empty allocations stay empty, and replacement heaps
following WASM memory growth are read at each call. Run
`node --test tests/*.test.cjs` for range and input regression tests. The browser
test also reads uploaded bytes back from a real WebGL2 buffer.

This reduces JavaScript allocation pressure that can contribute to frame
stalls. It does not prove that garbage collection causes a particular user's
intermittent delay. Frame stalls can also postpone browser event delivery;
immediate queue wakeups cannot interrupt an already running WASM/render task.

In two similar 17-second headless Chromium menu profiles, heap subview calls
fell from 29,184 across 321 game-loop iterations to 248 across 325 iterations.
This is an allocation-count comparison, not proof of eliminated frame hitches
or a controlled FPS benchmark. Headless software rendering differs from a
player's hardware/browser setup.

The upload range API is documented in the
[WebGL2 bufferSubData reference](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/bufferSubData).
