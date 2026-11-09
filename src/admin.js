// 교사용 관리 기능: 학생·도서·소장본·일정·설정 관리와 조회/통계.
// (neon-vercel-migration 브랜치: Postgres 비동기 드라이버로 전환됨 — 모든 메서드가 async.)
import { randomBytes } from 'node:crypto';
import { tx, audit, getSettings, DEFAULT_SETTINGS, importHolidays, get, all, run } from './db.js';
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
  async createStudent({ name, number, memo }, ctx, conn = this.db) {
    name = clean(name, 50);
    if (!name) throw new LibError('BAD_INPUT', '학생 이름을 입력해 주세요.');
    const now = nowISO();
    const info = await run(conn, 'INSERT INTO students(number, name, qr_token, memo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [toInt(number), name, newToken('ST'), clean(memo, 500), now, now]);
    const id = Number(info.lastInsertRowid);
    await audit(conn, ctx.actor, 'admin_create_student', 'student', id, { name, number: toInt(number) });
    return get(conn, 'SELECT * FROM students WHERE id=?', [id]);
  }

  importStudents(rows, ctx) {
    return tx(this.db, async (client) => {
      const out = [];
      for (const r of rows) out.push(await this.createStudent(r, ctx, client));
      return out;
    });
  }

  async updateStudent(id, { name, number, memo, status }, ctx) {
    const s = await get(this.db, 'SELECT * FROM students WHERE id=?', [id]);
    if (!s) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    const next = {
      name: name !== undefined ? clean(name, 50) : s.name,
      number: number !== undefined ? toInt(number) : s.number,
      memo: memo !== undefined ? clean(memo, 500) : s.memo,
      status: status !== undefined ? status : s.status,
    };
    if (!next.name) throw new LibError('BAD_INPUT', '학생 이름을 입력해 주세요.');
    if (!['active', 'inactive'].includes(next.status)) throw new LibError('BAD_INPUT', '상태 값이 올바르지 않습니다.');
    await run(this.db, 'UPDATE students SET name=?, number=?, memo=?, status=?, updated_at=? WHERE id=?',
      [next.name, next.number, next.memo, next.status, nowISO(), id]);
    if (next.status === 'inactive') await run(this.db, "DELETE FROM sessions WHERE role='student' AND subject_id=?", [id]);
    await audit(this.db, ctx.actor, 'admin_update_student', 'student', id, { before: pick(s, next), after: next });
    return { ok: true };
  }

  async reissueStudentQr(id, ctx) {
    const token = newToken('ST');
    const r = await run(this.db, 'UPDATE students SET qr_token=?, updated_at=? WHERE id=?', [token, nowISO(), id]);
    if (!r.changes) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    await run(this.db, "DELETE FROM sessions WHERE role='student' AND subject_id=?", [id]);
    await audit(this.db, ctx.actor, 'admin_reissue_student_qr', 'student', id, {});
    return { ok: true, qr_token: token };
  }

  async listStudents(today) {
    const rows = await all(this.db, `SELECT s.*,
        (SELECT COUNT(*) FROM loans l WHERE l.student_id=s.id AND l.status='active') AS active_loans,
        (SELECT COUNT(*) FROM loans l WHERE l.student_id=s.id) AS total_loans,
        (SELECT COUNT(*) FROM reservations r WHERE r.student_id=s.id AND r.status IN ('waiting','priority')) AS active_reservations
      FROM students s ORDER BY s.status, COALESCE(s.number, 9999), s.name`);
    return Promise.all(rows.map(async (s) => {
      const st = await this.lib.studentState(s.id, { today });
      return { ...s, overdue: st.overdue, suspension_until: st.suspension_until, loans: st.loans.map(l => ({ title: l.title, due_date: l.due_date, overdue_days: l.overdue_days })) };
    }));
  }

  async studentDetail(id, today) {
    const s = await get(this.db, 'SELECT * FROM students WHERE id=?', [id]);
    if (!s) throw new LibError('NOT_FOUND', '학생을 찾을 수 없습니다.');
    const [state, history, reservations] = await Promise.all([
      this.lib.studentState(id, { today }),
      this.lib.history(id, 500),
      all(this.db, `SELECT r.*, b.title FROM reservations r JOIN books b ON b.id=r.book_id WHERE r.student_id=? ORDER BY r.reserved_at DESC LIMIT 100`, [id]),
    ]);
    return { student: s, state, history, reservations };
  }

  // ───────────── 도서·소장본 ─────────────
  createBook(data, ctx) {
    return tx(this.db, async (client) => {
      const b = bookFields(data);
      if (!b.title) throw new LibError('BAD_INPUT', '도서명을 입력해 주세요.');
      const now = nowISO();
      const info = await run(client, 'INSERT INTO books(title, author, publisher, isbn, category, cover_image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [b.title, b.author, b.publisher, b.isbn, b.category, b.cover_image, now, now]);
      const id = Number(info.lastInsertRowid);
      await audit(client, ctx.actor, 'admin_create_book', 'book', id, b);
      const n = Math.max(0, Math.min(50, toInt(data.copies) ?? 1));
      const codes = Array.isArray(data.copy_codes) ? data.copy_codes : [];
      for (let i = 0; i < n; i++) await this._addCopy(id, clean(codes[i], 40), ctx, client);
      return this.bookDetail(id, client);
    });
  }

  async updateBook(id, data, ctx) {
    const cur = await get(this.db, 'SELECT * FROM books WHERE id=?', [id]);
    if (!cur) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
    const b = { ...cur, ...Object.fromEntries(Object.entries(bookFields(data)).filter(([k]) => k in data)) };
    if (data.status !== undefined) b.status = data.status === 'inactive' ? 'inactive' : 'active';
    if (!b.title) throw new LibError('BAD_INPUT', '도서명을 입력해 주세요.');
    await run(this.db, 'UPDATE books SET title=?, author=?, publisher=?, isbn=?, category=?, cover_image=?, status=?, updated_at=? WHERE id=?',
      [b.title, b.author, b.publisher, b.isbn, b.category, b.cover_image, b.status, nowISO(), id]);
    await audit(this.db, ctx.actor, 'admin_update_book', 'book', id, { before: pick(cur, b), after: pick(b, b) });
    return this.bookDetail(id);
  }

  // 대출·예약 이력이 있으면 비활성 처리, 없으면 실제 삭제
  deleteBook(id, ctx) {
    return tx(this.db, async (client) => {
      const hasHistory = (await get(client, 'SELECT COUNT(*) c FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=?', [id])).c
        + (await get(client, 'SELECT COUNT(*) c FROM reservations WHERE book_id=?', [id])).c;
      const active = (await get(client, "SELECT COUNT(*) c FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=? AND l.status='active'", [id])).c;
      if (active > 0) throw new LibError('IN_USE', '대출 중인 소장본이 있어 삭제할 수 없습니다. 먼저 반납 처리해 주세요.');
      if (hasHistory > 0) {
        await run(client, "UPDATE books SET status='inactive', updated_at=? WHERE id=?", [nowISO(), id]);
        await run(client, "UPDATE reservations SET status='cancelled', closed_at=? WHERE book_id=? AND status IN ('waiting','priority')", [nowISO(), id]);
        await audit(client, ctx.actor, 'admin_deactivate_book', 'book', id, {});
        return { deleted: false, deactivated: true };
      }
      await run(client, 'DELETE FROM copies WHERE book_id=?', [id]);
      await run(client, 'DELETE FROM books WHERE id=?', [id]);
      await audit(client, ctx.actor, 'admin_delete_book', 'book', id, {});
      return { deleted: true };
    });
  }

  addCopies(bookId, count, codes, ctx) {
    return tx(this.db, async (client) => {
      if (!(await get(client, 'SELECT id FROM books WHERE id=?', [bookId]))) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
      const n = Math.max(1, Math.min(50, toInt(count) ?? 1));
      for (let i = 0; i < n; i++) await this._addCopy(bookId, clean(codes?.[i], 40), ctx, client);
      await this.lib.refreshBook(bookId, ctx, undefined, client);
      return this.bookDetail(bookId, client);
    });
  }

  async _addCopy(bookId, code, ctx, conn = this.db) {
    const now = nowISO();
    if (!code) {
      const n = (await get(conn, 'SELECT COUNT(*) c FROM copies WHERE book_id=?', [bookId])).c + 1;
      code = `B${String(bookId).padStart(4, '0')}-${n}`;
      while (await get(conn, 'SELECT 1 FROM copies WHERE copy_code=?', [code])) code += 'a';
    } else if (await get(conn, 'SELECT 1 FROM copies WHERE UPPER(copy_code)=UPPER(?)', [code])) {
      throw new LibError('DUP_CODE', `이미 사용 중인 소장본 코드입니다: ${code}`);
    }
    const info = await run(conn, 'INSERT INTO copies(book_id, copy_code, qr_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [bookId, code, newToken('BK'), now, now]);
    await audit(conn, ctx.actor, 'admin_add_copy', 'copy', Number(info.lastInsertRowid), { book_id: bookId, copy_code: code });
  }

  updateCopy(id, { status, copy_code }, ctx) {
    return tx(this.db, async (client) => {
      const c = await get(client, 'SELECT * FROM copies WHERE id=?', [id]);
      if (!c) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
      const next = { status: status ?? c.status, copy_code: clean(copy_code, 40) ?? c.copy_code };
      if (!['available', 'lost', 'repair', 'discarded'].includes(next.status) && next.status !== c.status) {
        throw new LibError('BAD_INPUT', "'대출 중' 상태는 대출 처리로만 바뀝니다.");
      }
      if (c.status === 'loaned' && next.status !== 'loaned') throw new LibError('IN_USE', '대출 중인 소장본입니다. 먼저 반납 처리해 주세요.');
      if (next.copy_code !== c.copy_code && await get(client, 'SELECT 1 FROM copies WHERE UPPER(copy_code)=UPPER(?) AND id<>?', [next.copy_code, id])) {
        throw new LibError('DUP_CODE', '이미 사용 중인 소장본 코드입니다.');
      }
      await run(client, 'UPDATE copies SET status=?, copy_code=?, updated_at=? WHERE id=?', [next.status, next.copy_code, nowISO(), id]);
      await audit(client, ctx.actor, 'admin_update_copy', 'copy', id, { before: { status: c.status, copy_code: c.copy_code }, after: next });
      await this.lib.refreshBook(c.book_id, ctx, ctx.today, client);
      return { ok: true };
    });
  }

  async reissueCopyQr(id, ctx) {
    const r = await run(this.db, 'UPDATE copies SET qr_token=?, updated_at=? WHERE id=?', [newToken('BK'), nowISO(), id]);
    if (!r.changes) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
    await audit(this.db, ctx.actor, 'admin_reissue_copy_qr', 'copy', id, {});
    return { ok: true };
  }

  async deleteCopy(id, ctx) {
    const used = (await get(this.db, 'SELECT COUNT(*) c FROM loans WHERE copy_id=?', [id])).c;
    if (used > 0) return this.updateCopy(id, { status: 'discarded' }, ctx);
    const c = await get(this.db, 'SELECT * FROM copies WHERE id=?', [id]);
    if (!c) throw new LibError('NOT_FOUND', '소장본을 찾을 수 없습니다.');
    await run(this.db, 'DELETE FROM copies WHERE id=?', [id]);
    await audit(this.db, ctx.actor, 'admin_delete_copy', 'copy', id, { copy_code: c.copy_code });
    return { ok: true, deleted: true };
  }

  async listBooks({ q, includeInactive } = {}) {
    const like = `%${q || ''}%`;
    return all(this.db, `SELECT b.*,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status<>'discarded') AS copies,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='available') AS available,
        (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='loaned') AS loaned,
        (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status IN ('waiting','priority')) AS reservations,
        (SELECT COUNT(*) FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=b.id) AS total_loans
      FROM books b WHERE (b.title ILIKE ? OR COALESCE(b.author,'') ILIKE ? OR COALESCE(b.isbn,'') ILIKE ? OR COALESCE(b.category,'') ILIKE ?)
        ${includeInactive ? '' : "AND b.status='active'"}
      ORDER BY b.status, b.title`, [like, like, like, like]);
  }

  async bookDetail(id, conn = this.db) {
    const book = await get(conn, 'SELECT * FROM books WHERE id=?', [id]);
    if (!book) throw new LibError('NOT_FOUND', '도서를 찾을 수 없습니다.');
    const copies = await all(conn, `SELECT c.*, l.id AS loan_id, l.final_due_date, s.name AS borrower
      FROM copies c LEFT JOIN loans l ON l.copy_id=c.id AND l.status='active' LEFT JOIN students s ON s.id=l.student_id
      WHERE c.book_id=? ORDER BY c.id`, [id]);
    const queue = await this.lib.activeReservations(id, conn);
    return { book, copies, queue };
  }

  async categories() {
    return (await all(this.db, "SELECT DISTINCT category FROM books WHERE category IS NOT NULL AND category<>'' ORDER BY category")).map(r => r.category);
  }

  // ───────────── 대출·예약 조회 ─────────────
  async listLoans({ status, q, today }) {
    let where = '1=1';
    const args = [];
    if (status === 'active') where += " AND l.status='active'";
    else if (status === 'returned') where += " AND l.status<>'active'";
    else if (status === 'overdue') { where += " AND l.status='active' AND l.final_due_date < ?"; args.push(today); }
    else if (status === 'late_returned') where += " AND l.status<>'active' AND l.overdue_school_days > 0";
    if (q) { where += ' AND (s.name ILIKE ? OR b.title ILIKE ? OR c.copy_code ILIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = await all(this.db, `SELECT l.*, s.name AS student_name, s.number AS student_number, b.title, b.id AS book_id, c.copy_code
      FROM loans l JOIN students s ON s.id=l.student_id JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE ${where} ORDER BY l.loaned_at DESC LIMIT 500`, args);
    return rows.map(l => ({ ...l, overdue_days: this.lib.overdueDays(l, today) }));
  }

  async listReservations({ scope }) {
    const where = scope === 'closed' ? "r.status NOT IN ('waiting','priority')" : "r.status IN ('waiting','priority')";
    const rows = await all(this.db, `SELECT r.*, s.name AS student_name, s.number AS student_number, b.title
      FROM reservations r JOIN students s ON s.id=r.student_id JOIN books b ON b.id=r.book_id
      WHERE ${where} ORDER BY b.title, CASE r.status WHEN 'priority' THEN 0 ELSE 1 END, r.reserved_at LIMIT 500`);
    if (scope !== 'closed') for (const r of rows) r.position = await this.lib.queuePosition(r);
    return rows;
  }

  // ───────────── 학사일정 ─────────────
  async calendarMonth(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym)) throw new LibError('BAD_INPUT', '잘못된 월입니다.');
    const first = `${ym}-01`;
    // 하루씩 쿼리하면 최대 31번 왕복하게 되므로, 한 번에 불러와 메모리에서 찾는다.
    const [teacherRows, holidayRows] = await Promise.all([
      all(this.db, 'SELECT * FROM school_calendar'),
      all(this.db, 'SELECT * FROM public_holidays'),
    ]);
    const teacherMap = new Map(teacherRows.map(r => [r.date, r]));
    const holidayMap = new Map(holidayRows.map(r => [r.date, r]));
    const days = [];
    for (let d = first; d.startsWith(ym); d = addDays(d, 1)) {
      const t = teacherMap.get(d) || null;
      const h = holidayMap.get(d);
      days.push({ date: d, is_school_day: this.lib.cal.isSchoolDay(d), holiday: h?.name || null, teacher: t });
    }
    return days;
  }

  async setCalendarDay(date, { is_school_day, reason }, ctx) {
    if (!isValidDate(date)) throw new LibError('BAD_INPUT', '날짜가 올바르지 않습니다.');
    const before = (await get(this.db, 'SELECT * FROM school_calendar WHERE date=?', [date])) || null;
    await run(this.db, `INSERT INTO school_calendar(date, is_school_day, reason, source, updated_at, updated_by) VALUES (?, ?, ?, 'teacher', ?, ?)
      ON CONFLICT(date) DO UPDATE SET is_school_day=excluded.is_school_day, reason=excluded.reason, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [date, is_school_day ? 1 : 0, clean(reason, 100), nowISO(), ctx.actor.name || String(ctx.actor.id)]);
    await audit(this.db, ctx.actor, 'admin_calendar_set', 'calendar', null, { date, before, is_school_day: !!is_school_day, reason });
    await this.lib.cal.refresh();
    return { ok: true, impact: await this.lib.calendarImpact() };
  }

  async clearCalendarDay(date, ctx) {
    const before = (await get(this.db, 'SELECT * FROM school_calendar WHERE date=?', [date])) || null;
    await run(this.db, 'DELETE FROM school_calendar WHERE date=?', [date]);
    await audit(this.db, ctx.actor, 'admin_calendar_clear', 'calendar', null, { date, before });
    await this.lib.cal.refresh();
    return { ok: true, impact: await this.lib.calendarImpact() };
  }

  async setHoliday(date, name, ctx) {
    if (!isValidDate(date)) throw new LibError('BAD_INPUT', '날짜가 올바르지 않습니다.');
    await importHolidays(this.db, [[date, clean(name, 50) || '공휴일']]);
    await audit(this.db, ctx.actor, 'admin_holiday_set', 'calendar', null, { date, name });
    await this.lib.cal.refresh();
    return { ok: true };
  }

  async deleteHoliday(date, ctx) {
    await run(this.db, 'DELETE FROM public_holidays WHERE date=?', [date]);
    await audit(this.db, ctx.actor, 'admin_holiday_delete', 'calendar', null, { date });
    await this.lib.cal.refresh();
    return { ok: true };
  }

  // ───────────── 설정 ─────────────
  updateSettings(values, ctx) {
    return tx(this.db, async (client) => {
      const before = await getSettings(client);
      const now = nowISO();
      const changed = {};
      for (const [k, v] of Object.entries(values || {})) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        const n = Number(v);
        const min = ['suspension_multiplier'].includes(k) ? 0 : (k === 'max_extensions' ? 0 : 1);
        const max = k === 'student_idle_seconds' ? 3600 : 30;
        if (!Number.isInteger(n) || n < min || n > max) throw new LibError('BAD_INPUT', `설정 값이 올바르지 않습니다: ${k}`);
        if (n !== before[k]) {
          await run(client, 'UPDATE settings SET value=?, updated_at=?, updated_by=? WHERE key=?', [String(n), now, ctx.actor.name || String(ctx.actor.id), k]);
          changed[k] = { from: before[k], to: n };
        }
      }
      if (Object.keys(changed).length) await audit(client, ctx.actor, 'admin_settings', 'settings', null, changed);
      return { settings: await getSettings(client), changed };
    });
  }

  // ───────────── 대시보드·통계 ─────────────
  async dashboard(today) {
    const one = async (sql, ...a) => Number((await get(this.db, sql, a)).c);
    const [books_titles, books_copies, copies_available, copies_loaned, students, active_reservations,
      overdue, suspended_students, recent, popular] = await Promise.all([
      one("SELECT COUNT(*) c FROM books WHERE status='active'"),
      one("SELECT COUNT(*) c FROM copies c JOIN books b ON b.id=c.book_id WHERE b.status='active' AND c.status<>'discarded'"),
      one("SELECT COUNT(*) c FROM copies c JOIN books b ON b.id=c.book_id WHERE b.status='active' AND c.status='available'"),
      one("SELECT COUNT(*) c FROM copies WHERE status='loaned'"),
      one("SELECT COUNT(*) c FROM students WHERE status='active'"),
      one("SELECT COUNT(*) c FROM reservations WHERE status IN ('waiting','priority')"),
      this.listLoans({ status: 'overdue', today }),
      all(this.db, `SELECT s.id, s.name, MAX(l.suspension_until) AS until FROM loans l JOIN students s ON s.id=l.student_id
        WHERE l.suspension_until >= ? AND l.suspension_waived=0 GROUP BY s.id ORDER BY s.name`, [today]),
      all(this.db, `SELECT a.action, a.created_at, a.details, s.name AS student_name, b.title
        FROM audit_logs a LEFT JOIN loans l ON a.target_type='loan' AND l.id=a.target_id
        LEFT JOIN students s ON s.id=l.student_id LEFT JOIN copies c ON c.id=l.copy_id LEFT JOIN books b ON b.id=c.book_id
        WHERE a.action IN ('loan','return','admin_return','extend') ORDER BY a.id DESC LIMIT 12`),
      this.popular(null, null, 5),
    ]);
    return {
      today, is_school_day: this.lib.cal.isSchoolDay(today),
      books_titles, books_copies, copies_available, copies_loaned, students, active_reservations,
      suspended_students, overdue, recent, popular,
    };
  }

  async popular(from, to, limit = 10) {
    const [w, a] = range(from, to);
    return all(this.db, `SELECT b.id, b.title, b.author, b.category, COUNT(*) AS loans FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE ${w} GROUP BY b.id ORDER BY loans DESC, b.title LIMIT ?`, [...a, limit]);
  }

  async stats({ from, to }) {
    const [w, a] = range(from, to);
    const [total, all_time, monthly, by_student, top_books, by_category] = await Promise.all([
      get(this.db, `SELECT COUNT(*) c FROM loans l WHERE ${w}`, a).then(r => Number(r.c)),
      get(this.db, 'SELECT COUNT(*) c FROM loans').then(r => Number(r.c)),
      all(this.db, `SELECT substr(l.loan_date,1,7) AS month, COUNT(*) AS loans FROM loans l WHERE ${w} GROUP BY month ORDER BY month`, a),
      all(this.db, `SELECT s.id, s.name, s.number, COUNT(l.id) AS loans FROM students s LEFT JOIN loans l ON l.student_id=s.id AND ${w}
        WHERE s.status='active' GROUP BY s.id ORDER BY loans DESC, COALESCE(s.number, 9999), s.name`, a),
      this.popular(from, to, 10),
      all(this.db, `SELECT COALESCE(NULLIF(b.category,''),'미분류') AS category, COUNT(*) AS loans FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
        WHERE ${w} GROUP BY 1 ORDER BY loans DESC`, a),
    ]);
    return { from: from || null, to: to || null, total, all_time, monthly, by_student, top_books, by_category };
  }

  async auditLogs({ limit = 200, action } = {}) {
    const rows = action
      ? await all(this.db, 'SELECT * FROM audit_logs WHERE action ILIKE ? ORDER BY id DESC LIMIT ?', [`%${action}%`, limit])
      : await all(this.db, 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
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
