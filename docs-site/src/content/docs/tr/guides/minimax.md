---
title: MiniMax istemcileri
description: MiniMax kimlik bilgilerini açığa çıkarmadan MiniMax Code ve MiniMax CLI metin komutlarını EasyProxy üzerinden yönlendirin.
---

MiniMax iki farklı komut satırı ürünü sunar. EasyProxy, her birini gerçekten sunduğu
protokol sınırında bütünleştirir:

- **MiniMax Code** (`mcode`), özel Anthropic Messages sağlayıcıları kullanan bir kodlama ajanıdır.
- **MiniMax CLI** (`mmx`), çok modlu bir platform CLI'ıdır. Yalnızca `text` kaynağı, EasyProxy'in yönlendirebildiği Anthropic uyumlu API'yi kullanır.

## MiniMax Code

Önce MiniMax'ın yönergelerini kullanarak MiniMax Code'u kurup oturum açın. Ardından
EasyProxy'i başlatıp geri alınabilir dosya bütünleştirmesini bağlayın:

```bash
epx start
```

Proxy bu terminalde çalışmaya devam etsin. İkinci bir terminalde entegrasyonu etkinleştirip MiniMax Code’u başlatın:

```bash
epx integration client enable --client mcode
epx mcode
```

![Yalıtılmış örnek verilerle gösterilen MiniMax Code bütünleştirmesi](/screenshots/minimax-code-integration.png)

Bütünleştirme, `~/.minimax/config.yaml` içine bir blok ekler:

```yaml
custom_provider:
  easyproxy:
    name: EasyProxy
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: easyproxy-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

Oluşturulan model listesi, bağlam pencereleri ve akıl yürütme çabası basamakları çalışan
EasyProxy kataloğundan gelir. Pencereler [özel sağlayıcı tahminlerini](/tr/reference/configuration/providers/#özel-sağlayıcılarda-bağlam-penceresi) içerebilir;
katalogda pencere veya çaba basamağı yoksa ilgili alan atlanır. MCode,
oturumda o anda seçili çabayı korur; bu nedenle EasyProxy, seçimi değiştirmeden
`effortOptions` değerini dışa aktarır. Blok gerçek bir anahtar yazmaz, `defaultModel`
değerini değiştirmez ve MiniMax girişinizi etkilemez. MCode içinde
`custom_provider:easyproxy/...` altından bir model seçin.

`epx mcode`, istemciyi başlatmadan önce sağlayıcının o anda çalışan proxy'ye işaret
ettiğini doğrular. Bir kez etkinleştirdikten sonra `epx sync`, port veya katalog
yetenekleri değiştiğinde sahiplenilmiş bloğu yeniler. Otomatik senkronizasyon
sahipsiz bir blok oluşturmaz, kaldırdığınız bloğu yeniden oluşturmaz ve EasyProxy
son yazdığından beri değişen dosyanın üzerine yazmaz; bilerek yeniden bağlanmak
için etkinleştirme komutunu kullanın. Aynı denetlenen bütünleştirme sistemiyle
devre dışı bırakın veya geri yükleyin:

```bash
epx integration client disable --client mcode
epx integration client history --client mcode
epx integration client restore --op <opId> [--confirm-drift]
```

`MINIMAX_DATA_DIR` ve eski `MAVIS_DATA_DIR` değerleri dikkate alınır. Göreli yol
geçersiz kılmaları reddedilir; EasyProxy ve MCode farklı çalışma dizinlerinde
başlayabilir.

## MiniMax CLI (`mmx`)

Resmî CLI'ı ayrıca kurun:

```bash
npm install -g mmx-cli
mmx --version
```

Bir metin komutunu sarmalayıcı ve bir EasyProxy model kimliğiyle yönlendirin:

```bash
epx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

epx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX, API temel URL'sinin altına `/anthropic/v1/messages` yolunu sabit kodlar.
Sarmalayıcı, alt sürecin ömrü boyunca geçici bir geri döngü köprüsü başlatır.
Köprü yalnızca bu Messages yoluna ve `/anthropic/v1/messages/count_tokens`
yoluna gelen POST isteklerini kabul eder; istek gövdeleri ile sorgu verilerini
koruyarak bunları EasyProxy'in mevcut `/v1/messages` ve
`/v1/messages/count_tokens` veri düzlemine eşler. Kanonik EasyProxy istek
çevirisi, kullanım muhasebesi ve yapılandırılmış aşağı akış sağlayıcı kimlik
doğrulaması geçerliliğini korur; sağlayıcılar yapılandırmalarına göre `x-api-key`
veya bearer aktarımı alır. Akış, Anthropic ileti ve içerik olaylarını korur.
Köprü iletmeden önce gelen kabul kimlik bilgisi başlıklarını kaldırır ve genel
`easyproxy-loopback` yer tutucusunu sabitler. Rastgele Anthropic kaynakları
proxy'lenmez ve köprü geri döngü dışına açılmaz.

Sarmalayıcı ayrıca yalnızca bu yer tutucuyu içeren geçici bir `MMX_CONFIG_DIR`
oluşturur ve `mmx` kapandıktan sonra siler. `~/.mmx/config.json` dosyanız,
OAuth belirteçleriniz ve MiniMax API anahtarınız hiçbir zaman yüklenmez veya
kopyalanmaz.

Aşağıdaki sınırlar bilinçli olarak uygulanır:

- EasyProxy üzerinden yalnızca `text chat` ve `text repl` yönlendirilir.
- Arayanın kimlik bilgileri veya hedef seçicileri yalıtılmış köprüyle çakışmasın diye sarmalayıcı `--api-key`, `--base-url` ve `--region` seçeneklerini reddeder.
- MMX, uzak bir bağ için EasyProxy'in özel `x-easyproxy-api-key` kabul başlığını gönderemediğinden sarmalayıcı yalnızca geri döngüde çalışır.
- `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`, `auth`, `config`, `file` ve `update` için düz `mmx` çalıştırın; bunlar EasyProxy'in taklit etmediği MiniMax API'lerini çağırır.

`mmx`, metin modeli olarak varsayılan `MiniMax-M3` kullanır. Belirli bir EasyProxy
rotası istiyorsanız `--model <provider/model>` iletin; aksi halde normal EasyProxy
model yönlendirme kuralları varsayılan kimliğin kullanılabilir olup olmadığını
belirler.
