import { describe, expect, test } from 'bun:test';
import { wireFields } from './protobuf';

describe('native protobuf wire records', () => {
  test('retains field order, repeated values, and exact 64-bit integers', () => {
    const bytes = Uint8Array.from([10, 2, 65, 66, 16, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1, 10, 0]);
    expect(wireFields(bytes)).toEqual([
      { number: 1, value: Uint8Array.from([65, 66]) },
      { number: 2, value: 18446744073709551615n },
      { number: 1, value: new Uint8Array() },
    ]);
  });

  test('rejects incomplete writes instead of returning a partial message', () => {
    for (const bytes of [[10], [10, 3, 65], [8, 128], [9, 1], [13, 1], [0], [11], [8, ...Array(10).fill(255)]]) {
      expect(wireFields(Uint8Array.from(bytes))).toBeNull();
    }
  });

  test('does not interpret fixed-width data as nested messages', () => {
    expect(wireFields(Uint8Array.from([13, 0, 1, 2, 3]))).toEqual([
      { number: 1, value: Uint8Array.from([0, 1, 2, 3]) },
    ]);
  });
});
