// server.js - FİNAL SÜRÜM (Manuel Yükleme İçin)

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Fuse = require('fuse.js');
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
// Render Environment'a eklediğin o uzun yazıyı burada dosyaya çeviriyoruz.
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
2. Ürün yoksa: "Size özel temin edebiliriz, lütfen İsim ve Telefonunuzu yazın" de.
3. Müşteri numara verirse: "Bilgilerinizi aldım, sizi arayacağız" de.
`;

// --- ÜRÜN YÜKLEME ---
let localProductList = [];
const productFilePath = path.join(__dirname, 'products.txt');
if (fs.existsSync(productFilePath)) {
    const data = fs.readFileSync(productFilePath, 'utf-8');
    localProductList = data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}
// Akıllı Arama
const fuse = new Fuse(localProductList.map(name => ({ name })), { keys: ['name'], threshold: 0.4 });

// --- MAİL GÖNDERME ---
async function sendLeadEmail(name, phone, message) {
    // Render'a girdiğin EMAIL_USER ve EMAIL_PASS'i kullanır.
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
            to: 'sales@nanokar.com', // Bildirimin gideceği adres
            subject: '🔔 Yeni Müşteri Talebi',
            text: `İsim: ${name}\nTel: ${phone}\nMesaj: ${message}\n\nTarih: ${new Date().toLocaleString('tr-TR')}`
        });
        console.log("Mail gönderildi.");
    } catch(e) { console.error("Mail hatası:", e); }
}

// --- LEAD KAYIT ---
async function checkAndSaveLead(text) {
    // Telefon numarası kontrolü (5xx...)
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
            
            // Dosyaya Yaz
            fs.appendFileSync(path.join(__dirname, 'leads', 'Musteri_Talepleri.txt'), 
                `TARİH: ${new Date().toLocaleString('tr-TR')} | İSİM: ${res.name} | TEL: ${res.phone}\n`);
            
            // Mail At
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

// Chat
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;
    const msg = messages[messages.length - 1].content;

    const lead = await checkAndSaveLead(msg);
    if (lead.saved) return res.json({ success: true, message: `Teşekkürler ${lead.name}, bilgilerinizi aldım. Sizi arayacağız.` });

    const result = fuse.search(msg);
    let context = result.length > 0 ? "Stoktaki Ürünler:\n" + result.slice(0, 3).map(r => 
        `- ${r.item.name} (Link: https://www.nanokar.com.tr/kategori?ara=${encodeURIComponent(r.item.name)})`).join("\n") 
        : "Ürün stokta yok.";

    const gpt = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM_PROMPT + "\n\n" + context }, ...messages]
    });

    let reply = gpt.choices[0].message.content;
    reply = reply.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:blue;">Ürüne Git</a>');

    res.json({ success: true, message: reply });
});

// Ses
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Ses yok' });
    try {
        const audioBytes = await fs.promises.readFile(req.file.path);
        const [stt] = await speechClient.recognize({
            config: { languageCodes: ['tr-TR'], encoding: 'WEBM_OPUS' },
            audio: { content: audioBytes.toString('base64') }
        });
        const text = stt.results[0].alternatives[0].transcript;
        
        const gpt = await openai.chat.completions.create({
             model: 'gpt-4o-mini',
             messages: [{ role: 'system', content: SYSTEM_PROMPT + " Kısa cevap ver." }, { role: 'user', content: text }]
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
