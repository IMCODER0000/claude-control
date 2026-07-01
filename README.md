# Claude Control

윈도우 노트북(또는 폰) 브라우저에서 이 맥북의 Claude Code를 원격 조종하는 웹 서비스.
Tailscale 테일넷 위에서만 동작하며, 비밀번호 로그인으로 보호됩니다.

## 접속

- **윈도우 노트북에서:** 브라우저로 `http://100.102.92.15:8787`
  (맥북의 Tailscale IP. `tailscale ip -4` 로 확인)
- **로그인:** 아이디 `a123` / 비밀번호 `a123`
  - 변경: `cd ~/claude-control && node server.js --set-password` (아이디·비밀번호 둘 다 물어봄)

## 사용법

1. 왼쪽 `+ 새 세션` → 작업 폴더(claude를 실행할 경로) 입력
2. 메시지 입력 → Enter 전송 (Shift+Enter 줄바꿈)
3. 세션은 여러 개 만들 수 있고, 각각 대화 맥락(claude --resume)이 유지됨
4. 상단에서 모델 선택, 작업 폴더(경로 클릭) 변경 가능
5. 실행 중에는 전송 버튼이 ■(정지)로 바뀜 — 누르면 중단

> ⚠️ 권한 확인 없이 실행됩니다(`bypassPermissions`). 즉 입력한 명령은 맥북에서
> 바로 실행됩니다. 신뢰하는 명령만 입력하세요. 비밀번호 + 테일넷이 유일한 방어선입니다.

## 자동 실행 (launchd)

맥북 로그인 시 자동 시작 + 죽으면 자동 재시작하도록 등록돼 있습니다.

```bash
# 상태 확인
launchctl list | grep claude-control
# 중지
launchctl unload ~/Library/LaunchAgents/com.choi.claude-control.plist
# 시작 / 재시작
launchctl load ~/Library/LaunchAgents/com.choi.claude-control.plist
# 로그
tail -f ~/claude-control/data/server.log
```

## 회사 와이파이에서 안 될 때

Tailscale은 보통 회사망에서도 DERP 릴레이(TCP 443)로 폴백해 연결됩니다.
완전히 차단된다면 Cloudflare Tunnel로 폴백하세요(공개되므로 비밀번호 필수):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
# 출력되는 https://....trycloudflare.com 주소로 어디서든 접속
```
※ 이 경우 서버를 localhost에도 바인딩해야 합니다: `HOST=0.0.0.0 PORT=8787 node server.js`
(plist의 EnvironmentVariables에 `HOST=0.0.0.0` 추가)

## HTTPS로 쓰고 싶다면 (선택)

```bash
tailscale serve --bg --https=443 http://localhost:8787
# https://macbookpro.<테일넷>.ts.net 로 접속 (테일넷 전용, 공개 아님)
```
※ serve를 쓰려면 서버를 localhost 바인딩으로 두는 게 편함(`HOST=0.0.0.0`).

## 구조

- `server.js` — Express + WebSocket. 메시지마다 `claude -p --output-format stream-json`
  프로세스를 spawn하여 스트리밍 파싱 → 브라우저로 중계. 세션별 `--session-id`/`--resume`.
- `public/` — 로그인 + 멀티세션 채팅 UI (의존성 없는 순수 JS, 자체 마크다운 렌더러)
- `data/config.json` — 비밀번호 해시 + API 토큰
- `data/sessions.json` — 세션 메타 + 대화 기록

## 기본값 / 환경변수

- `PORT` (기본 8787)
- `HOST` (기본: Tailscale IP, 없으면 0.0.0.0) — 테일넷 전용으로 두려면 그대로
