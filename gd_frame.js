/* Resume the existing JSPI game loop at input edges as well as display ticks.
 * Resolving a promise resumes WASM after the event handler finishes: never call
 * a game export from an input handler (the game may already be suspended).
 */
(function () {
  'use strict';
  var pending = null, fastPort = null, fastQueue = [];
  var query = new URLSearchParams(location.search);
  var inputWake = query.get('inputwake') !== '0';
  Module.gdForceFast = query.has('fastframe');
  Module.gdWakeInput = function () {
    if (inputWake && pending && !document.hidden) pending();
  };
  Module.gdYieldFrame = function () {
    return new Promise(function (resolve) {
      var done = false, raf = null, timer = null;
      function finish() {
        if (done) return;
        done = true;
        if (raf !== null) cancelAnimationFrame(raf);
        if (timer !== null) clearTimeout(timer);
        if (pending === finish) pending = null;
        resolve();
      }
      if (document.hidden) {
        timer = setTimeout(finish, 50);
      } else if (Module.gdForceFast) {
        // Keep the existing opt-in uncapped mode. Yield a task so browser
        // input and paint can run; a resolved promise here would starve them.
        if (!fastPort) {
          var channel = new MessageChannel();
          channel.port1.onmessage = function () {
            var wake = fastQueue.shift();
            if (wake) wake();
          };
          fastPort = channel.port2;
        }
        fastQueue.push(finish);
        fastPort.postMessage(0);
      } else {
        raf = requestAnimationFrame(finish);
        timer = setTimeout(finish, 250);
      }
      pending = finish;
    });
  };
})();
