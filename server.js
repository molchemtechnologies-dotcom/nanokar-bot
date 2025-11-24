// server.js - FİNAL SÜRÜM (Google Sheets + GitHub Ürün + Lead Fix)

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

// YENİ: Google Sheets Kütüphaneleri
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
// Senin tablonun ID'si buraya eklendi:
const SPREADSHEET_ID = "1M44lWMSXavUcIacCSfNb-o55aWmaayx5BpLXuiyBEKs";

// --- GOOGLE CLOUD ANAHTAR YÖNETİMİ ---
let googleAuthJSON;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
    try {
        googleAuthJSON = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } catch (e) { console.error("JSON Parse hatası", e); }
} else if (fs.existsSync('nanokar-key.json')) {
     googleAuthJSON = JSON.parse(fs.readFileSync('nanokar-key.json'));
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Ses servisi başlatıldı.");
} catch (e) { console.log("⚠️ Ses servisi başlatılamadı."); }

// Klasör Kontrolü
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- SİSTEM PROMPTU ---
const SYSTEM_PROMPT = `
Sen Nanokar Nanoteknoloji şirketinin satış asistanısın.
İletişim: Tel: +90 216 526 04 90, Mail: sales@nanokar.com

KURALLAR:
1. Verilen ürün bilgisini kullanarak fiyat ve stok durumunu net söyle.
2. Eğer ürün veritabanında YOKSA veya müşteri ÖZEL BİR ŞEY isterse: "Size özel fiyat çalışması yapabilmemiz için lütfen İsim, Soyisim ve Telefon numaranızı yazar mısınız?" de.
3. Müşteri bilgilerini verirse: "Bilgilerinizi aldım [İsim], en kısa sürede dönüş yapacağız." de.
`;

// --- GITHUB ÜRÜN ENTEGRASYONU ---
const PRODUCTS_URL = "https://raw.githubusercontent.com/molchemtechnologies-dotcom/nanokar-bot/main/products.json";
let globalProducts = [];

async function fetchProducts() {
    try {
        const response = await axios.get(PRODUCTS_URL);
        let data = response.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch(e) {} }
        if (data && data.products) {
            globalProducts = data.products;
            console.log(`✅ ${globalProducts.length} ürün yüklendi.`);
            return true;
        }
    } catch (error) { console.error("Veri çekme hatası:", error.message); }
    return false;
}
fetchProducts();

function findProduct(userMessage) {
    const message = userMessage.toLowerCase();
    return globalProducts.filter(product => {
        const pName = product.name.toLowerCase();
        const nameMatch = message.includes(pName) || pName.includes(message);
        const keywordMatch = product.keywords ? product.keywords.some(k => message.includes(k.toLowerCase())) : false;
        return nameMatch || keywordMatch;
    });
}

// --- GOOGLE SHEETS KAYIT ---
async function saveToGoogleSheets(name, phone, message) {
    if (!googleAuthJSON || !SPREADSHEET_ID) {
        console.log("⚠️ Google Sheets ayarları eksik.");
        return;
    }

    try {
        // Yetkilendirme (JWT)
        const serviceAccountAuth = new JWT({
            email: googleAuthJSON.client_email,
            key: googleAuthJSON.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo(); // Tabloyu yükle

        const sheet = doc.sheetsByIndex[0]; // İlk sayfayı al (Sayfa1)
        
        // Satır ekle - Tablodaki başlıklarınla birebir aynı olmalı:
        // Tarih | İsim | Telefon | Mesaj
        await sheet.addRow({
            'Tarih': new Date().toLocaleString('tr-TR'),
            'İsim': name,
            'Telefon': phone,
            'Mesaj': message
        });
        console.log("✅ Google Sheet'e kayıt başarılı!");

    } catch (e) {
        console.error("❌ Google Sheets Hatası:", e);
    }
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
            subject: '🔔 Yeni Müşteri Talebi (Web)',
            text: `İsim: ${name}\nTel: ${phone}\nMesaj: ${message}`
        });
    } catch(e) {}
}

async function checkAndSaveLead(text) {
    // Telefon numarası yakalama regex'i
    if (text.match(/(\+90|0)?\s*5\d{2}/)) {
        try {
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Metinden İSİM ve TELEFONU JSON ver. Eğer isim yoksa "Belirtilmedi" yaz: {"name": "...", "phone": "..."}' },
                    { role: 'user', content: text }
                ],
                response_format: { type: "json_object" }
            });
            const res = JSON.parse(response.choices[0].message.content);
            
            // 1. Dosyaya Yaz (Yedek)
            fs.appendFileSync(path.join(__dirname, 'leads', 'Musteri_Talepleri.txt'), 
                `${new Date().toLocaleString()} | ${res.name} | ${res.phone}\n`);
            
            // 2. Google Sheet'e Yaz (YENİ)
            await saveToGoogleSheets(res.name, res.phone, text);

            // 3. Mail At
            sendLeadEmail(res.name, res.phone, text);
            
            return { saved: true, name: res.name };
        } catch (e) { console.log("Lead hatası", e); }
    }
    return { saved: false };
}

// --- API ROUTES ---
app.get('/debug-products', (req, res) => {
    res.json({ total_products: globalProducts.length, products: globalProducts });
});

app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const msg = messages[messages.length - 1].content;

        if (globalProducts.length === 0) await fetchProducts();

        // Lead Kontrolü
        const lead = await checkAndSaveLead(msg);
        if (lead.saved) return res.json({ success: true, message: `Bilgilerinizi aldım ${lead.name}. Satış temsilcimiz en kısa sürede size dönüş yapacaktır.` });

        // Ürün Arama
        const foundProducts = findProduct(msg);
        let context = "BAĞLAM: Aranan ürün veritabanında bulunamadı. Müşteriden iletişim bilgisi iste.";
        
        if (foundProducts.length > 0) {
            const productDetails = foundProducts.map(p => 
                `ÜRÜN: ${p.name}\nFİYAT: ${p.price} ${p.currency}\nSTOK: ${p.stock_status}\nAÇIKLAMA: ${p.description}`
            ).join("\n---\n");
            context = `BAĞLAM: Ürün bulundu. Fiyatı söyle:\n${productDetails}`;
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

// Sesli Sohbet
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Ses yok' });
    try {
        const audioBytes = await fs.promises.readFile(req.file.path);
        const [stt] = await speechClient.recognize({
            config: { languageCodes: ['tr-TR'], encoding: 'WEBM_OPUS' },
            audio: { content: audioBytes.toString('base64') }
        });
        const text = stt.results[0].alternatives[0].transcript;

        const lead = await checkAndSaveLead(text);
        if (lead.saved) {
             const reply = `Teşekkürler ${lead.name}, sizi arayacağız.`;
             const [tts] = await ttsClient.synthesizeSpeech({
                input: { text: reply },
                voice: { languageCode: 'tr-TR', ssmlGender: 'NEUTRAL' },
                audioConfig: { audioEncoding: 'MP3' },
            });
            return res.json({ success: true, message: reply, audioBase64: tts.audioContent.toString('base64') });
        }
        
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