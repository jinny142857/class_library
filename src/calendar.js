// 수업일 계산 공통 함수. 대출 기한·연장·우선권·연체·정지가 모두 이 함수만 사용한다.
// 수업일이 아닌 날: 토·일, 법정 공휴일·대체공휴일, 교사가 등록한 휴업일.
// 교사가 특정 날짜를 '수업일'로 지정하면(예: 토요 수업) 그 지정이 우선한다.
//
// Postgres(Neon)는 네트워크 너머에 있어서, addSchoolDays/countSchoolDays처럼 하루씩 반복해서
// isSchoolDay를 수십~수백 번 호출하는 로직을 매번 쿼리로 날리면 너무 느려진다.
// 그래서 school_calendar·public_holidays(둘 다 작은 테이블)를 통째로 메모리에 올려두고,
// 이후 모든 날짜 계산은 순수 동기 함수로 처리한다. 값이 바뀌면(교사가 일정을 수정하면) refresh()로 다시 불러온다.
import { addDays, weekday } from './clock.js';
import { all } from './db.js';

export class SchoolCalendar {
  constructor(db) {
    this.db = db;
    this.teacherMap = new Map(); // date -> 0|1
    this.holidaySet = new Set(); // date
  }

  static async create(db) {
    const cal = new SchoolCalendar(db);
    await cal.refresh();
    return cal;
  }

  // 트랜잭션 도중(아직 COMMIT 전) 변경사항을 반영하려면 같은 client를 conn으로 넘겨야 한다.
  async refresh(conn = this.db) {
    const [teacherRows, holidayRows] = await Promise.all([
      all(conn, 'SELECT date, is_school_day FROM school_calendar'),
      all(conn, 'SELECT date FROM public_holidays'),
    ]);
    this.teacherMap = new Map(teacherRows.map(r => [r.date, Number(r.is_school_day)]));
    this.holidaySet = new Set(holidayRows.map(r => r.date));
  }

  isSchoolDay(date) {
    if (this.teacherMap.has(date)) return this.teacherMap.get(date) === 1;
    if (this.holidaySet.has(date)) return false;
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
