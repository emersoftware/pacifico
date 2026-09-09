/** Decodes wire fields without guessing a vendor's message schema. */
export interface WireField {
  number: number;
  value: bigint | Uint8Array;
}

/** Returns null for truncated or unsupported records; callers retain the original bytes. */
export function wireFields(bytes: Uint8Array): WireField[] | null {
  let offset = 0;
  const fields: WireField[] = [];
  function varint(): bigint | null {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < bytes.length; shift += 7n) {
      const byte = bytes[offset++]!;
      if (shift === 63n && byte > 1) return null;
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    return null;
  }
  while (offset < bytes.length) {
    const tag = varint();
    if (tag === null || tag < 8n || tag > 0xffffffffn) return null;
    const number = Number(tag >> 3n);
    const type = Number(tag & 7n);
    if (type === 0) {
      const value = varint();
      if (value === null) return null;
      fields.push({ number, value });
      continue;
    }
    let size: number;
    if (type === 1) size = 8;
    else if (type === 5) size = 4;
    else if (type === 2) {
      const length = varint();
      if (length === null || length > BigInt(bytes.length - offset)) return null;
      size = Number(length);
    } else return null;
    if (offset + size > bytes.length) return null;
    fields.push({ number, value: bytes.subarray(offset, offset + size) });
    offset += size;
  }
  return fields;
}
