---
title: opencode
description: opencode içerisinden yönlendirilen herhangi bir modeli kullanın — easyproxy bir çalışma zamanı sağlayıcı bloğu enjekte eder ve kendi opencode yapılandırmanıza dokunmaz.
---

opencode, sağlayıcılarını ortam değişkenleri yerine birleştirilmiş JSON
yapılandırma katmanlarından okur, bu nedenle enjekte edilecek
`ANTHROPIC_BASE_URL` tarzı bir yuva yoktur. `epx opencode` bu boşluğu doldurur:
proxy'nin çalıştığından emin olur, görünür katalogdan bir sağlayıcı bloğu
oluşturur ve bunu OpenCode'un satır içi çalışma zamanı katmanı
(`OPENCODE_CONFIG_CONTENT`) aracılığıyla enjekte eder.

## Hızlı Başlangıç

```bash
epx opencode
```

Bu, proxy'nin çalıştığından emin olur ve bu süreç için oluşturulan
`provider.easyproxy` ve `providers.easyproxy` blokları enjekte edilmiş olarak opencode'u başlatır. Fazladan
argümanlar doğrudan iletilir: `epx opencode run "hello"`.

Yönlendirilen modeller seçicide `easyproxy` sağlayıcısı altında görünür:

```text
easyproxy/kiro/glm-5
easyproxy/gpt-5.6-sol      # yerel slug'lar öneksiz kalır
```

## Kendi yapılandırmanız asla değiştirilmez

Başlatıcı `~/.config/opencode/opencode.json`, proje `opencode.json` /
`opencode.jsonc` veya diskteki başka bir yapılandırma katmanını kopyalamaz veya
yeniden yazmaz. Bir `provider.easyproxy` veya `providers.easyproxy` geçersiz kılmasını algılamak için genel
veya proje yapılandırmasını okuyabilir, mevcut sağlayıcılarınız, ajanlarınız,
tuş atamalarınız, MCP girdileriniz ve göreli `{file:…}` referanslarınız orijinal
dosyalarından çözümlenmeye devam eder.

Yalnızca bu başlatma için easyproxy, oluşturulan `provider.easyproxy` ve `providers.easyproxy` bloklarını
OpenCode'un satır içi çalışma zamanı katmanı aracılığıyla ekler. Bu katman,
genel/özel/proje yapılandırmasından sonra birleşir ve alt süreç için yalnızca
çakışan anahtarları geçersiz kılar.

| Katman | `epx opencode` ile Davranış |
| --- | --- |
| Genel / özel / proje yapılandırması | Tam olarak yazdığınız gibi diskte bırakılır |
| Satır içi çalışma zamanı (`OPENCODE_CONFIG_CONTENT`) | Oluşturulan `provider.easyproxy` ve `providers.easyproxy` bloklarını alır (devralınan satır içi yapılandırmayla birleştirilir) |
| Göreli `{file:…}` yolları | Yine de bunları ilk tanımlayan yapılandırma dosyasına göre çözümlenir |

Bir genel veya proje yapılandırması da `provider.easyproxy` veya `providers.easyproxy` tanımlıyorsa,
başlatıcı bilgilendirici bir not yazdırır: `epx opencode`'dan gelen çalışma
zamanı katmanı bu başlatma için onu geçersiz kılar.

## Bloğu kendi yapılandırmanıza yerleştirme

`epx opencode`, sağlayıcı bloğunu yalnızca bir başlatma için enjekte eder; bu da
düz `opencode`'un proxy hakkında hala hiçbir şey bilmediği anlamına gelir.
Yönlendirilen modellerin düz `opencode`'dan — veya başlatıcıdan asla geçmeyen
bir düzenleyici uzantısından — kullanılabilir olmasını istediğinizde, `epx
export` kendi yapılandırmanızla birleştirmeniz için aynı sağlayıcı bloğunu
yazdırır:

```bash
epx export --client opencode
```

Proxy çalışıyor olmalıdır. Komut yapılandırmayı, kurallı hedefi
(`~/.config/opencode/opencode.json` veya ayarlandığında `XDG_CONFIG_HOME`
altında), birleştirme uyarısını ve ortam dışa aktarma satırını yazdırır. Bu
dosyaya asla dokunmaz — yukarıdaki bölüm geçerliliğini korur ve bloğu
yapılandırmanıza taşımak sizin açık eyleminizdir.

:::caution[Birleştirin, asla üzerine yazmayın]
İki bloğu da — `provider.easyproxy` ve `providers.easyproxy` — mevcut yapılandırmanızla birleştirin. Tüm dosyanın
dışa aktarılanla değiştirilmesi diğer sağlayıcılarınızı, ajanlarınızı, tuş
atamalarınızı ve MCP girdilerinizi yok eder. `epx export --out` tam olarak bu
nedenle mevcut bir dosyanın üzerine yazmayı reddeder, bu nedenle `--out`'u
geçici bir yola yönlendirin ve blokları kopyalayın:

