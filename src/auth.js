// 인증: 관리자 비밀번호(scrypt) + DB 세션. 학생은 QR 토큰으로 로그인하고 미사용 시간이 지나면 세션이 만료된다.
// (neon-vercel-migration 브랜치: Sessions/createAdmin이 async로 바뀜. RateLimiter는 메모리 기반이라 그대로.)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nowISO } from './clock.js';
import { getSettings, audit, get, run } from './db.js';

const ADMIN_IDLE_SECONDS = 4 * 60 * 60;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(h, 'base64');
  const got = scryptSync(pw, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(expected, got);
}

export class Sessions {
  constructor(db) { this.db = db; }

  async create(role, subjectId) {
    const token = randomBytes(32).toString('base64url');
    const now = nowISO();
    if (role === 'student') await run(this.db, "DELETE FROM sessions WHERE role='student'"); // 공용 기기: 학생 세션은 한 번에 하나
    await run(this.db, 'INSERT INTO sessions(token, role, subject_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [token, role, subjectId, now, now]);
    return token;
  }

  // 유효한 세션이면 last_seen 을 갱신하고 반환
  async touch(token, role) {
    if (!token) return null;
    const s = await get(this.db, 'SELECT * FROM sessions WHERE token=? AND role=?', [token, role]);
    if (!s) return null;
    const idle = role === 'student' ? (await getSettings(this.db)).student_idle_seconds : ADMIN_IDLE_SECONDS;
    // last_seen_at은 nowISO() 기준(FAKE_TODAY 반영)으로 저장되므로, 만료 판정도 같은 시계로 비교해야 한다
    // (실제 Date.now()와 섞어 비교하면 FAKE_TODAY와 실제 날짜가 벌어졌을 때 세션이 바로 만료돼 버린다).
    if (Date.parse(nowISO()) - Date.parse(s.last_seen_at) > idle * 1000 + 15000) { // 15초 여유
      await this.destroy(token);
      return null;
    }
    await run(this.db, 'UPDATE sessions SET last_seen_at=? WHERE token=?', [nowISO(), token]);
    return s;
  }

  async destroy(token) { await run(this.db, 'DELETE FROM sessions WHERE token=?', [token]); }

  async cleanup() {
    const cutoff = new Date(Date.parse(nowISO()) - 24 * 3600 * 1000).toISOString();
    await run(this.db, 'DELETE FROM sessions WHERE last_seen_at < ?', [cutoff]);
  }
}

// 단순 시도 횟수 제한 (IP+키 기준, 메모리)
// 주의: Vercel 서버리스에서는 인스턴스가 요청마다 새로 뜰 수 있어 이 제한이 완벽하게 보장되지 않는다(최선 노력 수준).
export class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.map = new Map(); }
  hit(key) {
    const now = Date.now();
    const arr = (this.map.get(key) || []).filter(t => now - t < this.windowMs);
    arr.push(now);
    this.map.set(key, arr);
    return arr.length <= this.max;
  }
}

export async function createAdmin(db, username, password, displayName) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(u)) throw Object.assign(new Error('아이디는 영문/숫자 3~30자로 입력해 주세요.'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('비밀번호는 8자 이상이어야 합니다.'), { status: 400 });
  const info = await run(db, 'INSERT INTO admins(username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    [u, hashPassword(password), String(displayName || u).slice(0, 30), nowISO()]);
  const id = Number(info.lastInsertRowid);
  await audit(db, { type: 'system' }, 'admin_account_created', 'admin', id, { username: u });
  return id;
}
