// Decode one delimited byte stream. The limit applies to each frame, including
// fragments spread over reads. Complete frames are borrowed during onFrame.
function frameReader(delimiter, limit, onFrame, onOversize) {
  let storage,
    size = 0,
    discarding = false;
  function append(part, length) {
    if (!storage || length > storage.length) {
      const next = Buffer.allocUnsafe(
        Math.min(limit, Math.max(length, (storage?.length || 256) * 2)),
      );
      if (size) storage.copy(next, 0, 0, size);
      storage = next;
    }
    part.copy(storage, size);
    size = length;
  }
  return (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(delimiter, start);
      const part = bytes.subarray(start, end < 0 ? bytes.length : end);
      const length = size + part.length;
      if (!discarding && length > limit) {
        discarding = true;
        storage = undefined;
        size = 0;
        onOversize();
      }
      if (!discarding) {
        if (!size && end >= 0) onFrame(part);
        else {
          append(part, length);
          if (end >= 0) onFrame(storage.subarray(0, size));
        }
      }
      if (end < 0) return;
      start = end + 1;
      size = 0;
      storage = undefined;
      discarding = false;
    }
  };
}
module.exports = { frameReader };