```bash
epx export --client opencode --out ~/easyproxy-opencode.json
```
:::

Başlatıcının çalışma zamanı bloğunun aksine, birleştirilmiş bir blok statik bir
anlık görüntüdür: kataloğunuzu takip etmez. Bir sağlayıcı ekledikten veya model
görünürlüğünü değiştirdikten sonra `epx export`'u yeniden çalıştırın.

Birleştirildikten sonra opencode'u başlatmadan önce kabul anahtarını dışa
aktarın — proxy'nin geri döngüde olduğu durumlar hariç (orada hiçbir anahtar
gerekmez):

```bash
export EASYPROXY_OPENCODE_API_KEY=<anahtarınız>
```

## Kabul anahtarı diske yazılmaz

Proxy bir API anahtarı gerektirdiğinde, satır içi çalışma zamanı yapılandırması
sır yerine opencode'un `{env:…}` referansını taşır. Geri döngü (loopback)
bağlantıları bu referansı `apiKey` olarak kullanır; geri döngü olmayan
bağlantılar, proxy kabulünün herhangi bir yukarı akış `Authorization`
başlığından ayrı kalması için bunu yalnızca `x-easyproxy-api-key` üzerinden
gönderir.

Geri döngü örneği:

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:EASYPROXY_OPENCODE_API_KEY}"
}
```

Geri döngü olmayan örnek:

Bu örnek uzak istemcide elle yapılandırılır. Önce bir TLS ön ucu yapılandırın ve HTTPS URL'sini kullanın; EasyProxy TLS sonlandırmaz ve `epx opencode` bu URL'yi otomatik bulmaz. LAN üzerinde düz HTTP, kimlik bilgisini aktarım sırasında açığa çıkarır. Alternatif olarak proxy'yi loopback üzerinde tutup yerel bir SSH tüneli kullanın. Bkz. [Veri dinleyicisi için TLS](/tr/guides/remote-hub/#giving-the-data-listener-tls).

```json
"options": {
  "baseURL": "https://proxy.example.com/v1",
  "headers": {
    "x-easyproxy-api-key": "{env:EASYPROXY_OPENCODE_API_KEY}"
  }
}
```

Gerçek değer yalnızca alt süreç ortamı üzerinden iletilir.
`EASYPROXY_API_AUTH_TOKEN` önceliklidir, ardından güçlendirilmiş servis
belirteci dosyası, ardından yapılandırılmış bir API anahtarı gelir — geri döngü
olmayan bir bağlantının gerektirdiği budur.

Bir geri döngü bağlantısı (`127.0.0.1`, varsayılan) hiçbir şeyi doğrulamaz, bu
nedenle `{env:…}` referansı etkisizdir ve değişkeni ayarlanmamış
bırakabilirsiniz. Yalnızca `hostname` geri döngünün ötesine ayarlandığında
önemlidir; bkz. [Uzaktan erişim](/tr/reference/configuration/server/#uzaktan-erişim). Bu
kabul anahtarı easyproxy'in kendisine aittir ve
[Sağlayıcılar](/tr/guides/providers/) altında yapılandırılan yukarı akış
sağlayıcı anahtarlarıyla ilgisizdir.

## Geri Alma (Reverting)

Geri alınacak bir şey yoktur — `~/.easyproxy` altında oluşturulmuş hiçbir
yapılandırma dosyası yazılmaz. Düz `opencode` çalıştırdığınızda kendi
yapılandırmanızı tam olarak eskisi gibi okur.

## Model sınırları

`limit.context` yalnızca katalog yetkili bir bağlam penceresi bildirdiğinde
yazılır; bildirmediğinde tüm `limit` bloğu atlanır ve opencode kendi
varsayılanlarını korur.

Çıktı sınırı, katalogdaki veya oluşturulan meta verilerdeki bilinen model sınırını kullanır. Yalnızca sınır bilinmiyorsa `32000` kullanılır. Çıktı sınırı her zaman bağlam penceresiyle sınırlanır; `32000` altındaki bilinen sınırlar da korunur.

`easyproxy` sağlayıcı bloğu her başlatmada yeniden oluşturulur, bu nedenle
içinde yapılan model başına ince ayarlar hayatta kalmaz. Bunun yerine özel
girdileri kendinize ait bir sağlayıcı anahtarı altında tutun.

## Gereksinimler

opencode kurulu olmalı ve `PATH` üzerinde bulunmalıdır:

```bash
npm install -g opencode-ai
```


