# Personal Secretary

개인용 자동화 앱을 모아 운영하는 저장소입니다. 앱마다 별도 폴더와 실행 설정을 사용합니다.

| 앱 | 기능 | 실행 환경 |
| --- | --- | --- |
| [parcel-bot](parcel-bot/README.md) | CJ대한통운 배송조회와 텔레그램 알림, 관리자 승인 및 사용자별 관리 | Node.js 24, PM2, SQLite |

## 로컬 실행

저장소 루트에서 다음 명령을 실행합니다.

```sh
cd parcel-bot
npm ci
npm run setup
# 생성된 .env에 봇 토큰과 관리자 ID를 직접 입력합니다.
npm run pm2:start
```

사용법과 설정은 [parcel-bot 안내](parcel-bot/README.md), Ubuntu 서버 배포는 [배포 안내](parcel-bot/docs/deploy-ubuntu.md)를 참고하세요.

## 저장소에 포함하지 않는 파일

토큰이 담긴 `.env`, 사용자·운송장 데이터가 저장된 SQLite DB, 로그, 백업, SSH 키는 Git에 포함하지 않습니다. 서버로 이전할 때는 SSH/SCP로 직접 전송합니다. `.env.example`에는 설정 이름과 기본값만 제공합니다.

## 검증

```sh
cd parcel-bot
npm test
npm run check
```

PM2가 설치된 환경에서는 `npm run verify:pm2`로 격리된 테스트 프로세스의 실행·재시작을 검증할 수 있습니다. 실제 토큰이나 운영 DB를 사용하지 않습니다.
