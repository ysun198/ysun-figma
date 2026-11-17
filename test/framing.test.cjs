const assert = require('node:assert/strict');
const test = require('node:test');
const { frameReader } = require('../src/host/framing.cjs');

for (const delimiter of [0, 10]) {
  test(
    'all byte partitions preserve UTF-8, empty and exactly full frames for delimiter ' +
      delimiter,
    () => {
      const mark = String.fromCharCode(delimiter);
      const bytes = Buffer.from(['文', 'abcd', '', 'x', ''].join(mark));
      for (let cuts = 0; cuts < 2 ** (bytes.length - 1); cuts++) {
        const frames = [];
        const read = frameReader(
          delimiter,
          4,
          (part) => frames.push(part.toString()),
          () => assert.fail('unexpected limit'),
        );
        let from = 0;
        for (let i = 1; i <= bytes.length; i++) {
          if (i === bytes.length || cuts & (1 << (i - 1))) {
            read(bytes.subarray(from, i));
            from = i;
          }
        }
        assert.deepEqual(frames, ['文', 'abcd', '', 'x']);
      }
    },
  );
  test(
    'over-limit input is discarded up to its own delimiter, then processing resumes for ' +
      delimiter,
    () => {
      const frames = [],
        mark = String.fromCharCode(delimiter);
      let errors = 0;
      const read = frameReader(
        delimiter,
        4,
        (b) => frames.push(b.toString()),
        () => errors++,
      );
      read(Buffer.from('12345'));
      read(
        Buffer.from(
          '67890' + mark + '好' + mark + '12345' + mark + 'OK' + mark,
        ),
      );
      assert.equal(errors, 2);
      assert.deepEqual(frames, ['好', 'OK']);
    },
  );
}
