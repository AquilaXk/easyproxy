# Foundations

## Color

색상 토큰은 역할을 나타낸다. 컴포넌트에서 hex 값을 직접 사용하지 않는다. 캔버스는 Obsidian-Slate 중립 팔레트(`#f8fafc` 라이트 / `#0b0e14` 다크)를 기반으로 한다.

| 역할 | 토큰 | 라이트 | 다크 |
|---|---|---:|---:|
| 사이드바 레일 | `--rail` (`--epx-rail`) | `#f1f5f9` | `#080b10` |
| 앱 배경 | `--bg` (`--epx-bg`) | `#f8fafc` | `#0b0e14` |
| 기본 표면 | `--surface` (`--epx-surface`) | `#ffffff` | `#111620` |
| 보조 표면 | `--epx-surface-2` | `#f1f5f9` | `#161d2a` |
| 올라온 표면 | `--raised` (`--epx-raised`) | `#ffffff` | `#1b2333` |
| 안쪽 표면 | `--epx-inset` | `#f1f5f9` | `#0d1118` |
| 기본 텍스트 | `--text` (`--epx-fg`) | `#0f172a` | `#f8fafc` |
| 보조 텍스트 | `--muted` (`--epx-fg-muted`) | `#475569` | `#a6b3c6` |
| 약한 텍스트 | `--faint` (`--epx-fg-subtle`) | `#5b687b` | `#8b99af` |
| 성공/활성 | `--green` (`--epx-success`) | `#0e9f6e` | `#34d399` |
| 경고 | `--amber` (`--epx-warning`) | `#c2410c` | `#fbbf24` |
| 위험 | `--red` (`--epx-danger`) | `#dc2626` | `#f87171` |

`--accent`는 기본 액션에, `--accent-ring`은 포커스에 사용한다. 활성 토글은 다크 모드에서도 트랙과 핸들이 구분되도록 `--toggle-on-bg`와 `--toggle-dot-color`를 사용한다.

### v2 색 역할 (`src/design/theme.css`)

v2는 위 v1 토큰을 `src/design/bridge.css`에서 아래 `--epx-*` 토큰으로 다시 연결한다.

| 역할 | 토큰 | Tailwind | 라이트 | 다크 |
|---|---|---|---:|---:|
| 메인(기본 버튼, 선택 상태, 켜진 토글) | `--epx-accent` | `bg-accent` | `#1d4ed8` | `#2563eb` |
| 메인 상단/하단 톤 | `--epx-accent-top` / `--epx-accent-bottom` | `bg-accent-top` / `bg-accent-bottom` | `#2563eb` / `#1e40af` | `#3b82f6` / `#1d4ed8` |
| 메인 위 글자 | `--epx-on-accent` | `text-on-accent` | `#ffffff` | `#ffffff` |
| 하이라이트(포커스 링, 링크) | `--epx-highlight` | `text-highlight` | `#2563eb` | `#60a5fa` |
| 하이라이트 바탕 | `--epx-highlight-soft` | `bg-highlight-soft` | `rgb(37 99 235 / 0.14)` | `rgb(96 165 250 / 0.2)` |
| 기본 버튼 상단 광택 | `--epx-glow` / `--epx-glow-hover` | `shadow-glow` / `shadow-glow-hover` | `inset 0 1px 0 0 rgb(255 255 255 / 0.18)` | `inset 0 1px 0 0 rgb(255 255 255 / 0.18)` |

Obsidian-Slate 배경(`#f8fafc` 라이트 / `#0b0e14` 다크) 위에서 Cobalt 파랑(`#1d4ed8` 라이트 / `#2563eb` 다크)을 기본 액션 색으로 쓰고, Sapphire(`#2563eb` 라이트 / `#60a5fa` 다크)를 포커스 링과 링크에 쓴다. 차트는 상태 색과 분리된 `--epx-chart-1`..`6` 범주 팔레트를 사용한다.

## Typography

### Font families

