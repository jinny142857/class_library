// Vercel 서버리스 진입점. server.js의 라우팅/비즈니스 로직을 그대로 재사용한다.
// (req, res)가 Node의 기본 http 객체와 같은 모양이라 server.js의 handle()을 바로 쓸 수 있다.
import { getApp } from '../server.js';

export default async function handler(req, res) {
  const { handle } = await getApp();
  return handle(req, res);
}
