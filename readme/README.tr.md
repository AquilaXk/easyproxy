<p align="center">
  <img src="../assets/banner.png" alt="easyproxy — Codex, Claude Code, Claude Desktop, Grok Build ve diğerleri için tek bir yerel ağ geçidi" width="100%">
</p>

<h3 align="center">AI kodlama araçlarınız ve modelleriniz için tek bir yerel ağ geçidi.</h3>
<p align="center"><b>Seçtiğiniz modelleri Codex, Claude Code, Claude Desktop ve Grok Build ile kullanın;<br>OpenCode, Pi, Qoder, WorkBuddy, Kilo, Cline, T3 Code ve diğerlerini yönetilen yapılandırmalarla bağlayın.</b><br>
<a href="https://easyproxy.me/tr/reference/client-support/">Desteklenen tüm araçları görün →</a></p>

<p align="center">
  <a href="https://www.npmjs.com/package/easyproxy"><img src="https://img.shields.io/npm/v/easyproxy?color=cb3837&label=npm&logo=npm" alt="npm sürümü"></a>
  <a href="https://github.com/AquilaXk/easyproxy/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/easyproxy?color=blue" alt="lisans"></a>
  <img src="https://img.shields.io/node/v/easyproxy?logo=node.js&label=node" alt="node sürümü">
</p>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start
```

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/macOS-.dmg-24292f?logo=apple&logoColor=white" alt="macOS için indir (.dmg)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Windows-.msi-24292f?logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0zIDNoOC41djguNUgzem05LjUgMEgyMXY4LjVoLTguNXpNMyAxMi41aDguNVYyMUgzem05LjUgMEgyMVYyMWgtOC41eiIvPjwvc3ZnPg==" alt="Windows için indir (.msi)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Linux-.AppImage-24292f?logo=linux&logoColor=white" alt="Linux için indir (.AppImage)"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img src="https://img.shields.io/badge/Linux-.deb-24292f?logo=debian&logoColor=white" alt="Linux için indir (.deb)"></a>
</p>

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code, istediğiniz modelle

Seçici Claude Code'un kendi seçicisi. Arkasındaki beyin değil.

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="easyproxy üzerinden yönlendirilen bir modeli çalıştıran Claude Code — durum çubuğunda etkin model olarak gpt-5.6-luna-medium görünüyor" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex, istediğiniz modelle

Bir sağlayıcı seçin ve başlayın — aynı iş akışı, farklı beyin.

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="easyproxy demosu — Codex uygulamasında OpenAI dışı bir yönlendirilmiş modelle görev çalıştırma" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop, istediğiniz modelle

Opus yanıtlıyor, sonra görevi bir GPT-5.6 Sol alt ajanına devrediyor.

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Opus 4.8 olarak yanıtlayan, ardından easyproxy üzerinden bir GPT-5.6 Sol alt ajanı başlatan Claude Desktop" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build, istediğiniz modelle

Sol oturumu yürütüyor ve bir Kimi K3 alt ajanını çağırıyor.

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="easyproxy üzerinden GPT-5.6 Sol çalıştıran ve bir Kimi K3 alt ajanı çağıran Grok Build" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <b>Türkçe</b> · 📖 <a href="https://easyproxy.me/tr/"><b>Tüm dokümantasyon →</b></a>
</p>

easyproxy, kodlama araçlarınızla model sağlayıcılarınız arasında çalışan hafif bir yerel ağ geçididir. Responses, Chat Completions ve Anthropic Messages API isteklerini kabul edip sağlayıcınızın protokolüne çevirir; istemci, model ve sağlayıcı desteklediğinde akış, araç çağrıları, akıl yürütme ve görselleri aktarır. Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama ve diğer sağlayıcıları Codex, Claude Code, Claude Desktop, Grok Build ve [istemci desteği sayfasındaki](https://easyproxy.me/tr/reference/client-support/) araçlarla kullanın.

## Hızlı başlangıç

### Kişisel kurulum (CLI)

```bash
npm install -g --allow-scripts=bun easyproxy   # Node 18+; Bun çalışma zamanı otomatik olarak paketlenir
epx start                         # proxy + kontrol paneli, localhost:10100
```

Arka planda çalıştırmak için `epx service` kullanın.

**http://localhost:10100** adresini açın ve her şeyi web kontrol panelinden yapılandırın: sağlayıcı
ekleyin (40'tan fazla hazır sağlayıcı ya da herhangi bir OpenAI uyumlu uç nokta), model seçin, hesap
yönetin. `epx gui` paneli istediğiniz zaman yeniden açar.

### Aracınızı bağlayın

Zaten kullandığınız aracı bağlayın:

| Araç | Bağlantı yöntemi |
|---|---|
| Codex | Panelin **Route** sayfasındaki Codex anahtarını açın, ardından `codex` komutunu her zamanki gibi çalıştırın. Yerel dinleyicide bu, Codex’in yerleşik sağlayıcısını proxy’ye yönlendirir. Terminalden, panelde sağlayıcı eklemeden önce `epx init` çalıştırın ve Codex istemini kabul edin. |
| Claude Code | `claude` CLI kuruluysa `epx claude` çalıştırın. Gerekirse proxy’yi başlatır ve Claude Code’u onun üzerinden açar. |
| Claude Desktop | `epx claude desktop` çalıştırın. Yeni kurulumda tüm uygulama için ağ geçidi profilini ayarlar; mevcut first-party yapılandırması korunur ve `epx claude desktop apply --gateway` açıkça geçiş yapar. [Claude Code kılavuzuna](https://easyproxy.me/tr/guides/claude-code/) bakın. Geçişten sonra Claude Desktop’tan tamamen çıkıp yeniden açın. |
| Grok Build | Yerel bir dinleyicide Grok entegrasyonu etkinse ve `~/.grok` mevcutsa, `epx start` modelleri kaydeder; Grok Build içinde bir `epx-*` modeli seçin. Uzak kurulumlar için [Grok Build kılavuzuna](https://easyproxy.me/tr/guides/grok-build/) bakın. Sağlayıcı ekledikten sonra listeyi yenilemek için proxy’yi yeniden başlatın (veya Codex otomatik başlatma etkinse `epx ensure` çalıştırın). |
| Yönetilen entegrasyonu olan araçlar | Panelin **Route** sayfasını veya `epx integration client enable --client <id>` komutunu kullanın. |
| Diğer tüm araçlar | Özel OpenAI uyumlu temel URL’yi `http://localhost:10100/v1` veya Anthropic temel URL’sini `http://localhost:10100` olarak ayarlayın. |

