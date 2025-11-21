// server.js - Nanokar AI Chatbot (FİNAL - SES VE MAIL DÜZELTİLDİ)

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

// --- GOOGLE CLOUD AYARLARI (RENDER İÇİN DÜZELTİLDİ) ---
// Render'da 'GOOGLE_CREDENTIALS_JSON' environment variable'ı varsa onu dosyaya yaz
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('google-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'google-key.json';
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Google Cloud Ses Servisi Aktif");
} catch (e) { 
    console.error("❌ Google Cloud Hatası:", e.message); 
}

// Klasörler
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- BOT KİMLİĞİ (KESİN BİLGİLER) ---
const SYSTEM_PROMPT = `
Sen Nanokar Nanoteknoloji şirketinin satış asistanısın.
İletişim Bilgileri: 
- Telefon: +90 216 526 04 90
- E-posta: sales@nanokar.com
- Adres: Kurtköy, Pendik / İstanbul

KURALLAR:
1. İletişim sorulursa SADECE yukarıdaki bilgileri ver.
2. Ürün yoksa veya fiyat sorulursa: "Size özel fiyat çalışması için lütfen İsim, Soyisim ve Telefon numaranızı yazar mısınız?" de.
3. Müşteri numara verirse: "Bilgilerinizi aldım, satış temsilcimiz en kısa sürede size ulaşacaktır." de.
`;

// --- ÜRÜN LİSTESİ ---
let localProductList = [];
const productFilePath = path.join(__dirname, 'products.txt');
if (fs.existsSync(productFilePath)) {
    const data = fs.readFileSync(productFilePath, 'utf-8');
    localProductList = data.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}
const fuse = new Fuse(localProductList.map(name => ({ name })), { keys: ['name'], includeScore: true, threshold: 0.4 });

// --- MAIL FONKSİYONU (BİLGİLERİNİ GİR!) ---
async function sendLeadEmail(name, phone, message) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: 'molchemtechnologies@gmail.com', // 🔴 KENDİ MAİLİNİ YAZ
            pass: 'BURAYA_GMAIL_APP_SIFRESINI_YAZ' // 🔴 GMAIL UYGULAMA ŞİFRENİ YAZ
        }
    });

    const mailOptions = {
        from: 'Nanokar Bot',
        to: 'sales@nanokar.com', 
        subject: '🔔 Yeni Müşteri Talebi',
        text: `Müşteri: ${name}\nTelefon: ${phone}\nMesaj: ${message}\n\nTarih: ${new Date().toLocaleString('tr-TR')}`
    };

    try { await transporter.sendMail(mailOptions); console.log("📧 Mail gönderildi."); } 
    catch(e) { console.error("❌ Mail hatası:", e); }
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
            
            const result = JSON.parse(response.choices[0].message.content);
            const logEntry = `TARİH: ${new Date().toLocaleString('tr-TR')} | İSİM: ${result.name} | TEL: ${result.phone}\n`;
            
            fs.appendFileSync(path.join(__dirname, 'leads', 'Musteri_Talepleri.txt'), logEntry);
            
            // Mail Gönder
            sendLeadEmail(result.name, result.phone, text);

            return { saved: true, name: result.name };
        } catch (e) { console.error(e); }
    }
    return { saved: false };
}

// --- API ENDPOINTS ---

// Admin Paneli
app.get('/admin-leads', (req, res) => {
    const filePath = path.join(__dirname, 'leads', 'Musteri_Talepleri.txt');
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : 'Kayıt yok.';
    res.send(`<pre style="font-family:Arial; padding:20px;">${content}</pre>`);
});

// Chat
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;
    const userMsg = messages[messages.length - 1].content;

    const lead = await checkAndSaveLead(userMsg);
    if (lead.saved) return res.json({ success: true, message: `Teşekkürler ${lead.name}, bilgilerinizi aldım. Sizi arayacağız.` });

    const searchResult = fuse.search(userMsg);
    let context = "";
    if (searchResult.length > 0) {
        context = "Sitemizde bulunan ürünler:\n" + searchResult.slice(0, 3).map(r => {
            const name = r.item.name;
            const link = `https://www.nanokar.com.tr/kategori?ara=${encodeURIComponent(name)}`;
            return `- ${name} (Link: ${link})`;
        }).join("\n");
    }

    const gpt = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: SYSTEM_PROMPT + "\n\nÜRÜN BİLGİSİ:\n" + context },
            ...messages
        ]
    });

    let botMsg = gpt.choices[0].message.content;
    botMsg = botMsg.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:blue;">Ürüne Git</a>');

    res.json({ success: true, message: botMsg });
});

// Sesli Chat
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
        console.error(e);
        res.status(500).json({ error: 'Ses hatası' });
    } finally {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
