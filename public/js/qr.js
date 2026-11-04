// 외부 라이브러리 없는 QR코드 생성기 (바이트 모드, 오류 정정 M, 버전 1~10 → 최대 213바이트)
// 브라우저와 Node 양쪽에서 사용 가능한 ES 모듈.

// [총 코드워드, 블록당 EC, 그룹1 블록수, 그룹1 데이터, 그룹2 블록수, 그룹2 데이터]
const EC_M = [null,
  [26, 10, 1, 16, 0, 0], [44, 16, 1, 28, 0, 0], [70, 26, 1, 44, 0, 0], [100, 18, 2, 32, 0, 0],
  [134, 24, 2, 43, 0, 0], [172, 16, 4, 27, 0, 0], [196, 18, 4, 31, 0, 0], [242, 22, 2, 38, 2, 39],
  [292, 22, 3, 36, 2, 37], [346, 26, 4, 43, 1, 44]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) 연산
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const n = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= gmul(g[j], EXP[i]); }
    g = n;
  }
  return g;
}
function rsEncode(data, deg) {
  const gen = rsGenerator(deg);
  const res = new Array(deg).fill(0);
  for (const b of data) {
    const f = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < deg; i++) res[i] ^= gmul(gen[i + 1], f);
  }
  return res;
}

function utf8(text) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
  return Array.from(Buffer.from(text, 'utf8'));
}

function bch(value, poly, polyDeg) {
  let v = value << polyDeg;
  const top = 31 - Math.clz32(poly);
  while (31 - Math.clz32(v) >= top && v) v ^= poly << ((31 - Math.clz32(v)) - top);
  return (value << polyDeg) | v;
}

export function qrMatrix(text) {
  const bytes = utf8(String(text));
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const [, , b1, d1, b2, d2] = EC_M[v];
    const cap = b1 * d1 + b2 * d2;
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= cap * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('QR 데이터가 너무 깁니다.');
  const [, ecLen, b1, d1, b2, d2] = EC_M[ver];
  const dataCap = b1 * d1 + b2 * d2;

  // 데이터 비트열
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < dataCap; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  // 블록 분할 + RS + 인터리브
  const blocks = [];
  let k = 0;
  for (let i = 0; i < b1; i++) { blocks.push(data.slice(k, k + d1)); k += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(data.slice(k, k + d2)); k += d2; }
  const ecs = blocks.map(b => rsEncode(b, ecLen));
  const final = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) final.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) final.push(e[i]);

  // 모듈 배치
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v ? 1 : 0; fn[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  // 포맷 정보 영역 예약
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, 0); if (!fn[i][8]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
  set(size - 8, 8, 1); // dark module
  // 버전 정보 (7 이상)
  if (ver >= 7) {
    const vbits = bch(ver, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const a = Math.floor(i / 3), b = size - 11 + (i % 3);
      set(a, b, bit); set(b, a, bit);
    }
  }

  // 데이터 비트 지그재그 배치
  const dataBits = [];
  for (const byte of final) for (let i = 7; i >= 0; i--) dataBits.push((byte >> i) & 1);
  let idx = 0, up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (fn[r][c]) continue;
        m[r][c] = idx < dataBits.length ? dataBits[idx++] : 0;
      }
    }
    up = !up;
  }

  // 마스크 선택
  const masks = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  let best = null, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const t = m.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r][c] && masks[mk](r, c)) t[r][c] ^= 1;
    drawFormat(t, size, mk);
    const s = penalty(t, size);
    if (s < bestScore) { bestScore = s; best = t; }
  }
  return best;
}

function drawFormat(t, size, mask) {
  const f = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412; // EC 레벨 M = 00
  const bit = i => (f >> i) & 1;
  // t[행][열]
  for (let i = 0; i <= 5; i++) t[i][8] = bit(i);
  t[7][8] = bit(6); t[8][8] = bit(7); t[8][7] = bit(8);
  for (let i = 9; i < 15; i++) t[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) t[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) t[size - 15 + i][8] = bit(i);
  t[size - 8][8] = 1;
}

function penalty(t, n) {
  let s = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      const line = [];
      for (let j = 0; j < n; j++) line.push(pass ? t[j][i] : t[i][j]);
      for (let j = 1; j <= n; j++) {
        if (j < n && line[j] === line[j - 1]) run++;
        else { if (run >= 5) s += run - 2; run = 1; }
      }
      const str = line.join('');
      for (const p of ['10111010000', '00001011101']) { let k = str.indexOf(p); while (k !== -1) { s += 40; k = str.indexOf(p, k + 1); } }
    }
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = t[r][c];
    if (v === t[r + 1][c] && v === t[r][c + 1] && v === t[r + 1][c + 1]) s += 3;
  }
  let dark = 0;
  for (const row of t) for (const v of row) dark += v;
  s += Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
  return s;
}

export function qrSvg(text, { margin = 4, color = '#000' } = {}) {
  const m = qrMatrix(text);
  const n = m.length + margin * 2;
  let d = '';
  m.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + margin} ${r + margin}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="${color}"/></svg>`;
}
