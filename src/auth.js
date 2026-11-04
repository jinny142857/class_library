// 인증: 관리자 비밀번호(scrypt) + DB 세션. 학생은 QR 토큰으로 로그인하고 미사용 시간이 지나면 세션이 만료된다.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { nowISO } from './clock.js';
import { getSettings, audit } from './db.js';

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

  create(role, subjectId) {
    const token = randomBytes(32).toString('base64url');
    const now = nowISO();
    if (role === 'student') this.db.prepare("DELETE FROM sessions WHERE role='student'").run(); // 공용 기기: 학생 세션은 한 번에 하나
    this.db.prepare('INSERT INTO sessions(token, role, subject_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(token, role, subjectId, now, now);
    return token;
  }

  // 유효한 세션이면 last_seen 을 갱신하고 반환
  touch(token, role) {
    if (!token) return null;
    const s = this.db.prepare('SELECT * FROM sessions WHERE token=? AND role=?').get(token, role);
    if (!s) return null;
    const idle = role === 'student' ? getSettings(this.db).student_idle_seconds : ADMIN_IDLE_SECONDS;
    if (Date.now() - Date.parse(s.last_seen_at) > idle * 1000 + 15000) { // 15초 여유
      this.destroy(token);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token=?').run(new Date().toISOString(), token);
    return s;
  }

  destroy(token) { this.db.prepare('DELETE FROM sessions WHERE token=?').run(token); }

  cleanup() {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    this.db.prepare('DELETE FROM sessions WHERE last_seen_at < ?').run(cutoff);
  }
}

// 단순 시도 횟수 제한 (IP+키 기준, 메모리)
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

export function createAdmin(db, username, password, displayName) {
  const u = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(u)) throw Object.assign(new Error('아이디는 영문/숫자 3~30자로 입력해 주세요.'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('비밀번호는 8자 이상이어야 합니다.'), { status: 400 });
  const info = db.prepare('INSERT INTO admins(username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run(u, hashPassword(password), String(displayName || u).slice(0, 30), nowISO());
  audit(db, { type: 'system' }, 'admin_account_created', 'admin', Number(info.lastInsertRowid), { username: u });
  return Number(info.lastInsertRowid);
}