- `--font-ui`: `"Geist Variable"`, `"Wanted Sans Variable"`, 시스템 UI 글꼴 순으로 선언한다. 영문·숫자는 `Geist Variable`이 먼저 처리하고 한글은 `Wanted Sans Variable`이 이어받으며, 중문·일문은 `:root:lang(...)` 규칙으로 해당 언어의 시스템 글꼴을 우선한다.
- `--font-code`: `"Geist Mono Variable"`, `"Wanted Sans Variable"`, `ui-monospace` 순으로 선언하며 모델 ID, URL, 버전, 토큰 수, 로그, 코드에 사용한다. 숫자는 tabular 형태로 정렬한다.

모든 제품 서체(`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`, `wanted-sans`)는 번들에 내장하며 외부 CDN 폰트를 사용하지 않는다. 프록시 관리 화면은 오프라인에서도 열려야 하고 폰트 다운로드 실패가 레이아웃 이동이나 한글 누락으로 이어지면 안 되기 때문이다.

### Type scale

| 역할 | 클래스 | 토큰 | 크기 | 대표 용도 |
|---|---|---|---:|---|
| Micro | `.text-micro` | `--text-micro` | 10px | 매우 작은 상태 배지 |
| Caption | `.text-caption` | `--text-caption` | 11px | 메타데이터, 보조 수치 |
| Label | `.text-label` | `--text-label` | 12px | 필드 라벨, 표 헤더, 코드 |
| Control | `.text-control` | `--text-control` | 13px | 버튼, 메뉴, 필터, 알림 |
| Body | `.text-body` | `--text-body` | 14px | 본문, 카드 제목 |
| Subtitle | `.text-subtitle` | `--text-subtitle` | 16px | 모달 제목, 브랜드명 |
| Title | `.text-title` | `--text-title` | 20px | 페이지 제목, 주요 수치 |
| Display | `.text-display` | `--text-display` | 24px | 제한적인 대형 수치/빈 상태 |

굵기는 `regular(400)`, `medium(500)`, `semibold(600)`, `bold(700)` 네 단계만 사용한다.
행간은 `tight(1.2)`, `ui(1.35)`, `body(1.5)`, `relaxed(1.6)` 네 단계만 사용한다.

## Spacing

기본 단위는 4px이다.

| 토큰 | 값 | 토큰 | 값 |
|---|---:|---|---:|
| `--space-0-5` | 2px | `--space-1` | 4px |
| `--space-1-5` | 6px | `--space-2` | 8px |
| `--space-3` | 12px | `--space-4` | 16px |
| `--space-5` | 20px | `--space-6` | 24px |
| `--space-8` | 32px | `--space-10` | 40px |
| `--space-12` | 48px | `--space-16` | 64px |

컴팩트 컨트롤 내부는 4–8px, 카드 내부는 12–20px, 페이지 구획은 24–64px 범위를 사용한다.

## Radius and controls

| 토큰 | 값 | 용도 |
|---|---:|---|
| `--radius-2xs` | 4px | 작은 차트 셀, 포커스 보정 |
| `--radius-xs` | 6px | 칩, 작은 아이콘 표면 |
| `--radius-sm` | 8px | 입력, 메뉴 항목, 작은 카드 |
| `--radius` | 12px | 기본 카드/패널 |
| `--radius-lg` | 16px | 모달 |
| `--radius-round` | 50% | 점, 원형 아이콘 |
| `--radius-pill` | 999px | 버튼, 토글, segmented control |

컨트롤 높이는 `28/34/40/44px` 단계다. 44px는 모바일 터치 영역에 사용한다.

### Control sizes (v2)

버튼, 입력창, 선택 상자, 세그먼트 트랙은 아래 두 높이 중 하나만 쓴다. 높이를 패딩으로 만들지
않고 토큰으로 정한 뒤 내용을 가운데 정렬한다.

