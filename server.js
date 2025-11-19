// server.js - Hem Local Test Hem Canlı Sunucu Uyumlu
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Fuse = require('fuse.js');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// TÜM SİTELERE İZİN VEREN AYAR (CORS)
app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Klasör Kontrolü
if (!fs.existsSync('conversation_logs')) fs.mkdirSync('conversation_logs');
if (!fs.existsSync('leads')) fs.mkdirSync('leads');

const userSessions = {};
let localProductList = [];

// Ürün Listesini Yükle
const productFilePath = path.join(__dirname, 'products.txt');
try {
    if (fs.existsSync(productFilePath)) {
        const data = fs.readFileSync(productFilePath, 'utf-8');
        // Tekrarlananları temizle
        const uniqueLines = new Set(data.split('\n').map(line => line.trim()).filter(line => line.length > 0));
        localProductList = Array.from(uniqueLines);
        console.log(`✅ Ürün listesi: ${localProductList.length} adet.`);
    } else {
        console.log("⚠️ products.txt bulunamadı.");
    }
} catch (err) { console.error("Dosya hatası:", err); }

const fuse = new Fuse(localProductList, { includeScore: true, threshold: 0.3 });

// --- EKSİK OLAN KISIM GERİ EKLENDİ (WIDGET) ---
app.get('/widget', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Hata: index.html dosyası bulunamadı! Lütfen dosyanın server.js ile aynı klasörde olduğundan emin olun.');
    }
});

// Sunucu kök dizini kontrolü
app.get('/', (req, res) => res.send('Nanokar Bot Sunucusu Aktif! /widget adresinden test edebilirsiniz.'));

// --- YARDIMCI FONKSİYONLAR ---
async function extractContactInfo(text) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Metinden İSİM ve TELEFON numarasını çıkar. JSON formatında döndür: { "name": "...", "phone": "..." }. Yoksa null döndür.' }, { role: 'user', content: text }],
            response_format: { type: "json_object" }
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (e) { return null; }
}

async function analyzeIntentAndProducts(userMessage) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Analiz et ve JSON döndür. 1. Ürün sorusu: { "intent": "SEARCH", "products": ["Ürün1"] }. 2. Sohbet: { "intent": "CHAT", "products": [] }.' },
                { role: 'user', content: userMessage }
            ],
            response_format: { type: "json_object" }
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (error) { return { intent: "CHAT", products: [] }; }
}

async function searchProducts(keywords) {
    let allFoundProducts = [];
    const addedProductNames = new Set();
    if (localProductList.length > 0 && keywords.length > 0) {
        for (const keyword of keywords) {
            const fuseResults = fuse.search(keyword);
            for (const result of fuseResults.slice(0, 3)) {
                if (!addedProductNames.has(result.item)) {
                    allFoundProducts.push({
                        name: result.item,
                        link: `https://www.nanokar.com.tr/kategori?ara=${encodeURIComponent(result.item)}`
                    });
                    addedProductNames.add(result.item);
                }
            }
        }
    }
    return allFoundProducts;
}

// --- CHAT API ---
app.post('/api/chat', async (req, res) => {
    const { messages, sessionId } = req.body;
    const currentSessionId = sessionId || 'genel_session';
    const lastUserMessage = messages[messages.length - 1].content;

    // 1. Telefon Bekleme Modu
    if (userSessions[currentSessionId] && userSessions[currentSessionId].status === 'waiting_for_contact') {
        const contactData = await extractContactInfo(lastUserMessage);
        if (contactData && contactData.name && contactData.phone) {
            const requestedProduct = userSessions[currentSessionId].productRequest;
            const leadContent = `Tarih: ${new Date().toLocaleString()}\nİsim: ${contactData.name}\nTel: ${contactData.phone}\nAradığı Ürün: ${requestedProduct}\nTam Mesaj: ${lastUserMessage}\n--------------------------\n`;
            
            fs.appendFileSync(`leads/Musteri_Talepleri.txt`, leadContent);
            delete userSessions[currentSessionId];
            
            res.json({ success: true, message: `Bilgilerinizi aldım ${contactData.name}. Danışmanlarımız size dönüş yapacaktır.` });
            return;
        }
    }

    // 2. Normal Akış
    const analysis = await analyzeIntentAndProducts(lastUserMessage);
    let botMessage = "";

    if (analysis.intent === "SEARCH" && analysis.products.length > 0) {
        const foundProducts = await searchProducts(analysis.products);
        if (foundProducts.length > 0) {
            botMessage = `Evet, stoklarımızda şunlar mevcut:<br><br>`;
            foundProducts.forEach(p => { botMessage += `✅ <a href="${p.link}" target="_blank" style="color:#0056b3;font-weight:bold;">${p.name}</a><br>`; });
            botMessage += `<br>Detaylar için linklere tıklayabilirsiniz.`;
        } else {
            const missingProducts = analysis.products.join(", ");
            botMessage = `Web sitemizde <b>"${missingProducts}"</b> görünmüyor ama temin edebiliriz.<br>Size ulaşabilmemiz için lütfen <b>İsim, Soyisim ve Telefon</b> numaranızı yazar mısınız?`;
            userSessions[currentSessionId] = { status: 'waiting_for_contact', productRequest: missingProducts };
        }
    } else {
        const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Sen Nanokar AI asistanısın. Nazik ve satıcı odaklı ol.' }, ...messages]
        });
        botMessage = gpt.choices[0].message.content;
    }

    // Loglama (Hata önleyici try-catch ile)
    const logFile = path.join('conversation_logs', `${currentSessionId}.json`);
    try {
        let existingLogs = { messages: [] };
        if (fs.existsSync(logFile)) {
            existingLogs = JSON.parse(fs.readFileSync(logFile));
        }
        existingLogs.messages.push({ role: 'user', content: lastUserMessage });
        existingLogs.messages.push({ role: 'assistant', content: botMessage });
        fs.writeFileSync(logFile, JSON.stringify(existingLogs, null, 2));
    } catch(e) { console.log("Loglama hatası (önemsiz):", e.message); }

    res.json({ success: true, message: botMessage });
});

app.post('/api/voice-chat', upload.single('audio'), (req, res) => {
    res.json({ success: true, message: "Sesli özellik bakımda." });
});

app.listen(port, () => {
    console.log(`🚀 Sunucu Başlatıldı: http://localhost:${port}`);
    console.log(`🌐 Test için: http://localhost:${port}/widget`);
});