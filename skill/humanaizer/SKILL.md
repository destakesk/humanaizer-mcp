---
name: humanaizer
description: Humanaizer (humanaizer.io) ile uçtan uca AI içerik üretimi — hesaba giriş, plan/kota kontrolü, autopilot pipeline ile içerik oluşturma, durum takibi ve bağlı CMS'e (WordPress/Ghost/Strapi/Webflow/Shopify/Wix) yayınlama. Kullanıcı "humanaizer", "içerik üret", "blog yazısı oluştur/yazdır", "SEO içeriği", "içeriği WordPress'e/siteme yayınla" dediğinde veya humanaizer MCP tool'ları gerektiğinde kullan.
---

# Humanaizer — Uçtan Uca İçerik Üretimi

Bu skill, `humanaizer-mcp` MCP server'ının tool'larıyla (tool adları `mcp__humanaizer__*`)
tam içerik üretim akışını yönetir. Tüm plan/kota kontrolleri sunucu tarafında uygulanır;
senin görevin akışı doğru sırayla yürütmek ve engelleri kullanıcıya net aktarmak.

## 0. Ön koşul — MCP bağlı mı?

`mcp__humanaizer__*` tool'ları görünmüyorsa kullanıcıya kurulumu öner:

```bash
claude mcp add humanaizer -- npx -y humanaizer-mcp
```

## 1. Oturum

- Önce `get_account` dene. "Oturum yok" hatası dönerse kullanıcıdan **e-posta + şifre**
  iste ve `login` çağır. Oturum diske kaydedilir ve otomatik yenilenir — her seferinde
  giriş isteme.
- Login başarısızsa hatayı aynen aktar (yanlış şifre / hesap yok). Şifreyi asla tekrarlama.

## 2. Plan kontrolü (üretime başlamadan ÖNCE)

`get_account` çıktısındaki `usage` / `limits` alanlarına bak:

- `articles_per_month` limiti dolmuşsa (`usage.articles_count >= limits.articles_per_month`)
  **içerik oluşturma** — kullanıcıya kalan hakkını söyle ve plan yükseltmeyi
  (humanaizer.io/fiyatlar) öner.
- `features` içinde `auto_pilot` yoksa autopilot başlamaz; `auto_publish` yoksa
  `publish_content` çalışmaz. Bunları akışa girmeden söyle.

## 3. Seçimler (katalog)

Sırayla topla; kullanıcı belirtmediyse SOR, varsayma:

1. `list_brand_kits` → marka (`is_default` olanı öner).
2. `list_content_types` → içerik tipi (blog yazısı, hizmet sayfası...).
3. `get_content_type_schema` → **zorunlu `field_values` alanları**. Eksik zorunlu alan
   autopilot preflight'ında patlar; hepsini kullanıcıdan al veya konudan türet.
4. `list_prompt_templates` → şablon. Vermezsen içerik tipinin varsayılanı kullanılır;
   varsayılan yoksa preflight `no_prompt_template` ile durur.

## 4. İçerik oluşturma

`create_content` çağır:

- `slug`: başlıktan kebab-case üret (küçük harf, tire; Türkçe karakterleri sadeleştir).
- `target_country` (örn. "TR") + `target_language` (örn. "tr") **zorunlu** — marka kitinden
  veya kullanıcıdan al.
- `autopilot: true` (varsayılan) → tam pipeline: outline → bölümler → humanize →
  originalize → kalite kapıları → `ready_to_publish`.
- Dönen `autopilot_error` / `preflight_failures` varsa maddeleri kullanıcıya çevir:
  `no_prompt_template` → şablon seç; `missing_required_fields` → alanları doldur;
  `cost_quota_exhausted` → günlük AI bütçesi doldu; `no_brand_kit` → marka kiti seç.
- **Aynı içerik için ikinci kez `create_content` ÇAĞIRMA** (kota yakar). Takılan taslak
  için `retry_outline` kullan.

## 5. Durum takibi

Pipeline dakikalar sürer (tipik 5–15 dk). `get_content_status` ile izle:

- Makul aralıkla sorgula (30–60 sn); art arda hızlı poll yapma.
- Durumlar: `ready_to_publish` = tamamlandı · `generating/pre_humanizing/originalizing/
  *_quality_checking` = çalışıyor, bekle · `early/final_quality_failed` = kalite kapısı
  bloke etti (kullanıcı panelden override/retry edebilir) · `cost_paused` = AI bütçesi
  doldu, yenilenince devam eder · `failed` = kalıcı hata, sebebi aktar.
- `autopilot.blocking_reason` doluysa nedeni açıkla.

## 6. Sonuç ve yayın

1. `ready_to_publish` olunca `get_content` ile nihai HTML'i al; istenirse
   `get_quality_score` ile skoru göster.
2. Yayın istenirse `list_integrations` → yalnız `status: "active"` hedefler kullanılabilir.
   `needs_revalidation` görürsen: kullanıcı humanaizer.io → Entegrasyonlar'dan bağlantıyı
   yenilemeli.
3. `publish_content`:
   - `post_status: "draft"` güvenli varsayılandır (hedefte taslak oluşturur).
   - `post_status: "publish"` **siteyi anında değiştirir** — mutlaka kullanıcıdan açık
     onay al.
4. `list_publish_jobs` ile sonucu izle: `succeeded` → `remote_permalink`'i paylaş;
   `failed` → `last_error`'ı aktar (auth hatasıysa entegrasyon yenilenmeli).

## Hata sözlüğü

| Belirti | Anlamı / aksiyon |
| --- | --- |
| 402 / 403 + plan mesajı | Plan/kota engeli → `get_account` ile limitleri göster, yükseltme öner |
| `duplicate_job` (409) | Aynı içerik zaten yayın kuyruğunda → `list_publish_jobs` ile mevcut job'u izle |
| `not_ready` | İçerik `ready_to_publish` değil → önce pipeline'ı bitir |
| `integration_inactive` | Entegrasyon pasif/yenileme bekliyor → panelden yenile |
| "Oturum yok" | `login` gerekli |

## İlkeler

- Kota yakan işlemler (`create_content`, autopilot) öncesi kullanıcı niyetini netleştir;
  toplu üretim isteklerinde adet × kalan kota hesabını göster ve onay al.
- Canlıya yayın (`post_status: "publish"`) ve birden çok içerik üretimi için her zaman
  açık onay iste.
- Hata mesajlarını teknik jargonsuz, aksiyon önerisiyle birlikte aktar.
