// server.js - FİNAL SÜRÜM (Render Cold-Start Fix + Debug Modu)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios'); 
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- GOOGLE CLOUD ---
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Ses servisi başlatıldı.");
} catch (e) { console.log("⚠️ Ses servisi başlatılamadı (Sesli sohbet çalışmayabilir)."); }

// Klasör Kontrolü
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- SİSTEM PROMPTU ---
const SYSTEM_PROMPT = `
Sen Nanokar Nanoteknoloji şirketinin satış asistanısın.
İletişim: Tel: +90 216 526 04 90, Mail: sales@nanokar.com

KURALLAR:
1. Verilen ürün bilgisini kullanarak fiyat ve stok durumunu net söyle.
2. Eğer "BAĞLAM" kısmında ürün bilgisi varsa onu kullan.
3. Eğer ürün yoksa: "Şu an stoklarımızda görünmüyor ancak özel üretim için bilgilerinizi alabilirim." de.
4. Fiyat sorulduğunda sayısal değeri ve para birimini mutlaka söyle.
`;

// --- GITHUB ÜRÜN ENTEGRASYONU ---
const PRODUCTS_URL = "https://raw.githubusercontent.com/molchemtechnologies-dotcom/nanokar-bot/main/products.json";
let globalProducts = [];

// GitHub'dan Ürünleri Çek
async function fetchProducts() {
    try {
        console.log("🌐 GitHub'dan veri çekiliyor...");
        const response = await axios.get(PRODUCTS_URL);
        
        let data = response.data;
        // Eğer GitHub text/plain dönerse JSON'a çevirmeyi dene
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch(e) {}
        }

        if (data && data.products) {
            globalProducts = data.products;
            console.log(`✅ Başarılı! ${globalProducts.length} adet ürün yüklendi.`);
            return true;
        }
    } catch (error) {
        console.error("❌ Veri çekme hatası:", error.message);
    }
    return false;
}

// Sunucu başlarken çekmeyi dene
fetchProducts();

// Ürün Arama Fonksiyonu
function findProduct(userMessage) {
    const message = userMessage.toLowerCase(); // Örn: "grafen fiyatı ne kadar?"
    
    return globalProducts.filter(product => {
        const pName = product.name.toLowerCase();
        
        // 1. Ürün adı mesajın içinde geçiyor mu? (Örn: mesaj "nano gümüş fiyat" -> ürün "nano gümüş")
        const nameMatch = message.includes(pName) || pName.includes(message);

        // 2. Anahtar kelimelerden biri mesajda geçiyor mu?
        const keywordMatch = product.keywords ? product.keywords.some(k => message.includes(k.toLowerCase())) : false;
        
        return nameMatch || keywordMatch;
    });
}

// --- MAİL VE LEAD ---
async function sendLeadEmail(name, phone, message) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    try {
        await transporter.sendMail({
            from: 'Nanokar Bot',
            to: 'sales@nanokar.com',
            subject: '🔔 Yeni Müşteri Talebi',
            text: `İsim: ${name}\nTel: ${phone}\nMesaj: ${message}`
        });
    } catch(e) {}
}

async function checkAndSaveLead(text) {
    if (text.match(/(\+90|0)?\s*5\d{2}/)) {
        try {
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Metinden İSİM ve TELEFONU JSON ver: {"name": "...", "phone": "..."}' },
                    { role: 'user', content: text }
                ],
                response_format: { type: "json_object" }
            });
            const res = JSON.parse(response.choices[0].message.content);
            fs.appendFileSync(path.join(__dirname, 'leads', 'Musteri_Talepleri.txt'), 
                `${new Date().toLocaleString()} | ${res.name} | ${res.phone}\n`);
            sendLeadEmail(res.name, res.phone, text);
            return { saved: true, name: res.name };
        } catch (e) {}
    }
    return { saved: false };
}

// --- API ROUTES ---

// 1. Debug Route (Tarayıcıdan kontrol etmek için)
// Tarayıcıda: https://senin-app-url.onrender.com/debug-products
app.get('/debug-products', (req, res) => {
    res.json({
        total_products: globalProducts.length,
        products: globalProducts, // Tüm listeyi göster
        last_update: new Date().toLocaleString()
    });
});

// 2. Chat Route
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const msg = messages[messages.length - 1].content;

        // --- KRİTİK DÜZELTME: Liste boşsa bekle ve çek ---
        if (globalProducts.length === 0) {
            console.log("⚠️ Liste boş, istek sırasında veri çekiliyor...");
            await fetchProducts();
        }

        // Lead Kontrolü
        const lead = await checkAndSaveLead(msg);
        if (lead.saved) return res.json({ success: true, message: `Teşekkürler ${lead.name}, not aldım.` });

        // Ürün Arama
        const foundProducts = findProduct(msg);
        let context = "BAĞLAM: Aranan ürün veritabanında bulunamadı.";
        
        if (foundProducts.length > 0) {
            const productDetails = foundProducts.map(p => 
                `ÜRÜN: ${p.name}\nFİYAT: ${p.price} ${p.currency}\nSTOK: ${p.stock_status}\nAÇIKLAMA: ${p.description}`
            ).join("\n---\n");
            context = `BAĞLAM: Kullanıcının sorduğu ürün veritabanında bulundu. Fiyatı söyle:\n${productDetails}`;
            console.log("✅ Ürün eşleşti:", foundProducts[0].name);
        } else {
            console.log("❌ Ürün bulunamadı. Mesaj:", msg);
        }

        // GPT Cevabı
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

// Sesli Sohbet (Aynı mantık)
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Ses yok' });
    try {
        const audioBytes = await fs.promises.readFile(req.file.path);
        const [stt] = await speechClient.recognize({
            config: { languageCodes: ['tr-TR'], encoding: 'WEBM_OPUS' },
            audio: { content: audioBytes.toString('base64') }
        });
        const text = stt.results[0].alternatives[0].transcript;
        
        // Liste boşsa çek
        if (globalProducts.length === 0) await fetchProducts();

        const foundProducts = findProduct(text);
        let context = foundProducts.length > 0 ? 
            `Bulunan: ${foundProducts[0].name}, Fiyat: ${foundProducts[0].price} ${foundProducts[0].currency}` : 
            "Ürün bulunamadı.";

        const gpt = await openai.chat.completions.create({
             model: 'gpt-4o-mini',
             messages: [{ role: 'system', content: SYSTEM_PROMPT + " Kısa cevap ver. " + context }, { role: 'user', content: text }]
        });
        
        const reply = gpt.choices[0].message.content;
        const [tts] = await ttsClient.synthesizeSpeech({
            input: { text: reply },
            voice: { languageCode: 'tr-TR', ssmlGender: 'NEUTRAL' },
            audioConfig: { audioEncoding: 'MP3' },
        });
        res.json({ success: true, message: reply, audioBase64: tts.audioContent.toString('base64') });
    } catch (e) {
        res.status(500).json({ error: 'Ses hatası' });
    } finally {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));