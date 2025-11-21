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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('conversation_logs')) fs.mkdirSync('conversation_logs');

const userSessions = {};
let localProductList = [];

// Ürün Listesi
const productFilePath = path.join(__dirname, 'products.txt');
try {
    if (fs.existsSync(productFilePath)) {
        const data = fs.readFileSync(productFilePath, 'utf-8');
        const uniqueLines = new Set(data.split('\n').map(line => line.trim()).filter(line => line.length > 0));
        localProductList = Array.from(uniqueLines);
        console.log(`✅ Ürün listesi: ${localProductList.length} adet.`);
    }
} catch (err) { console.error("Dosya hatası:", err); }

const fuse = new Fuse(localProductList, { includeScore: true, threshold: 0.3 });

// --- 🔥 YENİ: MÜŞTERİ PANELİ (Buradan Göreceksin) ---
app.get('/admin-leads', (req, res) => {
    const filePath = path.join(__dirname, 'leads', 'Musteri_Talepleri.txt');
    if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Basit bir HTML ile gösterelim
        res.send(`
            <html>
            <head><title>Müşteri Talepleri</title></head>
            <body style="font-family:sans-serif; padding:20px; background:#f4f4f9;">
                <h1>📋 Müşteri İletişim Talepleri</h1>
                <pre style="background:white; padding:20px; border-radius:10px; border:1px solid #ccc;">${content}</pre>
                <br><button onclick="location.reload()">Sayfayı Yenile</button>
            </body>
            </html>
        `);
    } else {
        res.send('<h1>Henüz kayıtlı müşteri talebi yok.</h1>');
    }
});

app.get('/widget', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send('Index.html bulunamadı');
});

// --- Yardımcı Fonksiyonlar ---
async function extractContactInfo(text) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Metinden İSİM ve TELEFON numarasını çıkar. JSON: { "name": "...", "phone": "..." }. Yoksa null.' }, { role: 'user', content: text }],
            response_format: { type: "json_object" }
        });
        return JSON.parse(response.choices[0].message.content);
    } catch (e) { return null; }
}

async function analyzeIntentAndProducts(userMessage) {
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Analiz et JSON döndür. 1. Ürün sorusu: { "intent": "SEARCH", "products": ["Ürün1"] }. 2. Sohbet: { "intent": "CHAT", "products": [] }.' }, { role: 'user', content: userMessage }],
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
                    allFoundProducts.push({ name: result.item, link: `https://www.nanokar.com.tr/kategori?ara=${encodeURIComponent(result.item)}` });
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

    if (userSessions[currentSessionId] && userSessions[currentSessionId].status === 'waiting_for_contact') {
        const contactData = await extractContactInfo(lastUserMessage);
        if (contactData && contactData.name && contactData.phone) {
            const requestedProduct = userSessions[currentSessionId].productRequest;
            const leadContent = `Tarih: ${new Date().toLocaleString('tr-TR')}\nİsim: ${contactData.name}\nTel: ${contactData.phone}\nAradığı Ürün: ${requestedProduct}\n--------------------------\n`;
            
            fs.appendFileSync(`leads/Musteri_Talepleri.txt`, leadContent);
            delete userSessions[currentSessionId];
            
            res.json({ success: true, message: `Bilgilerinizi aldım ${contactData.name}. Danışmanlarımız size dönüş yapacaktır.` });
            return;
        }
    }

    const analysis = await analyzeIntentAndProducts(lastUserMessage);
    let botMessage = "";

    if (analysis.intent === "SEARCH" && analysis.products.length > 0) {
        const foundProducts = await searchProducts(analysis.products);
        if (foundProducts.length > 0) {
            botMessage = `Evet, stoklarımızda şunlar mevcut:<br><br>`;
            foundProducts.forEach(p => { botMessage += `✅ <a href="${p.link}" target="_blank" style="color:#0056b3;font-weight:bold;">${p.name}</a><br>`; });
        } else {
            const missingProducts = analysis.products.join(", ");
            botMessage = `Web sitemizde <b>"${missingProducts}"</b> görünmüyor ama temin edebiliriz.<br>Size ulaşabilmemiz için lütfen <b>İsim, Soyisim ve Telefon</b> numaranızı yazar mısınız?`;
            userSessions[currentSessionId] = { status: 'waiting_for_contact', productRequest: missingProducts };
        }
    } else {
        const gpt = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'Sen Nanokar AI asistanısın. Nazik ve satıcı odaklı ol.' }, ...messages] });
        botMessage = gpt.choices[0].message.content;
    }
    res.json({ success: true, message: botMessage });
});

app.listen(port, () => { console.log(`Sunucu Çalışıyor: ${port}`); });