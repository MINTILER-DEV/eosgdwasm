"""Use WebGL2 upload ranges without allocating per-draw typed-array views."""


def patch_uploads(loader):
    replacements = {
        'GLctx.bufferData(target, data ? HEAPU8.subarray(data >>> 0, data + size >>> 0) : size, usage);':
        '''if (data && size) GLctx.bufferData(target, HEAPU8, usage, data, size);
  else GLctx.bufferData(target, size, usage);''',
        'GLctx.bufferSubData(target, offset, HEAPU8.subarray(data >>> 0, data + size >>> 0));':
        'if (size) GLctx.bufferSubData(target, offset, HEAPU8, data, size);',
        'GLctx.bufferSubData(34962, 0, HEAPU8.subarray(cb.ptr >>> 0, cb.ptr + size >>> 0));':
        'if (size) GLctx.bufferSubData(34962, 0, HEAPU8, cb.ptr >>> 0, size);',
        'GLctx.bufferSubData(34963, 0, HEAPU8.subarray(indices >>> 0, indices + size >>> 0));':
        'if (size) GLctx.bufferSubData(34963, 0, HEAPU8, indices, size);',
    }
    # WebGL2 treats a zero source length as "the rest of the source array".
    # Keep empty allocations empty, and make zero-byte updates no-ops instead
    # of accidentally submitting the entire WASM heap to the GPU.
    for before, after in replacements.items():
        if before in loader:
            assert loader.count(before) == 1, before
            loader = loader.replace(before, after)
        else:
            assert loader.count(after) == 1, 'Unexpected upload glue: ' + before
    old_comment = """  // N.b. here first form specifies a heap subarray, second form an integer
  // size, so the ?: code here is polymorphic. It is advised to avoid
  // randomly mixing both uses in calling code, to avoid any potential JS
  // engine JIT issues.
"""
    new_comment = """  // WebGL2 accepts a source range directly, without a temporary heap view.
  // A zero length means the rest of the source, so allocate empty data by size.
"""
    if old_comment in loader:
        loader = loader.replace(old_comment, new_comment)
    return loader
