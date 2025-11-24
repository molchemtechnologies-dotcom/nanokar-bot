// server.js - FİNAL SÜRÜM (TypeError Önleyici ve Scraping Fix)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs').promises; 
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios'); 
const cheerio = require('cheerio'); // Scraping için kütüphane
const { SpeechClient } = require('...speech'); // Kısaltıldı
const { TextToSpeechClient } = require('...text-to-speech'); // Kısaltıldı
const nodemailer = require('nodemailer');

// Google Sheets Kütüphaneleri
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// ... (Geri kalan ayarlar aynı)

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- AYARLAR ---
const SPREADSHEET_ID = "1M44lWMSXavUcIacCSfNb-o55aWmaayx5BpLXuiyBEKs";
const PRODUCT_LIST_URL = "https://www.nanokar.com.tr/kategori"; // CANLI ÜRÜN LİSTESİ HEDEFİ

// ... (Google Auth ve Diğer Fonksiyonlar aynı)

// --- ÜRÜN ÇEKME FONKSİYONLARI (SCRAPING FIX) ---
let globalProducts = [];

async function fetchProducts() {
    console.log(`🌐 Ürünler canlı adresten çekiliyor: ${PRODUCT_LIST_URL}`);
    try {
        const { data } = await axios.get(PRODUCT_LIST_URL, { timeout: 20000 });
        const $ = cheerio.load(data);
        const scrapedProducts = [];

        // 🚨 YENİ SCRAPING SEÇİCİSİ (Sitenin mevcut yapısına uyarlanmıştır)
        $('div.product-item').each((index, element) => { 
            const nameElement = $(element).find('a.product-item-title'); // Ürün adı ve linki
            const link = nameElement.attr('href');
            const name = nameElement.text().trim();
            const price = $(element).find('.product-item-price').text().trim(); // Fiyat etiketi tahmini

            if (name && link) { // Sadece adı ve linki olanları al
                const fullUrl = link.startsWith('http') ? link : `https://www.nanokar.com.tr${link}`;
                scrapedProducts.push({
                    id: 'NK-' + index,
                    name: name,
                    price: price.replace(/[^\d,.]/g, ''),
                    url: fullUrl, 
                    description: name + ' ürünüdür.',
                    keywords: name.toLowerCase().split(/\s+/),
                    stock_status: 'Mevcut'
                });
            }
        });

        if (scrapedProducts.length > 0) {
            globalProducts = scrapedProducts;
            console.log(`✅ ${scrapedProducts.length} adet dinamik ürün çekildi.`);
            return true;
        }

        throw new Error("Scraper ürün bulamadı (Sitenin HTML yapısı değişti).");

    } catch (error) {
        // Hata durumunda GitHub'daki yedek products.json'a dön
        console.error('❌ Scraping Hatası. Statik JSON yedeğine geçiliyor:', error.message);
        try {
            const staticData = await fs.readFile('./products.json', 'utf8');
            globalProducts = JSON.parse(staticData).products;
            console.log(`⚠️ Statik JSON yedeği yüklendi. ${globalProducts.length} ürün yüklendi.`);
        } catch (e) {
            console.error("KRİTİK: Statik yedek yüklenemedi!");
            globalProducts = [];
        }
        return false;
    }
}


// --- LİGHTNING FIX: checkAndSaveLead fonksiyonu (TypeError'ı önler) ---
async function checkAndSaveLead(text) {
    if (text.match(/(\+90|0)?\s*5\d{2}/)) {
        try {
            const response = await openai.chat.completions.create({
                // ... (OpenAI çağrısı aynı)
            });
            const res = JSON.parse(response.choices[0].message.content);
            await saveToGoogleSheets(res.name, res.phone, text);
            sendLeadEmail(res.name, res.phone, text);
            return { saved: true, name: res.name };
        } catch (e) { 
            // 🚨 ÖNEMLİ: Hata durumunda mutlaka object dönülmeli!
            console.error("Lead yakalama sırasında kritik hata:", e);
            return { saved: false, error: e.message }; 
        }
    }
    return { saved: false }; // Telefon numarası yoksa
}

// ... (Geri kalan tüm API Routelarının içeriği aynı)

app.post('/api/chat', async (req, res) => {
    try {
        // ... (Kod aynı)
        // Lütfen bu sefer TypeError almadığımızdan emin olalım!
        const lead = await checkAndSaveLead(msg); 
        // LİNE 157: Artık lead mutlaka bir obje döndürecek, crash önlendi.
        if (lead.saved) return res.json({ success: true, message: `Bilgilerinizi aldım ${lead.name}. Satış temsilcimiz en kısa sürede size dönüş yapacaktır.` });
        // ... (Kod aynı)
    } catch (error) {
        console.error("Chat Hatası:", error);
        res.status(500).json({ error: "Sunucu hatası" });
    }
});

// ... (Diğer Routelar ve app.listen)