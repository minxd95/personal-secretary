# Ubuntu 24.04 / Lightsail 배포

Node.js 24, npm, Git, PM2를 설치한 Ubuntu 서버에서 일반 사용자 `ubuntu`로 운영합니다. 예시 경로는 `/home/ubuntu/personal-secretary/parcel-bot`입니다. Node 설치 경로는 서버에서 확인해 사용하고, 맥의 `.node-path`나 `node_modules`는 복사하지 않습니다.

봇은 외부 HTTPS 요청과 텔레그램 long polling을 사용합니다. 웹 서버, 도메인, HTTP 수신 포트가 필요하지 않습니다. 같은 텔레그램 토큰으로 실행되는 운영 프로세스는 전체 환경에서 하나만 유지합니다.

## 1. 서버 준비 및 빌드

Node 설치 후 메이저 버전이 24인지 확인합니다. PM2는 해당 Node 환경에 설치합니다.

```sh
node --version
npm --version
git --version
npm install --global pm2
git clone https://github.com/minxd95/personal-secretary.git "$HOME/personal-secretary"
cd "$HOME/personal-secretary/parcel-bot"
npm ci
npm run setup
npm test
```

이 단계에서는 `pm2:start`를 실행하지 않습니다. `npm run setup`은 비어 있는 설정 파일과 데이터·로그 폴더를 만들고, 서버의 Node 실행 경로를 `.node-path`에 저장합니다. 기존 `.env`가 있으면 유지합니다.

## 2. 운영 전환 직전 확인

- 서버 IP와 SSH 호스트 키를 확인하고 SSH 접속을 준비합니다.
- 서버의 운영 봇은 아직 시작하지 않습니다.
- 맥의 `.env`에 지정된 `DATABASE_PATH`를 확인합니다. 기본값은 `data/parcel-bot.sqlite`이며 사용자 지정 경로라면 해당 DB를 이전합니다.
- 서버에서 실제 CJ 조회 연결을 검사할 때는 본인의 운송장으로 `npm run smoke:cj -- 운송장번호`를 실행합니다. 결과에는 상태와 이벤트 수만 출력됩니다.

## 3. 맥 중지 및 데이터 이전

맥에서 `parcel-bot`만 중지합니다. 다른 앱을 함께 멈추는 `pm2 stop all`은 사용하지 않습니다.

```sh
cd personal-secretary/parcel-bot # 실제 로컬 저장소 위치로 이동
npm run pm2:stop
pm2 describe parcel-bot
```

프로세스가 중지됐고 SQLite를 쓰는 다른 프로세스가 없는지 확인한 후 다음 작업을 순서대로 진행합니다.

1. 맥의 `.env`와 실제 DB를 로컬 비공개 백업에 보관합니다.
2. `.env`, SQLite 본체와 남아 있는 `-wal`·`-shm` 파일을 SSH/SCP로 서버에 직접 전송합니다. 데이터는 GitHub를 거치지 않습니다.
3. 서버에는 기존 DB가 없는지 확인합니다. 있다면 먼저 별도 백업하고 중지 상태에서 복원합니다.
4. PID 잠금 파일 `*.lock`과 맥의 `.node-path`는 복사하지 않습니다. DB의 WAL 파일만 빠뜨린 채 본체를 복사하지 않도록 주의합니다.
5. 서버 `.env`의 `DATABASE_PATH`를 서버 경로에 맞춥니다. 기본 배치는 `./data/parcel-bot.sqlite`입니다. 토큰과 관리자 ID는 유지합니다.

서버에서 권한을 제한합니다.

```sh
cd "$HOME/personal-secretary/parcel-bot"
chmod 600 .env
chmod 700 data logs
find data -type f -exec chmod 600 {} +
```

맥에서도 자동 복구 목록을 갱신하려면 중지 상태를 확인한 뒤 `pm2 save`를 실행합니다. 이 명령은 다른 앱을 포함한 현재 PM2 목록을 저장하므로, 저장 전 다른 앱의 상태도 확인합니다. 운영 전환이 끝난 뒤 맥에서 이 봇을 다시 켜지 않습니다.

## 4. 서버 시작 및 재부팅 복구

```sh
cd "$HOME/personal-secretary/parcel-bot"
npm run pm2:start
pm2 status parcel-bot
pm2 logs parcel-bot --lines 50 --nostream
pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

마지막 명령이 출력한 `sudo` 명령을 확인한 뒤 실행합니다. 이 작업은 PM2를 Ubuntu의 systemd 부팅 서비스에 등록합니다. 이어서 정상 실행 상태를 저장합니다.

```sh
pm2 save
systemctl is-enabled pm2-ubuntu
systemctl status pm2-ubuntu --no-pager
```

이 서버에서는 `pm2 startup launchd`를 사용하지 않습니다. launchd는 macOS용입니다. Node를 교체하면 `npm run setup`으로 `.node-path`를 갱신하고 PM2 부팅 서비스의 경로도 갱신합니다.

## 5. 동작 확인 및 복구

- 텔레그램에서 `/status`, `/list all`로 기존 등록이 유지되는지 확인합니다.
- `/track`으로 실제 배송 조회와 응답을 확인합니다.
- 서버의 `parcel-bot`만 재시작하고 다시 명령에 응답하는지 확인합니다.
- Telegram 409 오류가 발생하면 맥이나 다른 환경에 동일 토큰으로 실행 중인 봇이 없는지 확인합니다.
- 재부팅 시험은 서버의 다른 앱에도 영향을 주므로 별도 작업 시간에 진행합니다.

전환에 실패하면 서버 봇을 먼저 중지합니다. 서버에서 새 명령이나 배송 상태를 처리했다면 **최신 서버 DB를 먼저 보존**하고, 중지된 맥에 동일한 최신 DB를 복원한 뒤 맥 봇을 시작합니다. 두 환경을 동시에 켜거나 새 데이터를 버리고 옛 백업으로 바로 돌아가지 않습니다.

## 업데이트와 백업

일반 업데이트는 `git pull --ff-only`, `npm ci`, `npm test`, `npm run pm2:restart` 순서로 수행합니다. `.env`와 DB는 Git의 영향을 받지 않습니다. DB 스키마를 바꾸는 업데이트 전에는 봇을 중지한 상태에서 DB를 백업합니다.

Lightsail 스냅샷은 서버 복구용으로 활용하고, SQLite 백업도 별도로 관리합니다. 실행 중 DB 본체만 단순 복사하는 방식은 피하고 SQLite 온라인 백업 기능을 쓰거나 앱을 잠시 중지한 뒤 WAL을 포함해 보관합니다. 스냅샷 등 추가 비용이 발생하는 서비스는 비용과 보관 정책을 결정한 뒤 설정합니다.
