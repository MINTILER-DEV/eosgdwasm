#!/usr/bin/env python3
"""Repackage the shipped Emscripten glue; no native build sources are in this repo.

The WASM and game data remain byte-for-byte unchanged. Fail on unexpected glue
rather than silently publishing a package without the frame-wait integration.
"""
import gzip
import hashlib
import json
from pathlib import Path
from webgl_uploads import patch_uploads

ROOT = Path(__file__).resolve().parents[1]
manifest_path = ROOT / 'gd_assets.json'
m = json.loads(manifest_path.read_text())
old_path = ROOT / m['loader']['url']
loader = gzip.decompress(old_path.read_bytes()).decode()
start = loader.index('function __asyncjs__gd_js_yield_frame(target_ms) {')
end = loader.index('\n__asyncjs__gd_js_yield_frame.sig', start)
loader = loader[:start] + '''function __asyncjs__gd_js_yield_frame(target_ms) {
  return Asyncify.handleAsync(() => Module.gdYieldFrame());
}
''' + loader[end:]
# Prefer a GPU suited to the game's fixed 1920x1080 framebuffer. This is a
# browser hint, and does not change game timing or context correctness.
needle = 'var ctx = canvas.getContext("webgl2", webGLContextAttributes);'
if 'webGLContextAttributes.powerPreference = "high-performance";' not in loader:
    assert loader.count(needle) == 1
    loader = loader.replace(needle, 'webGLContextAttributes.powerPreference = "high-performance";\n    ' + needle)
loader = patch_uploads(loader)
raw = loader.encode()
digest = hashlib.sha256(raw).hexdigest()
url = 'payload/loader-' + digest[:24] + '.gz'
compressed = gzip.compress(raw, compresslevel=9, mtime=0)
(ROOT / url).write_bytes(compressed)
m['loader'] = dict(url=url, size=len(raw), compressedSize=len(compressed), sha256=digest)
for name in ('gd_assets.js', 'gd_input.js', 'gd_frame.js'):
    m['supportFiles'][name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
old_build = m['build']
m['build'] = hashlib.sha256(json.dumps({k:v for k,v in m.items() if k != 'build'}, sort_keys=True).encode()).hexdigest()[:24]
manifest_path.write_text(json.dumps(m, separators=(',', ':')) + '\n')
html_path = ROOT / 'index.html'
html = html_path.read_text().replace(old_build, m['build'])
if '<script src="gd_frame.js?' not in html:
    html = html.replace('<script src="gd_input.js?', '<script src="gd_frame.js?v=' + m['build'] + '"></script><script src="gd_input.js?')
html_path.write_text(html)
if old_path != ROOT / url:
    old_path.unlink()
print(url, m['build'])