| 크기 | 토큰 | 높이 | 쓰는 곳 |
|---|---|---:|---|
| md (기본) | `--epx-control-h` (= v1 `--control-md`) | 34px | 버튼, 입력창, 선택 상자, 세그먼트 트랙, 아이콘 버튼 |
| sm | `--epx-control-h-sm` (= v1 `--control-sm`) | 28px | 툴바·카드 머리의 작은 버튼, 작은 세그먼트 |

- **짝 맞춤:** 같은 줄에 입력창이나 선택 상자와 함께 놓인 버튼은 md다. 작은 버튼(`.btn-sm`)도
  그 줄에서는 md로 커진다(bridge.css). 한 줄은 하나의 컨트롤처럼 읽혀야 한다.
  v2 `Button`의 `sm`도 같다: 입력·선택이 든 줄의 직계 자식에 `--epx-row-control-h`가 들어가고
  `sm`은 그 값을 먼저 읽는다(상속되지 않는 속성이라 그 줄 바로 아래 버튼에만 적용).
- **세그먼트:** 트랙 안쪽 여백 2px + 항목 높이(컨트롤 높이 − 4px) = 컨트롤 높이 하나.
- **예외:** 텍스트 줄 안의 "?" 도움말 아이콘처럼 컨트롤이 아닌 보조 아이콘은 이 규칙 밖이다.
- **v2 코드:** `Button`의 `md`/`sm`/`icon`, `SegmentedControl`의 `md`/`sm`이 이 토큰을 쓴다.
  Tailwind로 직접 버튼을 만들 때는 `h-[var(--epx-control-h)]`처럼 토큰을 쓴다(`h-7`, `h-8`,
  `h-9` 같은 임의 높이 금지).
- `gui/tests/control-size-rule.test.ts`가 토큰과 이 규칙이 bridge와 v2 컴포넌트에 남아 있는지
  확인한다.

## Motion

- `--motion-fast: 120ms`: hover, border, color 변화
- `--motion-normal: 180ms`: drawer, toggle, 위치 변화
- `prefers-reduced-motion: reduce`에서는 transition과 animation을 제거한다.

모션은 상태 이해를 돕는 범위에서만 사용하며 장식 목적의 반복 애니메이션은 추가하지 않는다.

### v2 둥글기 주의

v1 토큰 `--radius-xs`, `--radius-sm`, `--radius-lg`는 Tailwind의 `rounded-xs`, `rounded-sm`,
`rounded-lg`가 읽는 변수와 이름이 같다. v1 값(6px, 8px, 12px)이 이기므로 v2 컴포넌트에서는
이 세 유틸리티를 쓰지 않는다. `rounded-control`, `rounded-card`처럼 v2 이름을 쓰거나
`rounded-[8px]`처럼 값을 명시한다.

## Professional pass (v2)

도구다운 대시보드(Linear, Vercel, Stripe 계열)를 기준으로 한다. 꾸밈이 아니라 정보가 먼저 보여야 한다.
`gui/tests/professional-rules.test.ts`가 아래 규칙을 지킨다.

### 캔버스와 표면

- 페이지 바탕은 단색 `--epx-bg` 하나다. 배경 그라데이션, 흐린 색 덩어리, 유리(backdrop-filter) 금지.
- 사이드바는 단색 레일(`--rail`)과 오른쪽 1px 경계선.
- 카드와 패널은 1px 경계선(`--epx-line`)으로 구분한다. 그림자는 떠 있는 것(메뉴, 대화상자)에만.

### Radius

| 토큰 | 값 | 쓰는 곳 |
|---|---:|---|
| `--radius-control` / `rounded-control` | 8px | 버튼, 입력, 선택 |
| `--radius-card` / `rounded-card` | 10px | 카드, 타일 |
| `--radius-panel` / `rounded-panel` | 12px | 패널, 섹션 |
| `--radius-sheet` | 16px | 대화상자 |
| `--radius-full` / `rounded-full` | 9999px | 알약, 원형 버튼·점 |

