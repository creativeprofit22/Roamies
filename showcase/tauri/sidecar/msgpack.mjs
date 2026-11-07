// Just enough MessagePack for Fish Audio's live TTS socket: maps, arrays, strings, numbers, booleans, null and
// binary. Not a general library (no extension types, no 64-bit ints past 2^53).
const te = new TextEncoder(), td = new TextDecoder();

export function encode(value) {
  const out = [];
  const u8 = (...b) => out.push(...b);
  const be = (n, bytes) => { for (let i = bytes - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff); };
  const len = (n, small, base, tags) => {
    if (small != null && n < small) return u8(base + n);
    if (n < 0x100 && tags[0] != null) return u8(tags[0], n);
    if (n < 0x10000) return (u8(tags[1]), be(n, 2));
    return (u8(tags[2]), be(n, 4));
  };
  const put = (v) => {
    if (v === null || v === undefined) return u8(0xc0);
    if (v === false) return u8(0xc2);
    if (v === true) return u8(0xc3);
    if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= 0 && v < 2 ** 32) {
        if (v < 0x80) return u8(v);
        if (v < 0x100) return u8(0xcc, v);
        if (v < 0x10000) return (u8(0xcd), be(v, 2));
        return (u8(0xce), be(v, 4));
      }
      if (Number.isInteger(v) && v < 0 && v >= -(2 ** 31)) {
        if (v >= -32) return u8(v & 0xff);
        const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, v);
        return u8(0xd2, ...new Uint8Array(b.buffer));
      }
      const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v);
      return u8(0xcb, ...new Uint8Array(b.buffer));
    }
    if (typeof v === 'string') { const b = te.encode(v); len(b.length, 32, 0xa0, [0xd9, 0xda, 0xdb]); for (const x of b) out.push(x); return; }
    if (v instanceof Uint8Array) { len(v.length, null, 0, [0xc4, 0xc5, 0xc6]); for (const x of v) out.push(x); return; }
    if (Array.isArray(v)) { len(v.length, 16, 0x90, [null, 0xdc, 0xdd]); v.forEach(put); return; }
    if (typeof v === 'object') {
      const e = Object.entries(v).filter(([, x]) => x !== undefined);
      len(e.length, 16, 0x80, [null, 0xde, 0xdf]);
      for (const [k, x] of e) { put(k); put(x); }
      return;
    }
    throw new TypeError(`msgpack: can't encode ${typeof v}`);
  };
  put(value);
  return Uint8Array.from(out);
}

export function decode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new RangeError('msgpack: truncated'); };
  const str = (n) => { need(n); const s = td.decode(b.subarray(i, i + n)); i += n; return s; };
  const bin = (n) => { need(n); const s = b.slice(i, i + n); i += n; return s; };
  const arr = (n) => { const a = []; for (let k = 0; k < n; k++) a.push(get()); return a; };
  const map = (n) => { const o = {}; for (let k = 0; k < n; k++) { const key = get(); o[key] = get(); } return o; };
  const get = () => {
    need(1);
    const t = b[i++];
    if (t < 0x80) return t;
    if (t >= 0xe0) return t - 0x100;
    if ((t & 0xf0) === 0x80) return map(t & 0x0f);
    if ((t & 0xf0) === 0x90) return arr(t & 0x0f);
    if ((t & 0xe0) === 0xa0) return str(t & 0x1f);
    const n8 = () => (need(1), b[i++]), n16 = () => (need(2), (i += 2), dv.getUint16(i - 2)), n32 = () => (need(4), (i += 4), dv.getUint32(i - 4));
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(n8());
      case 0xc5: return bin(n16());
      case 0xc6: return bin(n32());
      case 0xca: need(4); i += 4; return dv.getFloat32(i - 4);
      case 0xcb: need(8); i += 8; return dv.getFloat64(i - 8);
      case 0xcc: return n8();
      case 0xcd: return n16();
      case 0xce: return n32();
      case 0xcf: need(8); i += 8; return Number(dv.getBigUint64(i - 8));
      case 0xd0: need(1); i += 1; return dv.getInt8(i - 1);
      case 0xd1: need(2); i += 2; return dv.getInt16(i - 2);
      case 0xd2: need(4); i += 4; return dv.getInt32(i - 4);
      case 0xd3: need(8); i += 8; return Number(dv.getBigInt64(i - 8));
      case 0xd9: return str(n8());
      case 0xda: return str(n16());
      case 0xdb: return str(n32());
      case 0xdc: return arr(n16());
      case 0xdd: return arr(n32());
      case 0xde: return map(n16());
      case 0xdf: return map(n32());
      default: throw new TypeError(`msgpack: unsupported type 0x${t.toString(16)}`);
    }
  };
  return get();
}