[İstemci desteği sayfası](https://easyproxy.me/tr/reference/client-support/), her aracın bağlantı yolunu ve kullandığı protokolü listeler.

<details>
<summary><b>Masaüstü uygulaması (beta)</b></summary>

Masaüstü uygulaması; aynı proxy ve kontrol panelini yerel bir pencerede, menü çubuğu simgesi ve
paketlenmiş `epx` ile sunar. Zaten çalışan bir proxy'ye bağlanır ya da kendi paketlenmiş proxy'sini
başlatır; kontrol paneli proxy bağlantı noktasında kalır (başka bir tane yapılandırmadıysanız
**http://localhost:10100**). Platformunuza uygun dosyayı
[en güncel sürümden](https://github.com/AquilaXk/easyproxy/releases/latest) seçin:

| Platform | Dosya | Notlar |
|---|---|---|
| macOS 14+ (Apple Silicon ve Intel) | `EasyProxy-<version>-macos.dmg` | Evrensel derleme; Apple Developer ID imzalama ve noter onayı yapılandırılana kadar imzasız (macOS Gatekeeper için **Sağ tık → Aç** gerekebilir) |
| Windows (x64) | `EasyProxy-<version>-windows-x64.msi` | SignPath Foundation ile kod imzalama kullanıma alınıyor ([kod imzalama politikası](https://easyproxy.me/tr/reference/code-signing/)); bir sürüm imzalanana kadar SmartScreen bir kez sorar, **Diğer bilgiler → Yine de çalıştır** seçin |
| Linux (x86_64) | `EasyProxy-<version>-linux-x86_64.AppImage` veya `-linux-amd64.deb` | Menü çubuğu simgesi AppIndicator destekli bir masaüstü gerektirir |

Her dosyanın yanında sürüm sayfasında bir `.sha256` bulunur. macOS 14 ve üzerinde uygulama ayrıca
proxy durumunu, bugünkü kullanımı ve sağlayıcı kotalarını gösteren bir WidgetKit uzantısıyla gelir;
görüntülediği anlık görüntü modeli [`app/`](../app) dizinindedir (`MenuBarCore`). Uygulamayı kendiniz
derlemek için depo kökünde `bun install && bun run build:gui`, ardından `desktop/` içinde macOS'ta
`bun install && bun run prepare-sidecar && bun run prepare-widget && bun run build:local`,
Windows ve Linux'ta ise `bun install && bun run prepare-sidecar && bun run build:local` çalıştırın (widget adımı yalnızca macOS'ta çalışır).
[Masaüstü uygulaması kılavuzu](https://easyproxy.me/tr/guides/desktop-app/) ve
[macOS menü çubuğu uygulaması kılavuzu](https://easyproxy.me/tr/guides/macos-menu-bar/) ilk açılışı
anlatır; [`CLI_CONSENT.md`](../CLI_CONSENT.md#where-things-are-installed) diske yazılan her
şeyi listeler.

</details>

<details>
<summary>Docker Compose</summary>

Depo, digest ile sabitlenmiş, root olmayan bir Compose derlemesi içerir. Derleme, seçilen Git anlık
görüntüsünden standart uyumluluk manifestosunu üretip doğrular. Yerel klon için Git ve Docker Compose,
uzak Git bağlamı için Docker Compose gerekir. İki yöntemde de ana makinede Bun veya bir hazırlık adımı
gerekmez. Veri düzlemi belirtecini stdin üzerinden bir kez ilklendirip hub'ı başlatın:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

Varsayılan ana makine bağlaması `127.0.0.1:10100`. Uzaktan erişime açmak için
`EASYPROXY_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d` gerekir; `0.0.0.0` tüm ana
makine arayüzlerini açar. Erişimi bir güvenlik duvarı ve kimlik doğrulamalı bir TLS/tailnet ön yüzüyle
kısıtlayın. Üretilen JSON izlenmez. Derleme bağlamına yalnızca `git ls-files` envanterinin okuduğu
`.git/index` ve `.git/HEAD` alınır; tam nesne deposu yerine yaklaşık 1 MB tutar. Bunlar salt okunur bir
bağlama üzerinden yalnızca derlemeye özel manifesto aşamasında görünür, dolayısıyla hiçbir `COPY` `.git`
içermez. Ana makinede önceden üretilmiş bir manifesto yalnızca doğrulandıktan sonra kabul edilir; aksi
halde derleme manifestoyu kendisi üretir. Derleme; eski manifestoları, eksik ya da uyuşmayan
dosyaları, fazladan kaynak dosyalarını ve sembolik bağlantıları reddeder. Kayıtlı her SHA-256 değerini
derleme bağlamıyla ve kopyalanan çalışma zamanı dosyalarıyla karşılaştırır: `package.json`,
`bun.lock` ve özellikle dahil edilen `scripts/model-metadata.source.json`.

Uzak Git bağlamında BuildKit'in Git meta verilerini koruması gerekir. Bu Compose derleme parçası uzak
anlık görüntüyü seçer ve gereken yerleşik argümanı iletir:

```yaml
services:
  hub:
    pull_policy: build
    build:
      context: https://github.com/AquilaXk/easyproxy.git#main
      dockerfile: Dockerfile
      target: runtime
      args:
        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
```

Belirteç ve değişken durum `epx-state` adlı volume içinde kalır; imaja, Compose dosyasına, ortama ya da
kabuk argümanlarına hiçbir kimlik bilgisi konmaz. Sağlayıcı kurulumu, kimlik doğrulamalı kabul kontrolleri,
uzaktan yönetim ve geri alma için
[Remote Hub dağıtım kılavuzuna](https://easyproxy.me/tr/guides/remote-hub/) bakın.

</details>

<details>
<summary>Kaynaktan kurulum (en güncel main)</summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy && ~/.bun/bin/bun install
~/.bun/bin/bun run build:gui
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy; bun install
bun run build:gui
bun run src/cli/index.ts start
```

Kaynaktan kurulum en güncel `main` dalını çalıştırır. Bellek sahipliği yamaları, çalışma zamanı GC
iyileştirmeleri ve henüz yayımlanmamış düzeltmeler npm paketine ulaşmadan önce burada bulunur.

</details>

<details>
<summary>Ajanlar için</summary>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start     # ya da `epx service`
epx init      # etkileşimli kurulum: ~/.easyproxy/config.json yazar ve Codex'i bağlar
```

`epx init` proxy'yi hiçbir zaman başlatmaz; önce onu başlatın (ya da sonra — sıra fark etmez, ancak
`epx provider add` ve `epx combo set` gibi başsız komutlar **çalışan** proxy ile konuşur ve ona
ulaşamadıklarında sıfırdan farklı bir kodla çıkar). `epx status` / `epx doctor` / `epx health`
çalışma durumunu bildirir.

> **easyproxy'i kuran ya da çalıştıran ajanlar:**
> [`CLI_CONSENT.md`](../CLI_CONSENT.md) dosyasını okuyun. Etkileşimli bir `epx start` bu depoya
> yıldız verip vermeyeceğinizi bir kez sorabilir — bu kullanıcının kararıdır, hiçbir zaman bir ajanın
> değil. CLI, ajan tarafından yürütülen çalışmalarda bu soruyu bastırır ve API bunları
> `403 agent_consent_required` ile reddeder.

</details>

## Desteklenen platformlar

| İşletim sistemi | Durum | Servis yöneticisi | Masaüstü uygulaması (beta) |
|---|---|---|---|
| macOS (arm64 / x64) | Tam destekleniyor | launchd | Evrensel `.dmg` |
| Linux (x64 / arm64) | Tam destekleniyor | systemd (kullanıcı birimi) | x86_64 `.AppImage` / `.deb` |
| Windows (x64) | Tam destekleniyor | Görev Zamanlayıcı (gizli) / isteğe bağlı yerel servis (`--native`, WinSW) | x64 `.msi` |

CLI kurulumu [Node](https://nodejs.org) 18 veya üzerini gerektirir; masaüstü uygulamasının ne Node'a ne de Bun'a ihtiyacı vardır. Bun çalışma zamanı `npm install` sırasında paketlenir —
ayrıca Bun kurmanıza gerek yok, Windows'ta WSL de gerekmez. npm, paketlenmiş çalışma zamanının kurulum
betiklerini engellediyse [kurulum belgelerine](https://easyproxy.me/tr/getting-started/installation/) bakın.

## Öne çıkanlar

- **Codex, Claude Code, Claude Desktop ve Grok Build ile istediğiniz LLM** — kutudan çıktığı gibi 40'tan
  fazla sağlayıcı, her biri kendi yerel arayüzünü korur.
- **Kombolar** — sağlayıcılar arasında failover ya da ağırlıklı round-robin yapan tek bir sanal model
  kimliği. [Kombo rehberine](https://easyproxy.me/tr/guides/combos/) bakın.
- **Her modelde alt ajanlar** — yönlendirilmiş modelleri Codex'in alt ajan seçicisinde gösterin, v1/v2
  yüzey denetimi ve yedek zincirleriyle birlikte.
  [Alt ajan rehberine](https://easyproxy.me/tr/guides/sub-agent-surface/) bakın.
- **Bir kez giriş yapın, API anahtarını atlayın** — xAI, Anthropic ve Kimi için OAuth; ya da
  `codex login` oturumunu iletin, bir anahtar yapıştırın veya `${ENV_VAR}` referansları kullanın.
- **Web araması ve görü yardımcıları** — OpenAI dışı modeller, ChatGPT girişiniz üzerinden çalışan bir
  yardımcı süreç sayesinde gerçek web araması ve görsel anlama kazanır.
- **Ne olup bittiğini görün** — kontrol paneli sağlayıcıları, OAuth durumunu, model seçimini ve önbellek
  belirteç sayılarını içeren canlı bir istek günlüğünü gösterir.
- **Temiz çıkış, sıfır artık** — `epx stop` Codex'i özgün yapılandırmasına geri döndürür.
- **Sınırlı bellek sahipliği** — uzun ömürlü her önbelleğin, halka arabelleğinin ve protokol çevirisi
  deposunun sonlu bir üst sınırı, bayt bütçesi ya da etkin bir uzlaştırması vardır. Yapılandırma yeniden
  yüklendiğinde sınırsız hiçbir `Map` ya da `Set` hayatta kalmaz.

<details>
<summary>Bellek sahipliği ayrıntıları</summary>

EasyProxy, süreçte tutulan durumu aşağıdaki kategorilerde izler. Her birinin belgelenmiş bir sınırı vardır:

- **15 tutulan depo** (istek günlüğü, hata ayıklama halkaları, görsel önbelleği, model önbelleği, görü
  açıklamaları, imleç blob'ları, responses devamlılığı vb.) bayt olarak hesaplanır ve uygulamanın sahip
  olduğu bellek bütçesiyle (varsayılan 256 MiB) tahliye edilir; yalnızca native control replay deposu
  sabitlenmiştir ve hiç tahliye edilmez.
- **4 gözlenen arabellek** (çevirici biriktiricileri, görsel/OAuth/Grok kuyrukları) tahliye edilmeden,
  yalnızca uçuştaki bayt baskısı için izlenir.
- **32 state-store kaydı**, süre dolumu taramalarını (60 sn aralık) ve yapılandırma kuşağı uzlaştırmasını
  yürüterek eski sağlayıcı/hesap anahtarlarını kaldırır.
- **Yol ve parmak izi notları** (çalışma alanı meta verileri, sağlamlaştırılmış kimlikler, kurulum
  tuzları, mod ipucu yetenekleri) ekleme sıralı LRU sınırları kullanır (8–128 girdi).
- **Model önbelleği kuşak mezar taşları** uzlaştırmadan sonra silinir; genel bir kuşak artışı, uçuştaki
  eski keşiflerin kaldırılmış sağlayıcıları yeniden doldurmasını engeller.
- **Lab olay kimliği yinelenme ayıklaması** diskten alınan bir defter kilidi altında çalışır; süreç
  düzeyinde RAM dizini yoktur.

Canlı tutulan baytları, tahliye sayaçlarını ve gözcü örneklerini incelemek için yönetici belirteciyle
`GET /api/system/memory` çağrısını yapın.

</details>

## Model yönlendirme

`provider/model` söz dizimiyle yapılandırılmış herhangi bir sağlayıcıyı ve modeli hedefleyin:

```bash
codex -m "anthropic/claude-opus-5" "Bu yığın izini açıkla"
codex -m "google/gemini-3-pro" "auth.ts için birim testleri yaz"
codex -m "ollama/llama3" "Bu fonksiyonu yeniden düzenle"
```

Varsayılan sağlayıcıyı kullanmak ya da model adı desenine göre otomatik eşleştirmek için `provider/`
önekini atlayın. İçinde `/` bulunan sağlayıcı model kimlikleri, iç eğik çizgileri `-` ile
değiştirilmiş biçimde sunulur; eğik çizgili tam biçim de çalışmaya devam eder. Ayrıntılar:
[model yönlendirme belgeleri](https://easyproxy.me/tr/guides/model-routing/).

### JEV Auto yönlendirme (isteğe bağlı)

TypeSafe JEV, açıkça etkinleştirilen bir Combo için ilk modeli ve akıl yürütme düzeyini seçebilir;
normal model seçici ve tüm doğrudan rotalar değişmez. Kimlik bilgisini `epx login jev` ile,
**Providers → TypeSafe JEV → Add API key** üzerinden veya `TYPESAFE_API_KEY`/`JEV_API_KEY` ile ekleyin.
Ardından **Models → Combos → Create JEV Auto** bölümünü açın, izin verilen hedef modelleri seçin ve
JEV'in her hedef için seçebileceği düzeyleri işaretleyin. Düzey ayarına dokunulmayan bir hedef, modelin
şu anda duyurduğu tüm düzeylere izin verir.

JEV yalnızca `jev-auto` için ve mantıksal model çağrısı başına yalnızca bir kez kullanılır. Eksik kimlik
bilgisi, ağ hatası veya geçersiz karar durumunda şu anda uygun olan ilk hedefe fail-open yapılır;
çağıranın iptali isteği yine iptal eder. Otomatik testler sahte bir TypeSafe uç noktası kullanır ve
gerçek bir JEV hesabını doğrulamaz.

Bir JEV Combo bunun yerine Ollama'nın anahtarsız `tev1` modeli gibi kendi barındırdığınız bir karar
modeline de sorabilir: `baseUrl` değeri tam `/v1/systemone` uç noktası olan bir `jev-decision`
sağlayıcısı ekleyin ve Combo'nun `decisionProvider` alanına yazın. TypeSafe kimlik bilgileri oraya asla
gönderilmez. Ayrıntılar: [kendi barındırılan karar modeli](https://easyproxy.me/tr/guides/combos/).

## Sağlayıcılar ve adaptörler

OpenAI (ChatGPT girişi ya da API anahtarı), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(yerel + Cloud), Cursor (deneysel) ve her OpenAI uyumlu uç nokta — ayrıca DeepSeek, Groq, OpenRouter, OpenGateway,
Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax, Qwen Cloud, Qoder Global ve CN
(resmî PAT + CLI), SiliconFlow ve daha fazlası. Tam liste: `epx init` ya da
[sağlayıcı belgeleri](https://easyproxy.me/tr/guides/providers/).

## CLI

```bash
epx init                       # etkileşimli kurulum (config yazar, Codex'i bağlar, shim önerir)
epx start [--port 10100] [--socks5 [host:port] | --socks5-off]  # SOCKS5 varsayılanı socks5://127.0.0.1:10808
epx stop                       # durdur + yerel Codex'i geri yükle
epx service [install|repair|restart|start|stop|status|uninstall|remove]  # arka plan servisi
epx codex-shim install         # `codex` her başladığında proxy'yi isteğe bağlı başlat
epx health [--json]            # proxy'nin şu an ayakta olup olmadığını kontrol et
epx ready [--json] [--wait [--timeout <seconds>]]  # eşitleme sonrası hazırlığı kontrol et
epx status                     # proxy çalışıyor mu?
epx gui                        # web kontrol panelini aç
epx provider <...>             # sağlayıcıları yönet (list/add/edit/test/remove)
epx account <...>              # ChatGPT hesaplarını ve API anahtarı havuzlarını yönet
epx combo <...>                # failover / round-robin kombolarını yönet
epx v2 <...>                   # çoklu ajan v1/v2 yüzey denetimleri
epx update [--tag preview]     # easyproxy'i güncelle
```

Tercih edilen bağlantı noktası meşgulse başlatma başka bir bağlantı noktasına geçmek yerine durur ve bağlantı
noktasını hangi işlemin tuttuğunu bildirir; böylece ilkinin yanında ikinci bir proxy çalışır durumda kalamaz.
Bağlantı noktasını boşaltın veya `--port` ile farklı bir tane belirtin. Tam başvuru:
[CLI belgeleri](https://easyproxy.me/tr/reference/cli/).

### Sağlık ve hazırlık

`GET /healthz` proxy'nin o anki canlılığını bildirir. Kimlik doğrulaması gerektirmeyen `GET /readyz`
uç noktası, eşitleme sonrası hazırlığı arındırılmış `{service, version, uptime, pid, port, status}` JSON
kimliğiyle bildirir. `status` değeri `ready` olduğunda `200` döner; `pending` ve nihai
`failed` durumları `Retry-After: 1` ile `503` döner.

`epx ready [--json] [--wait [--timeout <seconds>]]` varsayılan olarak tek bir yoklama yapar. `--wait`
varsayılan olarak 45 saniyeye kadar yoklar, ancak nihai `failed` durumunu gördüğü anda çıkar;
`--timeout <seconds>` 1–300 saniyelik bir sınır koyar, `--wait` gerektirir ve yalnızca pozitif tam
sayı kabul eder. CLI `--json` çıktısı `{ready, status, pid, port}` biçimindedir; `status` değeri
`ready`, `pending`, `failed` ya da `unreachable` olur.

| Çıkış | Sonuç |
| --- | --- |
| `0` | Hazır |
| `1` | Hazır değil: pending, failed, zaman aşımı ya da ulaşılamıyor |
| `64` | Geçersiz argüman |

`/readyz` içermeyen eski bir proxy `unreachable` olarak fail-closed davranır ve 1 koduyla çıkar;
`epx health` ise uyumlu kalır.

### Otomatik başlatma: servis mi shim mi

Çökme sonrası yeniden başlayan, sürekli açık bir proxy için **servisi** (`epx service`) kullanın. Arka
plan artalan süreci olmadan hafif, isteğe bağlı başlatma için **shim**'i
(`epx codex-shim install`) kullanın. Kaldırmak için `epx service uninstall` /
`epx codex-shim uninstall`.

### Kaldırma

```bash
epx uninstall                  # durdur, servis/shim kaldır, yerel Codex'i geri yükle, durumu temizle
npm uninstall -g easyproxy
```

## Uzaktan erişim

easyproxy varsayılan olarak `127.0.0.1` adresine bağlanır ve ek bir kimlik doğrulaması gerektirmez.
Geri döngünün dışına bağlanmak (`"hostname": "0.0.0.0"`) bir bearer belirteci **gerektirir**: proxy
`EASYPROXY_API_AUTH_TOKEN` olmadan başlamayı reddeder ve her istemci isteği bu belirteci
`x-easyproxy-api-key` olarak taşımalıdır. Ayrıntılar:
[yapılandırma başvurusu](https://easyproxy.me/tr/reference/configuration/).

## Gelişmiş kullanım

İleri düzey kullanıcılar için kendi barındırdığınız seçenekler. Etkinleştirmeden önce her sağlayıcının koşullarını inceleyin.

### ChatGPT hesap havuzu

easyproxy, Codex kimlik doğrulaması için bir **ChatGPT hesap havuzu** da yönetebilir. Birden fazla
ChatGPT / Codex hesabı ekleyin, 5 saatlik / haftalık / 30 günlük kotalarını panelden tazeleyin. Kota
yönlendirmesinde yeni oturumlar en az kullanılan sağlıklı hesabı kullanabilir; round-robin ve
fill-first kendi politikalarını izler. Mevcut Codex dizileri normalde onları başlatan hesaba bağlı
kalır, böylece uzun SSH, tmux ya da mobil oturumlar konuşmanın ortasında hesap değiştirmez — ancak
kota yeniden değerlendirmesi, failover, hesabın devre dışı bırakılması, bağlılığın süresinin dolması
ya da 401/403 ve 429 toparlanması bu bağı yeniden kurabilir. Yalnızca diğerleri tükendiğinde
kullanılmasını istediğiniz bir hesap varsa — genellikle Codex Desktop girişiniz — hesaplara bir seçim
sırası verin.

- **ChatGPT hesaplarını havuzlayın** — dizi bağlılığı, kota farkındalıklı otomatik geçiş, bekleme süresi ve
  fail-closed kimlik doğrulama davranışı.

  > **Sağlayıcı politikası notu:** Hesap havuzu yalnızca yönlendirme ve işletimsel dayanıklılık içindir;
  > sağlayıcının hız sınırlarından, yaptırımlarından, askıya almalarından ya da diğer hesap işlemlerinden
  > korunmayı garanti etmez. EasyProxy, sağlayıcı sınırlarını aşmak için ek hesap kullanılmasını ya da hesap
  > kimlik bilgilerinin kişiler arasında paylaşılmasını onaylamaz. Her sağlayıcının güncel koşullarına
  > uymak sizin sorumluluğunuzdadır. Bkz.
  > [Codex Auth hesap havuzu rehberi](https://easyproxy.me/tr/guides/web-dashboard/)
  > ve [OpenAI'nin güncel Kullanım Koşulları](https://openai.com/policies/terms-of-use/).

## Belgeler

Herkese açık belgeler — kurulum, sağlayıcılar, yönlendirme, kombolar, alt ajanlar, yardımcı süreçler,
entegrasyonlar ve CLI/yapılandırma/yönetim API'si başvuruları — [`docs-site/`](../docs-site) içinden
derlenir ve **[easyproxy.me](https://easyproxy.me/tr/)** adresinde yayımlanır.

Bakımcılar için doğruluk kaynağı notları [`structure/`](../structure) altında, güvenlik bildirimi ise
[`SECURITY.md`](../SECURITY.md) içindedir. Açıklanmamış güvenlik açıklarını herkese açık bir issue
yerine [GitHub özel güvenlik açığı bildirimi](https://github.com/AquilaXk/easyproxy/security/advisories/new)
üzerinden gizlice bildirin.
Teknik kanal yalnızca bu formdur; ayrı bir güvenlik e-posta adresi yoktur. Sonraki yazışmalar özel
bildirimin içinde kalır; herkese açık bir issue yalnızca koordinasyon taşıyabilir, güvenlik açığının
ayrıntılarını asla. Bildirimin alındığını onaylamak onu incelemekle aynı şey değildir ve ilk yanıt
için bir süre taahhüt edilmez.

## Geliştirme

Kaynak geliştirmesi `PATH` üzerinde `bun` CLI gerektirir. Yayımlanmış npm paketi kurulu `epx` komutları
için kendi Bun çalışma zamanını içerir; paket betikleri de Bun'u bu paketlenmiş bağımlılıktan bulabilir.

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run typecheck
bun run test
```

## Kod imzalama politikası (Code signing policy)

Windows ikili dosyaları Authenticode imzalamaya geçiyor. Geçiş durumu, imzanın nasıl doğrulanacağı ve politikanın tamamı [Windows kod imzalama kılavuzunda](https://easyproxy.me/tr/reference/code-signing/) anlatılıyor.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [AquilaXk](https://github.com/AquilaXk)
- Approvers: [AquilaXk](https://github.com/AquilaXk)
- Privacy: easyproxy sends one anonymous daily usage summary (a per-day install hash that changes daily, version, release channel, platform, install channel, provider kind, coarse model family, active minutes and request, token and error counts; never prompts, model outputs, keys, accounts, hostnames or paths) to telemetry.easyproxy.me, and only after the person installing or operating it has seen the notice in the dashboard or an interactive CLI prompt and has not declined. It can be turned off in that notice, in the Windows installer ("Send anonymous usage statistics", checked by default), in Proxy details, or with epx telemetry disable, EPX_TELEMETRY=0 or DO_NOT_TRACK=1. Only project-wide aggregates of this anonymous data are public. A separate public leaderboard profile is off unless you connect one yourself (dashboard Home or epx telemetry profile connect); it shares only a chosen handle, display name and colour and your daily request, token and model-family totals, never your anonymous telemetry ID, and disconnecting deletes it. Everything else goes only to the providers and services you configure. See the [telemetry guide](https://easyproxy.me/tr/guides/telemetry/).

## Sorumluluk reddi

easyproxy bağımsız, toplulukça sürdürülen bir projedir ve **OpenAI, Anthropic ya da başka herhangi bir sağlayıcıyla bağlantılı değildir, onlar tarafından onaylanmamıştır**.

Bazı sağlayıcılar — özellikle Anthropic (Claude) — API trafiğini üçüncü taraf bir proxy üzerinden geçiren hesapları askıya alabilir ya da kısıtlayabilir. **Kullanım riski size aittir (UAYOR).** Bir sağlayıcıyı bağlamadan önce, proxy tabanlı erişime izin verildiğini doğrulamak için hizmet koşullarını inceleyin. easyproxy bakımcıları, yukarı akış sağlayıcılarının aldığı hesap kararlarından sorumlu değildir.

## Lisans

MIT
