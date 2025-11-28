// enrich-products.js - Nanokar Ürün Zenginleştirme Script
// GitHub'daki products.json dosyasını okur ve zenginleştirir

const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
require('dotenv').config();

// OpenAI client
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY
});

// products.json'u yükle (GitHub'daki dosya adı)
const productsPath = path.join(__dirname, 'products.json');
const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));

console.log(`\n🚀 NANOKAR ÜRÜN ZENGİNLEŞTİRME BAŞLIYOR`);
console.log(`📦 Toplam ${products.length} ürün yüklendi\n`);
console.log(`⏱️  Tahmini süre: ${Math.ceil(products.length * 3 / 60)} dakika\n`);

// İlerleme dosyası
const progressPath = path.join(__dirname, 'enrichment_progress.json');

// Delay fonksiyonu
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// İlerlemeyi kaydet
function saveProgress(enrichedProducts, currentIndex) {
    const progress = {
        totalProducts: products.length,
        processedCount: currentIndex,
        lastUpdate: new Date().toISOString(),
        products: enrichedProducts
    };
    fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
}

// Önceki ilerlemeyi yükle
function loadProgress() {
    if (fs.existsSync(progressPath)) {
        console.log('📂 Önceki ilerleme bulundu, kaldığı yerden devam ediliyor...\n');
        return JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    }
    return null;
}

// Her ürün için AI'dan bilgi iste
async function enrichProduct(productName, index, total) {
    try {
        const prompt = `
Ürün: "${productName}"

Bu nanoteknoloji ürünü için aşağıdaki bilgileri TÜRKÇE olarak JSON formatında ver:

1. **Kategori**: Ana kategoriyi belirle
   - Metal Nanopartiküller (Gümüş, Altın, Bakır, vb.)
   - Metal Oksitler (TiO2, ZnO, Al2O3, vb.)
   - Karbon Malzemeler (CNT, Grafen, vb.)
   - Seramikler ve Alaşımlar
   - Kimyasallar ve Çözücüler
   - Ekipman ve Aksesuarlar

2. **Özellikler**: Ürün adından çıkarılabilen teknik özellikler
   - Partikül boyutu, Saflık, Yoğunluk, Konsantrasyon, Fiziksel form

3. **Kullanım Alanları**: En az 6-8 gerçekçi kullanım alanı

4. **Avantajlar**: Teknik ve pratik faydalar (4-6 madde)

5. **Proje Tipleri**: Spesifik proje örnekleri (5-7 örnek)
   - Örn: "İletken mürekkep üretimi", "Antibakteriyel tekstil kaplama"

6. **Teknik Notlar**: Önemli ek bilgiler

KURALLAR:
- Sadece GERÇEKÇİ ve bilimsel doğru bilgiler
- Ürün adındaki bilgileri kullan
- Tahminde bulunma
- Türkçe karakter kullan

JSON:
{
  "name": "${productName}",
  "category": "Kategori",
  "subcategory": "Alt kategori",
  "properties": {
    "particle_size": "Boyut",
    "purity": "Saflık",
    "form": "Form"
  },
  "applications": ["alan1", "alan2"],
  "benefits": ["avantaj1", "avantaj2"],
  "project_types": ["proje1", "proje2"],
  "technical_notes": "Notlar",
  "search_keywords": "kelimeler"
}
`;

        console.log(`🔄 [${index}/${total}] ${productName.substring(0, 60)}...`);

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { 
                    role: 'system', 
                    content: 'Sen uzman bir nanoteknoloji mühendisisin. Ürünler hakkında teknik, doğru bilgiler veriyorsun.' 
                },
                { role: 'user', content: prompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 1500
        });

        const enrichedData = JSON.parse(response.choices[0].message.content);
        
        console.log(`✅ [${index}/${total}] ${enrichedData.category} - ${enrichedData.applications?.length || 0} uygulama\n`);
        
        return enrichedData;

    } catch (error) {
        console.error(`❌ [${index}/${total}] HATA: ${error.message}\n`);
        
        return {
            name: productName,
            category: "Belirsiz",
            properties: {},
            applications: [],
            benefits: [],
            project_types: [],
            technical_notes: "Otomatik zenginleştirme başarısız",
            error: error.message
        };
    }
}

// Ana fonksiyon
async function enrichAllProducts() {
    const startTime = Date.now();
    let enrichedProducts = [];
    let startIndex = 0;

    // Önceki ilerlemeyi kontrol et
    const progress = loadProgress();
    if (progress && progress.products) {
        enrichedProducts = progress.products;
        startIndex = progress.processedCount;
        console.log(`✅ ${startIndex} ürün zaten işlenmiş\n`);
    }

    // Her ürünü işle
    for (let i = startIndex; i < products.length; i++) {
        const product = products[i];
        
        const enriched = await enrichProduct(product.name, i + 1, products.length);
        enrichedProducts.push(enriched);
        
        // Her 10 üründe bir kaydet
        if ((i + 1) % 10 === 0) {
            saveProgress(enrichedProducts, i + 1);
            console.log(`💾 İlerleme kaydedildi: ${i + 1}/${products.length}\n`);
        }
        
        // Rate limit (400ms delay)
        await delay(400);
    }

    // Kaydet
    const finalPath = path.join(__dirname, 'products_enriched.json');
    fs.writeFileSync(finalPath, JSON.stringify(enrichedProducts, null, 2), 'utf-8');
    
    // İstatistikler
    const endTime = Date.now();
    const duration = Math.ceil((endTime - startTime) / 1000 / 60);
    const categories = [...new Set(enrichedProducts.map(p => p.category))];
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎉 ZENGİNLEŞTİRME TAMAMLANDI!`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📊 Toplam: ${enrichedProducts.length} ürün`);
    console.log(`⏱️  Süre: ${duration} dakika`);
    console.log(`📁 Çıktı: products_enriched.json`);
    console.log(`\n📋 Kategoriler:`);
    categories.forEach(cat => {
        const count = enrichedProducts.filter(p => p.category === cat).length;
        console.log(`   ${cat}: ${count} ürün`);
    });
    console.log(`${'='.repeat(60)}\n`);
    
    // Progress temizle
    if (fs.existsSync(progressPath)) {
        fs.unlinkSync(progressPath);
    }
    
    console.log(`✅ products_enriched.json hazır!\n`);
}

// Hata yakalama
process.on('unhandledRejection', (error) => {
    console.error('\n❌ Hata:', error.message);
    console.log('İlerleme kaydedildi.\n');
    process.exit(1);
});

// Başlat
console.log(`⚡ 3 saniye içinde başlıyor...\n`);
setTimeout(() => {
    enrichAllProducts().catch(error => {
        console.error('❌ Fatal:', error);
        process.exit(1);
    });
}, 3000);
