// 수업일 계산 공통 함수. 대출 기한·연장·우선권·연체·정지가 모두 이 함수만 사용한다.
// 수업일이 아닌 날: 토·일, 법정 공휴일·대체공휴일, 교사가 등록한 휴업일.
// 교사가 특정 날짜를 '수업일'로 지정하면(예: 토요 수업) 그 지정이 우선한다.
import { addDays, weekday } from './clock.js';

export class SchoolCalendar {
  constructor(db) {
    this.db = db;
    this.teacher = db.prepare('SELECT is_school_day FROM school_calendar WHERE date = ?');
    this.holiday = db.prepare('SELECT 1 FROM public_holidays WHERE date = ?');
  }

  isSchoolDay(date) {
    const row = this.teacher.get(date);
    if (row) return row.is_school_day === 1;
    if (this.holiday.get(date)) return false;
    const w = weekday(date);
    return w !== 0 && w !== 6;
  }

  // date 다음(당일 제외)의 n번째 수업일. n=0 이면 date 그대로.
  addSchoolDays(date, n) {
    let d = date;
    let left = n;
    let guard = 0;
    while (left > 0) {
      d = addDays(d, 1);
      if (this.isSchoolDay(d)) left--;
      if (++guard > 3660) throw new Error('수업일을 찾을 수 없습니다. 학사일정을 확인해 주세요.');
    }
    return d;
  }

  nextSchoolDay(date) {
    return this.addSchoolDays(date, 1);
  }

  // (from, to] 구간의 수업일 수. to <= from 이면 0.
  countSchoolDays(from, to) {
    if (to <= from) return 0;
    let n = 0;
    let d = from;
    while (d < to) {
      d = addDays(d, 1);
      if (this.isSchoolDay(d)) n++;
    }
    return n;
  }
}
