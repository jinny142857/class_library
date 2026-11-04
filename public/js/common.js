// 공통 유틸: API 호출, HTML 이스케이프, 날짜 표시

export class ApiError extends Error {
  constructor(status, err) {
    super(err?.message || '오류가 발생했어요.');
    this.status = status;
    this.code = err?.code;
    this.hint = err?.hint;
    this.extra = err?.extra;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WD = '일월화수목금토';
export function fmtDate(d, { year = false } = {}) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  const w = WD[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${year ? y + '년 ' : ''}${m}월 ${day}일 (${w})`;
}
export function fmtShort(d) {
  if (!d) return '';
  const [, m, day] = d.slice(0, 10).split('-').map(Number);
  return `${m}/${day}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }
