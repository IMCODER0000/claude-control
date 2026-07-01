# Claude Control

폰이든 윈도우 노트북이든, 브라우저만 열면 집/회사에 있는 맥북의 **Claude Code · ChatGPT** 를 그대로 돌리는 웹 원격 조종 패널.

회사에서 받은 노트북은 윈도우인데 정작 개발 세팅이랑 로그인은 전부 맥북에 있다. 자리를 옮기거나 폰으로 잠깐 뭘 확인할 때마다 맥북 앞에 다시 앉아야 하는 게 은근 스트레스여서 만들었다. Tailscale로 내 기기끼리만 묶어두고, 브라우저에서 세션을 만들어 명령을 던지면 맥북에서 실제로 실행된다.

처음엔 Claude Code 하나만 붙였는데 쓰다 보니 ChatGPT(Codex)도 같이 굴리고 싶었고, 계정도 개인/회사를 나눠 써야 해서 결국 "프로필" 개념까지 들어갔다.

## 화면

메인 — 왼쪽에 세션 목록(엔진·계정 배지), 가운데 대화가 스트리밍으로 흐른다. 도구 실행/코드 블록도 그대로 렌더링.

![메인 화면](docs/screenshot-chat.png)

계정/프로필 관리 — AI별로 계정을 여러 개 등록해두고 세션마다 골라 쓴다. 로그인 폴더를 분리하거나 API 키를 넣는 방식.

![계정 관리](docs/screenshot-accounts.png)

파일 탐색기 — 맥북 파일시스템을 브라우저에서 바로 열어본다. 코드/이미지 미리보기, 다운로드, 폴더 선택까지.

![파일 탐색기](docs/screenshot-files.png)

## 되는 것들

- **여러 AI · 여러 계정** — 세션마다 Claude / ChatGPT 중에 고르고, 같은 AI라도 개인·회사 계정을 따로 붙일 수 있다. 서버가 실행할 때 해당 계정의 환경(설정 폴더나 API 키)을 주입해서 계정이 섞이지 않는다.
- **멀티 세션** — 세션을 여러 개 열어두고 각각 대화 맥락을 유지한다(`--resume`). 한쪽이 돌아가는 동안 다른 세션을 봐도 된다.
- **실시간 스트리밍** — 답변, 사고 과정, 도구 호출/결과가 나오는 대로 브라우저로 흐른다. 실행 중엔 정지 버튼으로 중단.
- **파일 탐색기** — 폴더 이동, 파일 열람(텍스트/이미지), 다운로드. 새 세션 만들 때 작업 폴더를 여기서 바로 고른다.
- **폰까지 고려** — 다크/라이트 테마, 모바일 레이아웃, 안전영역(노치) 대응. 급하면 폰으로도 지시할 수 있다.

## 구조

의존성은 `express`, `ws` 딱 두 개다. 무겁게 가고 싶지 않았다.

- `server.js` — Express + WebSocket. 메시지가 오면 세션의 프로필에 맞춰 `claude` 또는 `codex` 프로세스를 spawn하고, 두 CLI의 출력을 **하나의 이벤트 포맷으로 정규화**해서 브라우저로 중계한다. 프론트는 어떤 AI가 도는지 몰라도 된다.
- `public/` — 로그인 + 멀티세션 채팅 UI. 프레임워크 없이 순수 JS, 마크다운 렌더러도 직접 짰다.
- `data/` — 비밀번호 해시·API 토큰, 세션 기록, 프로필. **여긴 커밋 안 된다**(`.gitignore`).

## 실행

```bash
git clone https://github.com/IMCODER0000/claude-control.git
cd claude-control
npm install
node server.js
```

첫 실행 때 아이디/비밀번호가 콘솔에 찍힌다. 바꾸려면:

```bash
node server.js --set-password
```

당연히 맥북에 `claude` CLI가 깔려 있어야 하고, ChatGPT 쪽을 쓰려면 `npm i -g @openai/codex` 후 계정 로그인이 필요하다. 프로필 관리 화면에서 계정마다 로그인 명령을 복사해 터미널에 붙여넣으면 된다.

## 접속 (Tailscale 전용)

기본적으로 맥북의 Tailscale IP에 바인딩된다. 같은 테일넷에 있는 기기에서:

```
http://<맥북 테일넷 IP>:8787
```

IP는 `tailscale ip -4` 로 확인. 회사망에서 막혀도 Tailscale이 보통 릴레이로 뚫어준다. 정 안 되면 `cloudflared tunnel` 로 임시 공개 주소를 파는 방법도 있는데, 이땐 비밀번호가 유일한 방어선이 되니 조심.

## 자동 실행

맥북 로그인 시 자동으로 뜨고 죽으면 되살아나게 launchd에 걸어뒀다.

```bash
launchctl list | grep claude-control          # 상태
launchctl unload ~/Library/LaunchAgents/com.choi.claude-control.plist   # 중지
launchctl load   ~/Library/LaunchAgents/com.choi.claude-control.plist   # 시작
```

## 주의

권한 확인 없이(`bypassPermissions`) 실행된다. 즉 브라우저에서 넣은 명령이 맥북에서 **바로** 돈다. 편하려고 그렇게 뒀지만, 그만큼 **비밀번호 + 테일넷이 사실상 유일한 방어선**이다. 아무 데서나 열지 말 것. 공개 저장소지만 실제 로그인 정보·세션 기록은 `data/`에 있고 커밋되지 않는다.

## 아직 남은 것

- ChatGPT(Codex) 출력 파서는 실제 버전 출력 보면서 더 다듬어야 한다. 버전마다 JSON 스키마가 조금씩 달라서 지금은 관대하게 받아두는 정도.
- 세션 검색, 대화 내보내기 정도는 조만간.
