// server.js - FİNAL SÜRÜM (GitHub Entegrasyonlu)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const axios = require('axios'); // YENİ: Veri çekmek için
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

// --- GOOGLE CLOUD ANAHTARINI OLUŞTUR ---
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Ses servisi başlatıldı.");
} catch (e) { console.log("⚠️ Ses servisi hatası:", e.message); }

// Klasörler
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- BOT KİMLİĞİ ---
const SYSTEM_PROMPT = `
Sen Nanokar Nanoteknoloji şirketinin satış asistanısın.
İletişim: Tel: +90 216 526 04 90, Mail: sales@nanokar.com, Adres: Kurtköy, Pendik / İstanbul.

KURALLAR:
1. İletişim sorulursa bu bilgileri ver.
2. Stokta ürün varsa fiyat ve stok bilgisini paylaş.
3. Ürün yoksa: "Size özel temin edebiliriz, lütfen İsim ve Telefonunuzu yazın" de.
4. Müşteri numara verirse: "Bilgilerinizi aldım, sizi arayacağız" de.
`;

// --- GITHUB ÜRÜN ENTEGRASYONU (YENİ) ---
const PRODUCTS_URL = "https://raw.githubusercontent.com/molchemtechnologies-dotcom/nanokar-bot/main/products.json";
let globalProducts = [];

// GitHub'dan Ürünleri Çek
async function fetchProducts() {
    try {
        console.log("🌐 GitHub'dan ürün verileri çekiliyor...");
        const response = await axios.get(PRODUCTS_URL);
        if (response.data && response.data.products) {
            globalProducts = response.data.products;
            console.log(`✅ Başarılı! ${globalProducts.length} adet ürün yüklendi.`);
        }
    } catch (error) {
        console.error("❌ Veri çekme hatası:", error.message);
    }
}
// Başlangıçta çalıştır
fetchProducts();

// Ürün Arama Fonksiyonu
function findProduct(userMessage) {
    const message = userMessage.toLowerCase();
    
    if (globalProducts.length === 0) return [];

    return globalProducts.filter(product => {
        const nameMatch = product.name.toLowerCase().includes(message);
        // Keywords kontrolü (varsa)
        const keywordMatch = product.keywords ? product.keywords.some(k => message.includes(k)) : false;
        return nameMatch || keywordMatch;
    });
}

// --- MAİL GÖNDERME ---
async function sendLeadEmail(name, phone, message) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    try {
        await transporter.sendMail({
            from: 'Nanokar Bot',
            to: 'sales@nanokar.com',
            subject: '🔔 Yeni Müşteri Talebi',
            text: `İsim: ${name}\nTel: ${phone}\nMesaj: ${message}\n\nTarih: ${new Date().toLocaleString('tr-TR')}`
        });
        console.log("Mail gönderildi.");
    } catch(e) { console.error("Mail hatası:", e); }
}

// --- LEAD KAYIT ---
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
                `TARİH: ${new Date().toLocaleString('tr-TR')} | İSİM: ${res.name} | TEL: ${res.phone}\n`);
            
            sendLeadEmail(res.name, res.phone, text);
            return { saved: true, name: res.name };
        } catch (e) {}
    }
    return { saved: false };
}

// --- API ---

// Admin Paneli
app.get('/admin-leads', (req, res) => {
    const p = path.join(__dirname, 'leads', 'Musteri_Talepleri.txt');
    res.send(`<pre style="font-family:Arial; padding:20px;">${fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : 'Kayıt yok.'}</pre>`);
});

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;
    const msg = messages[messages.length - 1].content;

    // 1. Lead Kontrolü
    const lead = await checkAndSaveLead(msg);
    if (lead.saved) return res.json({ success: true, message: `Teşekkürler ${lead.name}, bilgilerinizi aldım. Sizi arayacağız.` });

    // 2. GitHub Ürün Arama
    const foundProducts = findProduct(msg);
    
    let context = "Aranan ürün veritabanımızda bulunamadı. Genel bilgi ver.";
    
    if (foundProducts.length > 0) {
        // Bulunan ürünleri GPT'ye bağlam (context) olarak veriyoruz
        const productDetails = foundProducts.map(p => 
            `ÜRÜN: ${p.name}\nFİYAT: ${p.price} ${p.currency}\nSTOK: ${p.stock_status}\nAÇIKLAMA: ${p.description}\nÖZELLİKLER: ${JSON.stringify(p.specs)}`
        ).join("\n---\n");
        
        context = `Kullanıcının sorduğu ürün veritabanında bulundu. Aşağıdaki bilgileri kullanarak cevap ver:\n${productDetails}`;
    }

    // 3. OpenAI Cevabı
    const gpt = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM_PROMPT + "\n\n" + context }, ...messages]
    });

    let reply = gpt.choices[0].message.content;
    
    // Link formatlaması (varsa)
    reply = reply.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:blue;">Ürüne Git</a>');

    res.json({ success: true, message: reply });
});

// Sesli Sohbet Endpoint
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Ses yok' });
    try {
        const audioBytes = await fs.promises.readFile(req.file.path);
        const [stt] = await speechClient.recognize({
            config: { languageCodes: ['tr-TR'], encoding: 'WEBM_OPUS' },
            audio: { content: audioBytes.toString('base64') }
        });
        const text = stt.results[0].alternatives[0].transcript;
        
        // Chat endpoint mantığının aynısını burada uyguluyoruz (basitleştirilmiş)
        const foundProducts = findProduct(text);
        let context = foundProducts.length > 0 ? 
            `Bulunan Ürün Bilgisi: ${foundProducts[0].name}, Fiyat: ${foundProducts[0].price} ${foundProducts[0].currency}` : 
            "Ürün bulunamadı.";

        const gpt = await openai.chat.completions.create({
             model: 'gpt-4o-mini',
             messages: [{ role: 'system', content: SYSTEM_PROMPT + " Kısa ve öz konuş. " + context }, { role: 'user', content: text }]
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