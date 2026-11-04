// 한국 시간(KST) 기준 날짜/시각 유틸리티.
// 테스트·시연용으로 FAKE_TODAY=YYYY-MM-DD 환경변수를 주면 그 날짜를 "오늘"로 사용한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function nowISO() {
  if (process.env.FAKE_TODAY) {
    // 가짜 날짜 + 실제 시각
    const real = new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(10, 19);
    return new Date(`${process.env.FAKE_TODAY}${real}+09:00`).toISOString();
  }
  return new Date().toISOString();
}

export function todayKST() {
  if (process.env.FAKE_TODAY) return process.env.FAKE_TODAY;
  return toKSTDate(new Date());
}

export function toKSTDate(dateOrIso) {
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' 문자열 날짜 연산 (시간대 영향 없음)
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=일 ... 6=토
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
