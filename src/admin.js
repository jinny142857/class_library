// 교사용 관리 기능: 학생·도서·소장본·일정·설정 관리와 조회/통계.
import { randomBytes } from 'node:crypto';
import { tx, audit, getSettings, DEFAULT_SETTINGS, importHolidays } from './db.js';
import { LibError } from './library.js';
import { nowISO, isValidDate, addDays } from './clock.js';

export function newToken(prefix) {
  return `${prefix}-${randomBytes(12).toString('base64url')}`; // 96비트 무작위
}

const clean = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

export class Admin {
  constructor(db, lib) {
    this.db = db;
    this.lib = lib;
  }

  // ───────────── 학생 ─────────────
  createStudent({ name, number, memo }, ctx) {
    name = clean(name, 50);
    if (!name) throw new LibError('BAD_INPUT', '학생 이름을 입력해 주세요.');
    const now = nowISO();
    const info = this.db.prepare('INSERT INTO students(number, name, qr_token, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(toInt(number), name, newToken('ST'), clean(memo, 500), now, now);
    const id = Number(info.lastInsertRowid);
    audit(this.db, ctx.actor, 'admin_create_student', 'student', id, { name, number: toInt(number) });
    return this.db.prepare('SELECT * FROM students WHERE id=?').get(id);
  }

  importStudents(rows, ctx) {
    return tx(this.db, () => {
      const out = [];
      for (const r of rows) out.push(this.createStudent(r, ctx));
      return out;
    });
  }

  updateStudent(id, { name, number, memo, status }, ctx) {
    const s = this.db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (!s) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    const next = {
      name: name !== undefined ? clean(name, 50) : s.name,
      number: number !== undefined ? toInt(number) : s.number,
      memo: memo !== undefined ? clean(memo, 500) : s.memo,
      status: status !== undefined ? status : s.status,
    };
    if (!next.name) throw new LibError('BAD_INPUT', '학생 이름을 입력해 주세요.');
    if (!['active', 'inactive'].includes(next.status)) throw new LibError('BAD_INPUT', '상태 값이 올바르지 않습니다.');
    this.db.prepare('UPDATE students SET name=?, number=?, memo=?, status=?, updated_at=? WHERE id=?')
      .run(next.name, next.number, next.memo, next.status, nowISO(), id);
    if (next.status === 'inactive') this.db.prepare("DELETE FROM sessions WHERE role='student' AND subject_id=?").run(id);
    audit(this.db, ctx.actor, 'admin_update_student', 'student', id, { before: pick(s, next), after: next });
    return { ok: true };
  }

  reissueStudentQr(id, ctx) {
    const token = newToken('ST');
    const r = this.db.prepare('UPDATE students SET qr_token=?, updated_at=? WHERE id=?').run(token, nowISO(), id);
    if (!r.changes) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    this.db.prepare("DELETE FROM sessions WHERE role='student' AND subject_id=?").run(id);
    audit(this.db, ctx.actor, 'admin_reissue_student_qr', 'student', id, {});
    return { ok: true, qr_token: token };
  }

  listStudents(today) {
    const rows = this.db.prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM loans l WHERE l.student_id=s.id AND l.status='active') AS active_loans,
        (SELECT COUNT(*) FROM loans l WHERE l.student_id=s.id) AS total_loans,
        (SELECT COUNT(*) FROM reservations r WHERE r.student_id=s.id AND r.status IN ('waiting','priority')) AS active_reservations
      FROM students s ORDER BY s.status, COALESCE(s.number, 9999), s.name`).all();
    return rows.map(s => {
      const st = this.lib.studentState(s.id, { today });
      return { ...s, overdue: st.overdue, suspension_until: st.suspension_until, loans: st.loans.map(l => ({ title: l.title, due_date: l.due_date, overdue_days: l.overdue_days })) };
    });
  }

  studentDetail(id, today) {
    const s = this.db.prepare('SELECT * FROM students WHERE id=?').get(id);
    if (!s) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    return { student: s, state: this.lib.studentState(id, { today }), history: this.lib.history(id, 500),
      reservations: this.db.prepare(`SELECT r.*, b.title FROM reservations r JOIN books b ON b.id=r.book_id WHERE r.student_id=? ORDER BY r.reserved_at DESC LIMIT 100`).all(id) };
  }

  // ───────────── 도서·소장본 ─────────────
  createBook(data, ctx) {
    return tx(this.db, () => {
      const b = bookFields(data);
      if (!b.title) throw new LibError('BAD_INPUT', '도서명을 입력해 주세요.');
      const now = nowISO();
      const info = this.db.prepare('INSERT INTO books(title, author, publisher, isbn, category, cover_image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(b.title, b.author, b.publisher, b.isbn, b.category, b.cover_image, now, now);
      const id = Number(info.lastInsertRowid);
      audit(this.db, ctx.actor, 'admin_create_book', 'book', id, b);
      const n = Math.max(0, Math.min(50, toInt(data.copies) ?? 1));
      const codes = Array.isArray(data.copy_codes) ? data.copy_codes : [];
      for (let i = 0; i < n; i++) this._addCopy(id, clean(codes[i], 40), ctx);
      return this.bookDetail(id);
    });
  }

  updateBook(id, data, ctx) {
    const cur = this.db.prepare('SELECT * FROM books WHERE id=?').get(id);
    if (!cur) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
    const b = { ...cur, ...Object.fromEntries(Object.entries(bookFields(data)).filter(([k]) => k in data)) };
    if (data.status !== undefined) b.status = data.status === 'inactive' ? 'inactive' : 'active';
    if (!b.title) throw new LibError('BAD_INPUT', '도서명을 입력해 주세요.');
    this.db.prepare('UPDATE books SET title=?, author=?, publisher=?, isbn=?, category=?, cover_image=?, status=?, updated_at=? WHERE id=?')
      .run(b.title, b.author, b.publisher, b.isbn, b.category, b.cover_image, b.status, nowISO(), id);
    audit(this.db, ctx.actor, 'admin_update_book', 'book', id, { before: pick(cur, b), after: pick(b, b) });
    return this.bookDetail(id);
  }

  // 대출·예약 이력이 있으면 비활성 처리, 없으면 실제 삭제
  deleteBook(id, ctx) {
    return tx(this.db, () => {
      const hasHistory = this.db.prepare('SELECT COUNT(*) c FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=?').get(id).c
        + this.db.prepare('SELECT COUNT(*) c FROM reservations WHERE book_id=?').get(id).c;
      const active = this.db.prepare("SELECT COUNT(*) c FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=? AND l.status='active'").get(id).c;
      if (active) throw new LibError('IN_USE', '대출 중인 소장본이 있어 삭제할 수 없습니다. 먼저 반납 처리해 주세요.');
      if (hasHistory) {
        this.db.prepare("UPDATE books SET status='inactive', updated_at=? WHERE id=?").run(nowISO(), id);
        this.db.prepare("UPDATE reservations SET status='cancelled', closed_at=? WHERE book_id=? AND status IN ('waiting','priority')").run(nowISO(), id);
        audit(this.db, ctx.actor, 'admin_deactivate_book', 'book', id, {});
        return { deleted: false, deactivated: true };
      }
      this.db.prepare('DELETE FROM copies WHERE book_id=?').run(id);
      this.db.prepare('DELETE FROM books WHERE id=?').run(id);
      audit(this.db, ctx.actor, 'admin_delete_book', 'book', id, {});
      return { deleted: true };
    });
  }

  addCopies(bookId, count, codes, ctx) {
    return tx(this.db, () => {
      if (!this.db.prepare('SELECT id FROM books WHERE id=?').get(bookId)) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
      const n = Math.max(1, Math.min(50, toInt(count) ?? 1));
      for (let i = 0; i < n; i++) this._addCopy(bookId, clean(codes?.[i], 40), ctx);
      this.lib.refreshBook(bookId, ctx);
      return this.bookDetail(bookId);
    });
  }

  _addCopy(bookId, code, ctx) {
    const now = nowISO();
    if (!code) {
      const n = this.db.prepare('SELECT COUNT(*) c FROM copies WHERE book_id=?').get(bookId).c + 1;
      code = `B${String(bookId).padStart(4, '0')}-${n}`;
      while (this.db.prepare('SELECT 1 FROM copies WHERE copy_code=?').get(code)) code += 'a';
    } else if (this.db.prepare('SELECT 1 FROM copies WHERE UPPER(copy_code)=UPPER(?)').get(code)) {
      throw new LibError('DUP_CODE', `이미 사용 중인 소장본 코드입니다: ${code}`);
    }
    const info = this.db.prepare('INSERT INTO copies(book_id, copy_code, qr_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(bookId, code, newToken('BK'), now, now);
    audit(this.db, ctx.actor, 'admin_add_copy', 'copy', Number(info.lastInsertRowid), { book_id: bookId, copy_code: code });
  }

  updateCopy(id, { status, copy_code }, ctx) {
    return tx(this.db, () => {
      const c = this.db.prepare('SELECT * FROM copies WHERE id=?').get(id);
      if (!c) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
      const next = { status: status ?? c.status, copy_code: clean(copy_code, 40) ?? c.copy_code };
      if (!['available', 'lost', 'repair', 'discarded'].includes(next.status) && next.status !== c.status) {
        throw new LibError('BAD_INPUT', "'대출 중' 상태는 대출 처리로만 바뀝니다.");
      }
      if (c.status === 'loaned' && next.status !== 'loaned') throw new LibError('IN_USE', '대출 중인 소장본입니다. 먼저 반납 처리해 주세요.');
      if (next.copy_code !== c.copy_code && this.db.prepare('SELECT 1 FROM copies WHERE UPPER(copy_code)=UPPER(?) AND id<>?').get(next.copy_code, id)) {
        throw new LibError('DUP_CODE', '이미 사용 중인 소장본 코드입니다.');
      }
      this.db.prepare('UPDATE copies SET status=?, copy_code=?, updated_at=? WHERE id=?').run(next.status, next.copy_code, nowISO(), id);
      audit(this.db, ctx.actor, 'admin_update_copy', 'copy', id, { before: { status: c.status, copy_code: c.copy_code }, after: next });
      this.lib.refreshBook(c.book_id, ctx, ctx.today);
      return { ok: true };
    });
  }

  reissueCopyQr(id, ctx) {
    const r = this.db.prepare('UPDATE copies SET qr_token=?, updated_at=? WHERE id=?').run(newToken('BK'), nowISO(), id);
    if (!r.changes) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
    audit(this.db, ctx.actor, 'admin_reissue_copy_qr', 'copy', id, {});
    return { ok: true };
  }

  deleteCopy(id, ctx) {
    const used = this.db.prepare('SELECT COUNT(*) c FROM loans WHERE copy_id=?').get(id).c;
    if (used) return this.updateCopy(id, { status: 'discarded' }, ctx);
    const c = this.db.prepare('SELECT * FROM copies WHERE id=?').get(id);
    if (!c) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
    this.db.prepare('DELETE FROM copies WHERE id=?').run(id);
    audit(this.db, ctx.actor, 'admin_delete_copy', 'copy', id, { copy_code: c.copy_code });
    return { ok: true, deleted: true };
  }

  listBooks({ q, includeInactive } = {}) {
    const like = `%${q || ''}%`;
    return this.db.prepare(`SELECT b.*,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status<>'discarded') AS copies,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='available') AS available,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='loaned') AS loaned,
        (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status IN ('waiting','priority')) AS reservations,
        (SELECT COUNT(*) FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=b.id) AS total_loans
      FROM books b WHERE (b.title LIKE ? OR IFNULL(b.author,'') LIKE ? OR IFNULL(b.isbn,'') LIKE ? OR IFNULL(b.category,'') LIKE ?)
        ${includeInactive ? '' : "AND b.status='active'"}
      ORDER BY b.status, b.title`).all(like, like, like, like);
  }

  bookDetail(id) {
    const book = this.db.prepare('SELECT * FROM books WHERE id=?').get(id);
    if (!book) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
    const copies = this.db.prepare(`SELECT c.*, l.id AS loan_id, l.final_due_date, s.name AS borrower
      FROM copies c LEFT JOIN loans l ON l.copy_id=c.id AND l.status='active' LEFT JOIN students s ON s.id=l.student_id
      WHERE c.book_id=? ORDER BY c.id`).all(id);
    const queue = this.lib.activeReservations(id);
    return { book, copies, queue };
  }

  categories() {
    return this.db.prepare("SELECT DISTINCT category FROM books WHERE category IS NOT NULL AND category<>'' ORDER BY category").all().map(r => r.category);
  }

  // ───────────── 대출·예약 조회 ─────────────
  listLoans({ status, q, today }) {
    let where = '1=1';
    const args = [];
    if (status === 'active') where += " AND l.status='active'";
    else if (status === 'returned') where += " AND l.status<>'active'";
    else if (status === 'overdue') where += " AND l.status='active' AND l.final_due_date < ?", args.push(today);
    else if (status === 'late_returned') where += " AND l.status<>'active' AND l.overdue_school_days > 0";
    if (q) { where += ' AND (s.name LIKE ? OR b.title LIKE ? OR c.copy_code LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return this.db.prepare(`SELECT l.*, s.name AS student_name, s.number AS student_number, b.title, b.id AS book_id, c.copy_code
      FROM loans l JOIN students s ON s.id=l.student_id JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE ${where} ORDER BY l.loaned_at DESC LIMIT 500`).all(...args)
      .map(l => ({ ...l, overdue_days: this.lib.overdueDays(l, today) }));
  }

  listReservations({ scope }) {
    const where = scope === 'closed' ? "r.status NOT IN ('waiting','priority')" : "r.status IN ('waiting','priority')";
    const rows = this.db.prepare(`SELECT r.*, s.name AS student_name, s.number AS student_number, b.title
      FROM reservations r JOIN students s ON s.id=r.student_id JOIN books b ON b.id=r.book_id
      WHERE ${where} ORDER BY b.title, CASE r.status WHEN 'priority' THEN 0 ELSE 1 END, r.reserved_at LIMIT 500`).all();
    if (scope !== 'closed') for (const r of rows) r.position = this.lib.queuePosition(r);
    return rows;
  }

  // ───────────── 학사일정 ─────────────
  calendarMonth(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new LibError('BAD_INPUT', '잘못된 월입니다.');
    const first = `${ym}-01`;
    const days = [];
    for (let d = first; d.startsWith(ym); d = addDays(d, 1)) {
      const t = this.db.prepare('SELECT * FROM school_calendar WHERE date=?').get(d);
      const h = this.db.prepare('SELECT name FROM public_holidays WHERE date=?').get(d);
      days.push({ date: d, is_school_day: this.lib.cal.isSchoolDay(d), holiday: h?.name || null, teacher: t || null });
    }
    return days;
  }

  setCalendarDay(date, { is_school_day, reason }, ctx) {
    if (!isValidDate(date)) throw new LibError('BAD_INPUT', '날짜가 올바르지 않습니다.');
    const before = this.db.prepare('SELECT * FROM school_calendar WHERE date=?').get(date) || null;
    this.db.prepare(`INSERT INTO school_calendar(date, is_school_day, reason, source, updated_at, updated_by) VALUES (?, ?, ?, 'teacher', ?, ?)
      ON CONFLICT(date) DO UPDATE SET is_school_day=excluded.is_school_day, reason=excluded.reason, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(date, is_school_day ? 1 : 0, clean(reason, 100), nowISO(), ctx.actor.name || String(ctx.actor.id));
    audit(this.db, ctx.actor, 'admin_calendar_set', 'calendar', null, { date, before, is_school_day: !!is_school_day, reason });
    return { ok: true, impact: this.lib.calendarImpact() };
  }

  clearCalendarDay(date, ctx) {
    const before = this.db.prepare('SELECT * FROM school_calendar WHERE date=?').get(date) || null;
    this.db.prepare('DELETE FROM school_calendar WHERE date=?').run(date);
    audit(this.db, ctx.actor, 'admin_calendar_clear', 'calendar', null, { date, before });
    return { ok: true, impact: this.lib.calendarImpact() };
  }

  setHoliday(date, name, ctx) {
    if (!isValidDate(date)) throw new LibError('BAD_INPUT', '날짜가 올바르지 않습니다.');
    importHolidays(this.db, [[date, clean(name, 50) || '공휴일']]);
    audit(this.db, ctx.actor, 'admin_holiday_set', 'calendar', null, { date, name });
    return { ok: true };
  }

  deleteHoliday(date, ctx) {
    this.db.prepare('DELETE FROM public_holidays WHERE date=?').run(date);
    audit(this.db, ctx.actor, 'admin_holiday_delete', 'calendar', null, { date });
    return { ok: true };
  }

  // ───────────── 설정 ─────────────
  updateSettings(values, ctx) {
    return tx(this.db, () => {
      const before = getSettings(this.db);
      const now = nowISO();
      const changed = {};
      for (const [k, v] of Object.entries(values || {})) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const n = Number(v);
        const min = ['suspension_multiplier'].includes(k) ? 0 : (k === 'max_extensions' ? 0 : 1);
        const max = k === 'student_idle_seconds' ? 3600 : 30;
        if (!Number.isInteger(n) || n < min || n > max) throw new LibError('BAD_INPUT', `설정 값이 올바르지 않습니다: ${k}`);
        if (n !== before[k]) {
          this.db.prepare('UPDATE settings SET value=?, updated_at=?, updated_by=? WHERE key=?').run(String(n), now, ctx.actor.name || String(ctx.actor.id), k);
          changed[k] = { from: before[k], to: n };
        }
      }
      if (Object.keys(changed).length) audit(this.db, ctx.actor, 'admin_settings', 'settings', null, changed);
      return { settings: getSettings(this.db), changed };
    });
  }

  // ───────────── 대시보드·통계 ─────────────
  dashboard(today) {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).c;
    const overdue = this.listLoans({ status: 'overdue', today });
    return {
      today,
      is_school_day: this.lib.cal.isSchoolDay(today),
      books_titles: one("SELECT COUNT(*) c FROM books WHERE status='active'"),
      books_copies: one("SELECT COUNT(*) c FROM copies c JOIN books b ON b.id=c.book_id WHERE b.status='active' AND c.status<>'discarded'"),
      copies_available: one("SELECT COUNT(*) c FROM copies c JOIN books b ON b.id=c.book_id WHERE b.status='active' AND c.status='available'"),
      copies_loaned: one("SELECT COUNT(*) c FROM copies WHERE status='loaned'"),
      students: one("SELECT COUNT(*) c FROM students WHERE status='active'"),
      active_reservations: one("SELECT COUNT(*) c FROM reservations WHERE status IN ('waiting','priority')"),
      suspended_students: this.db.prepare(`SELECT s.id, s.name, MAX(l.suspension_until) AS until FROM loans l JOIN students s ON s.id=l.student_id
        WHERE l.suspension_until >= ? AND l.suspension_waived=0 GROUP BY s.id ORDER BY s.name`).all(today),
      overdue,
      recent: this.db.prepare(`SELECT a.action, a.created_at, a.details, s.name AS student_name, b.title
        FROM audit_logs a LEFT JOIN loans l ON a.target_type='loan' AND l.id=a.target_id
        LEFT JOIN students s ON s.id=l.student_id LEFT JOIN copies c ON c.id=l.copy_id LEFT JOIN books b ON b.id=c.book_id
        WHERE a.action IN ('loan','return','admin_return','extend') ORDER BY a.id DESC LIMIT 12`).all(),
      popular: this.popular(null, null, 5),
    };
  }

  popular(from, to, limit = 10) {
    const [w, a] = range(from, to);
    return this.db.prepare(`SELECT b.id, b.title, b.author, b.category, COUNT(*) AS loans FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE ${w} GROUP BY b.id ORDER BY loans DESC, b.title LIMIT ?`).all(...a, limit);
  }

  stats({ from, to }) {
    const [w, a] = range(from, to);
    return {
      from: from || null, to: to || null,
      total: this.db.prepare(`SELECT COUNT(*) c FROM loans l WHERE ${w}`).get(...a).c,
      all_time: this.db.prepare('SELECT COUNT(*) c FROM loans').get().c,
      monthly: this.db.prepare(`SELECT substr(l.loan_date,1,7) AS month, COUNT(*) AS loans FROM loans l WHERE ${w} GROUP BY month ORDER BY month`).all(...a),
      by_student: this.db.prepare(`SELECT s.id, s.name, s.number, COUNT(l.id) AS loans FROM students s LEFT JOIN loans l ON l.student_id=s.id AND ${w}
        WHERE s.status='active' GROUP BY s.id ORDER BY loans DESC, COALESCE(s.number, 9999), s.name`).all(...a),
      top_books: this.popular(from, to, 10),
      by_category: this.db.prepare(`SELECT COALESCE(NULLIF(b.category,''),'미분류') AS category, COUNT(*) AS loans FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
        WHERE ${w} GROUP BY 1 ORDER BY loans DESC`).all(...a),
    };
  }

  auditLogs({ limit = 200, action } = {}) {
    const rows = action
      ? this.db.prepare('SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY id DESC LIMIT ?').all(`%${action}%`, limit)
      : this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }
}

function range(from, to) {
  const w = [];
  const a = [];
  if (from && isValidDate(from)) { w.push('l.loan_date >= ?'); a.push(from); }
  if (to && isValidDate(to)) { w.push('l.loan_date <= ?'); a.push(to); }
  return [w.length ? w.join(' AND ') : '1=1', a];
}

function bookFields(d) {
  return {
    title: clean(d.title, 200), author: clean(d.author, 200), publisher: clean(d.publisher, 100),
    isbn: clean(d.isbn, 20)?.replace(/[^0-9Xx]/g, '') || null, category: clean(d.category, 50),
    cover_image: /^https?:\/\//.test(d.cover_image || '') ? clean(d.cover_image, 500) : null,
  };
}

function toInt(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function pick(obj, keysFrom) {
  const o = {};
  for (const k of Object.keys(keysFrom)) o[k] = obj[k];
  return o;
}