알약(999px)은 상태 배지와 스위치에만 쓴다. v1 스타일시트의 `--radius-pill`은 999px 그대로다.
`rounded-full`은 Tailwind 기본값 `calc(infinity * 1px)` 대신 유한한 9999px로 고정한다. 기본값은
2147483647px로 빌드되고, macOS WKWebView가 이 값을 각진 모서리로 그릴 수 있다(#8281).

### Type

| 단계 | 크기 | 쓰는 곳 |
|---|---:|---|
| title (`text-title`) | 20px / 600 | 페이지 제목 |
| stat (`text-stat`) | 22px / 600 | 지표 숫자 |
| section | 14px / 600 | 섹션·카드 제목 |
| body | 13px / 400–500 | 본문, 컨트롤, 사이드바 |
| meta | 12px | 보조 설명, 단위 |

숫자는 UI 글꼴의 고정폭 숫자(`tabular-nums`)로 쓴다. 고정폭(mono) 글꼴은 id, 명령, 경로 같은
기계 텍스트에만 쓴다.

### Motion and decoration

- 상태 점은 깜빡이지 않는다(`animate-ping`/`animate-pulse` 금지). 움직임은 상태가 바뀔 때만(전환, 진행 중 스피너) 사용한다.
- 버튼은 단색 채움이다. 배경 그라데이션이나 과한 네온 번짐을 넣지 않으며, primary 버튼의 상단 1px 하이라이트는 `--epx-glow` / `--epx-glow-hover` 토큰으로 표현한다.
- 기능적인 그라데이션(로딩 스켈레톤, 단색 사각형으로 그린 아이콘)은 예외다.

### 색

Obsidian-Slate 중립 표면 위에서 Cobalt(`--epx-accent`, 라이트 `#1d4ed8` / 다크 `#2563eb`)를 기본 액션과 활성 내비게이션 강조에 쓴다. Sapphire(`--epx-highlight`, 라이트 `#2563eb` / 다크 `#60a5fa`)는 포커스 링과 링크에 쓰며, 상태 표현은 `--epx-success` / `--epx-warning` / `--epx-danger`로 구분한다.

### Sidebar

- 메뉴 행 32px, 13px medium, 아이콘 16px. 텍스트는 `--epx-fg-muted`, 아이콘은 `--epx-fg-subtle`을 쓰고 활성 항목 아이콘은 `--epx-accent`로 맞춘다.
- 호버와 현재 페이지는 은은한 톤 단계 하나만 쓴다. 떠 있는 판, 링, 그림자를 넣지 않는다.
- 분류 제목(`Everyday`, `Fine-tuning`)은 12px, 문장형(대문자 변환 없음)이다.
- 아래쪽은 1px 경계선(`--epx-line`) 아래 32px 높이의 푸터 행들이다: `ProxyControls` 상태·제어 행, 언어 + `ThemeSwitch` 행(`.sidebar-pref-row`), GitHub + 버전 행(`.sidebar-github-row`), 데스크톱 전용 줌 행(`.sidebar-meta-row`).
- 프록시 제어는 `ProxyControls`(`gui/src/components/ui-v2/proxy-controls.tsx`)로 통일한다. 정지된 상태 점(정상 `bg-success`, 중지 중 `bg-danger`, 오프라인 `bg-fg-subtle`), 레이블 + 가동 시간(`tabular-nums`) 또는 진행 상태 문구, 그리고 명시적인 아이콘 버튼(세션 종료, Codex 카탈로그 새로고침 `IconRefresh`, 프록시 중지 `IconPower`)으로 시작·중지·재시작을 제어한다.
- 진행 중 상태(`stopping`은 `--epx-danger`, `restarting`은 `--epx-highlight`와 `IconRefresh`의 `animate-spin`)만 강조 색과 회전을 사용하며 장식용 애니메이션은 두지 않는다.

### 레이아웃

본문 열은 최대 1120px, 좌우 40px 여백. 페이지 머리는 제목(20px) + 한 줄 설명 + 오른쪽 동작.
