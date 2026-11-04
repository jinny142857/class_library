// ISBN 도서 정보 조회. 다음 순서로 시도한다(키가 설정된 곳만):
//   1) 국립중앙도서관 ISBN 서지정보 (NL_API_KEY) — 국내 아동 도서에 가장 정확
//   2) 카카오 책 검색 (KAKAO_REST_API_KEY)
//   3) Google Books (키 없이 사용 가능)
// 실패하거나 정보가 없으면 null 을 반환하고, 교사가 직접 입력한다.

export function normalizeIsbn(v) {
  const s = String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return s.length === 10 || s.length === 13 ? s : null;
}

const T = 6000;

async function nl(isbn, key) {
  const url = `https://www.nl.go.kr/seoji/SearchApi.do?cert_key=${encodeURIComponent(key)}&result_style=json&page_no=1&page_size=1&isbn=${isbn}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(T) });
  if (!r.ok) return null;
  const d = (await r.json())?.docs?.[0];
  if (!d?.TITLE) return null;
  return { title: d.TITLE, author: d.AUTHOR, publisher: d.PUBLISHER, cover_image: d.TITLE_URL || null, source: '국립중앙도서관' };
}

async function kakao(isbn, key) {
  const r = await fetch(`https://dapi.kakao.com/v3/search/book?target=isbn&query=${isbn}`, {
    headers: { Authorization: `KakaoAK ${key}` }, signal: AbortSignal.timeout(T),
  });
  if (!r.ok) return null;
  const d = (await r.json())?.documents?.[0];
  if (!d?.title) return null;
  return { title: d.title, author: (d.authors || []).join(', '), publisher: d.publisher, cover_image: d.thumbnail || null, source: '카카오' };
}

async function google(isbn) {
  const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, { signal: AbortSignal.timeout(T) });
  if (!r.ok) return null;
  const v = (await r.json())?.items?.[0]?.volumeInfo;
  if (!v?.title) return null;
  const img = v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') || null;
  return { title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title, author: (v.authors || []).join(', '), publisher: v.publisher || null, cover_image: img, source: 'Google Books' };
}

export async function lookupIsbn(raw) {
  const isbn = normalizeIsbn(raw);
  if (!isbn) return { ok: false, message: 'ISBN 형식이 올바르지 않습니다 (10자리 또는 13자리).' };
  const providers = [];
  if (process.env.NL_API_KEY) providers.push(() => nl(isbn, process.env.NL_API_KEY));
  if (process.env.KAKAO_REST_API_KEY) providers.push(() => kakao(isbn, process.env.KAKAO_REST_API_KEY));
  providers.push(() => google(isbn));
  const errors = [];
  for (const p of providers) {
    try {
      const r = await p();
      if (r) return { ok: true, isbn, ...r };
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { ok: false, isbn, message: '도서 정보를 찾지 못했습니다. 직접 입력해 주세요.', errors };
}
