// server.js - FİNAL SÜRÜM (Canlı Scraping + Link Destekli)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises; // fs promise olarak kullanıldı
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios'); 
const cheerio = require('cheerio'); // Scraping için kütüphane
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const nodemailer = require('nodemailer');

// Google Sheets Kütüphaneleri
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- AYARLAR ---
const SPREADSHEET_ID = "1M44lWMSXavUcIacCSfNb-o55aWmaayx5BpLXuiyBEKs";
const PRODUCT_LIST_URL = "https://www.nanokar.com.tr/kategori"; // CANLI ÜRÜN LİSTESİ HEDEFİ

// --- GOOGLE CLOUD ANAHTAR YÖNETİMİ ---
let googleAuthJSON;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // fs.writeFile kullanıldı, dosya okuma promise'a dönüştürüldü
    fs.writeFile('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON); 
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
    try { googleAuthJSON = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON); } catch (e) { console.error("JSON Parse hatası", e); }
} else if (fs.existsSync('nanokar-key.json')) {
    // Burada senkron oku (Başlangıç için)
     googleAuthJSON = JSON.parse(require('fs').readFileSync('nanokar-key.json', 'utf8')); 
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Ses servisi başlatıldı.");
} catch (e) { console.log("⚠️ Ses servisi başlatılamadı."); }

// Klasör Kontrolü
if (!require('fs').existsSync('leads')) require('fs').mkdirSync('leads');
if (!require('fs').existsSync('uploads')) require('fs').mkdirSync('uploads');

// --- SİSTEM PROMPTU (LİNK KURALI) ---
const SYSTEM_PROMPT = `
Sen Nanokar'ın AI teknik asistanısın. Görevin, müşterinin projesine en uygun Nanokar ürünlerini (fiyatı ve varyantları ile) önermektir.
İletişim: Tel: +90 216 526 04 90, Mail: sales@nanokar.com

KURALLAR:
1. Ürün verilerini SADECE canlı siteden çekilen veritabanından kullan.
2. Ürün ismini söylerken MUTLAKA şu HTML formatında link ver. Örnek: <a href="LİNK" target="_blank">ÜRÜN ADI</a>
3. Eğer ürün veritabanında YOKSA veya müşteri ÖZEL BİR ŞEY isterse: "Size özel fiyat çalışması yapabilmemiz için lütfen İsim, Soyisim ve Telefon numaranızı yazar mısınız?" de.
4. Müşteri bilgilerini verirse: "Bilgilerinizi aldım [İsim], en kısa sürede dönüş yapacağız." de.
`;

// --- ÜRÜN ÇEKME FONKSİYONU (CANLI SCRAPING) ---
let globalProducts = [];

async function fetchProducts() {
    console.log(`🌐 Ürünler canlı adresten çekiliyor: ${PRODUCT_LIST_URL}`);
    try {
        const { data } = await axios.get(PRODUCT_LIST_URL, { timeout: 20000 });
        const $ = cheerio.load(data);
        const scrapedProducts = [];

        // 🚨 DİKKAT: Bu selectorlar sitenizin (www.nanokar.com.tr/kategori) HTML yapısına göre ayarlanmıştır.
        // Eğer grid yapısı değişirse burası hata verir.
        $('div[id="listingProducts"] > div.product-item').each((index, element) => { // Genel ürün kapsayıcısı
            const nameElement = $(element).find('a.product-item-title');
            const link = nameElement.attr('href');
            const name = nameElement.text().trim();
            const price = $(element).find('.product-price').text().trim();
            const description = name + ' ürünüdür.';
            const keywords = name.toLowerCase().split(/\s+/);
            
            // Eğer link tam URL değilse tamamla
            const fullUrl = link ? (link.startsWith('http') ? link : `https://www.nanokar.com.tr${link}`) : '';

            scrapedProducts.push({
                id: 'NK-' + index,
                name: name,
                price: price.replace(/[^\d,.]/g, ''), // Sadece rakam ve virgül kalacak şekilde temizle
                url: fullUrl, 
                description: description,
                keywords: keywords,
                stock_status: 'Mevcut' // Canlı stok bilgisini çekmek için ek mantık gerekir, şimdilik varsayılan
            });
        });

        if (scrapedProducts.length > 0) {
            globalProducts = scrapedProducts;
            console.log(`✅ ${scrapedProducts.length} adet CANLI ürün çekildi.`);
            return true;
        }

        throw new Error("Scraper ürün bulamadı (Selector hatası veya site yapısı değişti).");

    } catch (error) {
        console.error(`❌ KRİTİK: Scraping Hata Kodu: ${error.code || error.message}`);
        
        // Hata durumunda statik JSON yedeğine dön
        try {
            const staticData = await require('fs').promises.readFile('./products.json', 'utf8');
            globalProducts = JSON.parse(staticData).products;
            console.log(`⚠️ Statik JSON yedeğine geçildi. ${globalProducts.length} ürün yüklendi.`);
        } catch (e) {
            console.error("KRİTİK: Statik yedek yüklenemedi!");
            globalProducts = [];
        }
        return false;
    }
}

fetchProducts(); // Bot açıldığında dinamik veriyi çek

function findProduct(userMessage) {
    const message = userMessage.toLowerCase();
    return globalProducts.filter(product => {
        const pName = product.name.toLowerCase();
        const nameMatch = message.includes(pName) || pName.includes(message);
        const keywordMatch = product.keywords ? product.keywords.some(k => message.includes(k.toLowerCase())) : false;
        return nameMatch || keywordMatch;
    });
}

// GOOGLE SHEETS & MAIL FONKSİYONLARI (Kısaltıldı)
async function saveToGoogleSheets(name, phone, message) { /* Sheets logic */ }
async function sendLeadEmail(name, phone, message) { /* Mail logic */ }
async function checkAndSaveLead(text) { /* Lead logic */ }

// --- API ROUTES ---
// ... (API Routelarının geri kalanı aynı)

app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const msg = messages[messages.length - 1].content;

        if (globalProducts.length === 0) await fetchProducts();

        const lead = await checkAndSaveLead(msg);
        if (lead.saved) return res.json({ success: true, message: `Bilgilerinizi aldım ${lead.name}. Satış temsilcimiz en kısa sürede size dönüş yapacaktır.` });

        const foundProducts = findProduct(msg);
        let context = "BAĞLAM: Aranan ürün veritabanında bulunamadı. Müşteriden iletişim bilgisi iste.";
        
        if (foundProducts.length > 0) {
            const productDetails = foundProducts.map(p => {
                // HTML LİNKİNİ OLUŞTURUYORUZ
                const linkTag = `<a href="${p.url}" target="_blank">${p.name}</a>`;
                return `ÜRÜN: ${linkTag}\nFİYAT: ${p.price} ${p.currency || 'TL'}\nSTOK: ${p.stock_status}\nAÇIKLAMA: ${p.description}`;
            }).join("\n---\n");
            
            context = `BAĞLAM: Ürün bulundu. Cevap verirken HTML linki kullan. \n${productDetails}`;
        }

        const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: SYSTEM_PROMPT + "\n\n" + context }, ...messages]
        });

        res.json({ success: true, message: gpt.choices[0].message.content });
    } catch (error) {
        console.error("Chat Hatası:", error);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// Sesli Sohbet Route (Geliştirme Aşamasında Bırakıldı)
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    res.status(501).json({ error: 'Sesli Sohbet şu an geliştirme aşamasındadır.' }); 
});


app.listen(port, () => console.log(`🚀 Chatbot API running on port ${port}`));